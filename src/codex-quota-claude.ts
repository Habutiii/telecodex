import { execSync } from "node:child_process";
import https from "node:https";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function resolveClaudeBin(): string {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  const candidates = [
    path.join(homedir(), ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "claude";
}

const CLAUDE_BIN = resolveClaudeBin();

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

interface ApiAuth {
  type: "bearer" | "apikey";
  value: string;
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

function getApiAuth(): ApiAuth | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { type: "apikey", value: process.env.ANTHROPIC_API_KEY };
  }
  try {
    const credsPath = path.join(homedir(), ".claude", ".credentials.json");
    const creds = JSON.parse(readFileSync(credsPath, "utf8")) as Record<string, unknown>;
    const oauth = creds["claudeAiOauth"] as Record<string, unknown> | undefined;
    const token = oauth?.["accessToken"] as string | undefined;
    if (token) return { type: "bearer", value: token };
  } catch {
    // fall through
  }
  return null;
}

interface OauthUsageWindow {
  utilization: number;
  resets_at: string | null;
}

interface OauthUsageResponse {
  five_hour?: OauthUsageWindow | null;
  seven_day?: OauthUsageWindow | null;
}

function fetchOauthUsage(bearerToken: string): Promise<OauthUsageResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/api/oauth/usage",
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => {
          try { resolve(JSON.parse(body) as OauthUsageResponse); }
          catch { reject(new Error("invalid JSON")); }
        });
      },
    );
    req.setTimeout(10_000, () => reject(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function oauthWindowToRateLimit(
  w: OauthUsageWindow | null | undefined,
  durationMins: number,
): CodexRateLimitWindow | null {
  if (!w) return null;
  return {
    usedPercent: Math.round(w.utilization * 10) / 10,
    windowDurationMins: durationMins,
    resetsAt: w.resets_at ? new Date(w.resets_at).getTime() / 1000 : null,
  };
}

async function readRateLimitWindows(): Promise<{ primary: CodexRateLimitWindow | null; secondary: CodexRateLimitWindow | null }> {
  const auth = getApiAuth();
  if (!auth || auth.type !== "bearer") return { primary: null, secondary: null };

  let usage: OauthUsageResponse | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      usage = await fetchOauthUsage(auth.value);
      break;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!usage) return { primary: null, secondary: null };

  return {
    primary: oauthWindowToRateLimit(usage.five_hour, 300),
    secondary: oauthWindowToRateLimit(usage.seven_day, 10080),
  };
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
  const [auth, todayUsage, windows] = await Promise.all([
    Promise.resolve(getClaudeAuthStatus()),
    Promise.resolve(getTodayUsage()),
    readRateLimitWindows(),
  ]);

  return {
    source: "claude",
    limitId: null,
    limitName: auth?.email ?? null,
    primary: windows.primary,
    secondary: windows.secondary,
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

function formatWindow(window: CodexRateLimitWindow): string {
  const used = Math.round(window.usedPercent);
  const left = Math.max(0, 100 - used);
  const duration = formatWindowDuration(window.windowDurationMins);
  const reset = formatReset(window.resetsAt);
  return [`${used}% used`, `${left}% left`, duration, reset].filter(Boolean).join(" · ");
}

function formatWindowDuration(minutes: number | null): string | undefined {
  if (!minutes) return undefined;
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

function formatReset(resetsAt: number | null): string | undefined {
  if (!resetsAt) return undefined;
  const seconds = Math.max(0, Math.round(resetsAt - Date.now() / 1000));
  if (seconds < 60) return "resets in <1m";
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `resets in ${days}d ${hours % 24}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${minutes}m`;
}

function formatQuotaLines(snapshot: CodexRateLimitSnapshot): string[] {
  const plan = snapshot.planType
    ? snapshot.planType.charAt(0).toUpperCase() + snapshot.planType.slice(1)
    : null;
  const title = ["Claude Code", plan ? `(${plan})` : undefined].filter(Boolean).join(" ");
  const lines = [title];

  if (snapshot.email) {
    lines.push(`Account: ${snapshot.email}`);
  }

  const windows = [
    ["Primary", snapshot.primary],
    ["Secondary", snapshot.secondary],
  ] as const;

  let hasWindows = false;
  for (const [label, window] of windows) {
    if (!window) continue;
    hasWindows = true;
    lines.push(`${label}: ${formatWindow(window)}`);
  }

  if (!hasWindows) {
    lines.push("");
    lines.push("Today's token usage:");
    lines.push(`  Input:  ${fmt(snapshot.todayInputTokens)}`);
    lines.push(`  Cached: ${fmt(snapshot.todayCachedTokens)}`);
    lines.push(`  Output: ${fmt(snapshot.todayOutputTokens)}`);
  }

  return lines;
}

export function formatQuotaPlain(snapshot: CodexRateLimitSnapshot): string {
  return formatQuotaLines(snapshot).join("\n");
}

export function formatQuotaHTML(
  snapshot: CodexRateLimitSnapshot,
  escape: (text: string) => string,
): string {
  const lines = formatQuotaLines(snapshot);
  const [title, ...details] = lines;
  return [`<b>${escape(title)}</b>`, ...details.map(escape)].join("\n");
}
