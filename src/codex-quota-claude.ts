import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function claudeUserHome(): string {
  return process.env.CLAUDE_USER_HOME ?? homedir();
}

function resolveClaudeBin(): string | null {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  const candidates = [
    path.join(claudeUserHome(), ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const CLAUDE_BIN = resolveClaudeBin();

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
  resetsAtStr?: string;
}

export interface CodexCreditsSnapshot {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexRateLimitSnapshot {
  source: "claude";
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
  individualLimit: unknown;
  planType: string | null;
  rateLimitReachedType: string | null;
  // Claude Code-specific fields
  email: string | null;
  subscriptionType: string | null;
  todayInputTokens: number;
  todayCachedTokens: number;
  todayOutputTokens: number;
  rawOutput: string | null;
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
}

interface DailyUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

function getClaudeAuthStatus(): AuthStatus | null {
  if (!CLAUDE_BIN) return null;
  try {
    const output = execSync(`${CLAUDE_BIN} auth status --json`, {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, HOME: claudeUserHome() },
    });
    return JSON.parse(output) as AuthStatus;
  } catch {
    return null;
  }
}

function runClaudeUsage(): Promise<string> {
  if (!CLAUDE_BIN) {
    return Promise.reject(
      new Error(
        "Claude CLI not found. Set CLAUDE_CLI_PATH to its location or install it to ~/.local/bin/claude",
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ["-p", "/usage"], {
      env: { ...process.env, HOME: claudeUserHome() },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      fn();
    };

    const timeout = setTimeout(() => settle(() => reject(new Error("timeout"))), 15_000);

    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", (err) => settle(() => reject(err)));
    child.once("close", (code) => {
      if (output.length > 0) {
        settle(() => resolve(output));
      } else {
        settle(() => reject(new Error(`claude exited with code ${code ?? 1}`)));
      }
    });
  });
}

async function fetchRawUsage(): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runClaudeUsage();
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastError;
}

function getTodayUsage(): DailyUsage {
  const projectsDir = path.join(homedir(), ".claude", "projects");
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  const usage: DailyUsage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir)
      .map((entry) => path.join(projectsDir, entry))
      .filter((p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      });
  } catch {
    return usage;
  }

  for (const projectDir of projectDirs) {
    let files: string[];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);

      try {
        if (statSync(filePath).mtimeMs < todayStartMs) continue;
      } catch {
        continue;
      }

      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;

        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (obj.type !== "assistant") continue;

        const timestamp = obj.timestamp as string | undefined;
        if (timestamp && new Date(timestamp).getTime() < todayStartMs) continue;

        const msg = obj.message as Record<string, unknown> | undefined;
        const msgUsage = msg?.usage as Record<string, unknown> | undefined;
        if (!msgUsage) continue;

        usage.inputTokens += (msgUsage.input_tokens as number | undefined) ?? 0;
        usage.cachedTokens += (msgUsage.cache_read_input_tokens as number | undefined) ?? 0;
        usage.outputTokens += (msgUsage.output_tokens as number | undefined) ?? 0;
      }
    }
  }

  return usage;
}

export async function readCodexQuota(): Promise<CodexRateLimitSnapshot> {
  const [auth, todayUsage, rawOutput] = await Promise.all([
    Promise.resolve(getClaudeAuthStatus()),
    Promise.resolve(getTodayUsage()),
    fetchRawUsage(),
  ]);

  return {
    source: "claude",
    limitId: null,
    limitName: auth?.email ?? null,
    primary: null,
    secondary: null,
    credits: auth
      ? {
          hasCredits: false,
          unlimited: auth.subscriptionType === "pro" || auth.subscriptionType === "max",
          balance: auth.subscriptionType ?? null,
        }
      : null,
    individualLimit: null,
    planType: auth?.subscriptionType ?? null,
    rateLimitReachedType: null,
    email: auth?.email ?? null,
    subscriptionType: auth?.subscriptionType ?? null,
    todayInputTokens: todayUsage.inputTokens,
    todayCachedTokens: todayUsage.cachedTokens,
    todayOutputTokens: todayUsage.outputTokens,
    rawOutput,
  };
}

export function formatQuotaPlain(snapshot: CodexRateLimitSnapshot): string {
  return snapshot.rawOutput ?? "No usage data available";
}

export function formatQuotaHTML(
  snapshot: CodexRateLimitSnapshot,
  escape: (text: string) => string,
): string {
  return `<pre>${escape(snapshot.rawOutput ?? "No usage data available")}</pre>`;
}
