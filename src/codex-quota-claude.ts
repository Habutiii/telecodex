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
  rawError: string | null;
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
      env: process.env as Record<string, string>,
    });
    return JSON.parse(output) as AuthStatus;
  } catch {
    return null;
  }
}

// Matches the CLI execution summary that claude always appends to stdout,
// e.g. "Total cost: $0.0000\nTotal duration (API): 0s\n...". When this is the
// only stdout content there was no real model response — treat it as a failure.
const CLI_SUMMARY_ONLY_RE = /^(?:\s*(?:Total cost:|Total duration|Total code changes:|Usage:)[^\n]*\n?)+\s*$/;

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
      env: process.env as Record<string, string>,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      fn();
    };

    const timeout = setTimeout(() => settle(() => reject(new Error("timeout"))), 15_000);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (err) => settle(() => reject(err)));
    child.once("close", (code) => {
      const hasRealContent = stdout.length > 0 && !CLI_SUMMARY_ONLY_RE.test(stdout);
      if (hasRealContent) {
        settle(() => resolve(stdout));
      } else {
        const stderrMsg = stderr.trim();
        const detail = stderrMsg
          ? stderrMsg
          : `claude -p /usage produced no usage data (exit code ${code ?? 1}). Check authentication with: claude auth status`;
        settle(() => reject(new Error(detail)));
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
  const projectsDir = path.join(claudeUserHome(), ".claude", "projects");
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

function isSubscriptionAuth(auth: AuthStatus | null): boolean {
  return auth?.authMethod === "claude.ai";
}

export async function readCodexQuota(): Promise<CodexRateLimitSnapshot> {
  const [auth, todayUsage] = await Promise.all([
    Promise.resolve(getClaudeAuthStatus()),
    Promise.resolve(getTodayUsage()),
  ]);

  let rawOutput: string | null = null;
  let rawError: string | null = null;

  if (!isSubscriptionAuth(auth)) {
    const method = auth?.authMethod ?? "unknown";
    rawError = `claude /usage requires Claude.ai subscription auth (current: ${method}). Token counts below are from local session logs.`;
  } else {
    try {
      rawOutput = await fetchRawUsage();
    } catch (err) {
      rawError = err instanceof Error ? err.message : String(err);
    }
  }

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
    rawError,
  };
}

function formatTokenCounts(snapshot: CodexRateLimitSnapshot): string {
  return `Today (local logs): ${snapshot.todayInputTokens} input, ${snapshot.todayOutputTokens} output, ${snapshot.todayCachedTokens} cache read`;
}

export function formatQuotaPlain(snapshot: CodexRateLimitSnapshot): string {
  if (snapshot.rawOutput) return snapshot.rawOutput;
  const lines: string[] = [];
  if (snapshot.rawError) lines.push(`Note: ${snapshot.rawError}`);
  lines.push(formatTokenCounts(snapshot));
  return lines.join("\n");
}

export function formatQuotaHTML(
  snapshot: CodexRateLimitSnapshot,
  escape: (text: string) => string,
): string {
  if (snapshot.rawOutput) return `<pre>${escape(snapshot.rawOutput)}</pre>`;
  const lines: string[] = [];
  if (snapshot.rawError) lines.push(`<i>${escape(snapshot.rawError)}</i>`);
  lines.push(escape(formatTokenCounts(snapshot)));
  return lines.join("\n");
}
