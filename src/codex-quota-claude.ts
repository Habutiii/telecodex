import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH ?? "claude";

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
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
  try {
    const output = execSync(`${CLAUDE_BIN} auth status --json`, {
      encoding: "utf8",
      timeout: 5000,
    });
    return JSON.parse(output) as AuthStatus;
  } catch {
    return null;
  }
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
  const auth = getClaudeAuthStatus();
  const todayUsage = getTodayUsage();

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
  };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatQuotaPlain(snapshot: CodexRateLimitSnapshot): string {
  const lines: string[] = ["Claude Code Usage"];

  if (snapshot.email) {
    lines.push(`Account: ${snapshot.email}`);
  }
  if (snapshot.subscriptionType) {
    const plan = snapshot.subscriptionType.charAt(0).toUpperCase() + snapshot.subscriptionType.slice(1);
    lines.push(`Plan: ${plan}`);
  }

  lines.push("");
  lines.push("Today's token usage:");
  lines.push(`  Input:  ${fmt(snapshot.todayInputTokens)}`);
  lines.push(`  Cached: ${fmt(snapshot.todayCachedTokens)}`);
  lines.push(`  Output: ${fmt(snapshot.todayOutputTokens)}`);

  return lines.join("\n");
}

export function formatQuotaHTML(
  snapshot: CodexRateLimitSnapshot,
  escape: (text: string) => string,
): string {
  const lines: string[] = ["<b>Claude Code Usage</b>"];

  if (snapshot.email) {
    lines.push(`Account: ${escape(snapshot.email)}`);
  }
  if (snapshot.subscriptionType) {
    const plan = snapshot.subscriptionType.charAt(0).toUpperCase() + snapshot.subscriptionType.slice(1);
    lines.push(`Plan: <b>${escape(plan)}</b>`);
  }

  lines.push("");
  lines.push("<b>Today's token usage</b>");
  lines.push(`Input:  <code>${fmt(snapshot.todayInputTokens)}</code>`);
  lines.push(`Cached: <code>${fmt(snapshot.todayCachedTokens)}</code>`);
  lines.push(`Output: <code>${fmt(snapshot.todayOutputTokens)}</code>`);

  return lines.join("\n");
}
