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

function fetchRateLimitHeaders(auth: ApiAuth): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });

    const authHeader =
      auth.type === "bearer"
        ? { Authorization: `Bearer ${auth.value}` }
        : { "x-api-key": auth.value };

    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          ...authHeader,
        },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
        }
        res.resume();
        resolve(headers);
      },
    );

    req.setTimeout(10_000, () => reject(new Error("timeout")));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function readRateLimitWindows(): Promise<{ primary: CodexRateLimitWindow | null; secondary: CodexRateLimitWindow | null }> {
  const auth = getApiAuth();
  if (!auth) return { primary: null, secondary: null };

  let headers: Record<string, string>;
  try {
    headers = await fetchRateLimitHeaders(auth);
  } catch {
    return { primary: null, secondary: null };
  }

  const parse5hUtil = parseFloat(headers["anthropic-ratelimit-unified-5h-utilization"] ?? "");
  const parse5hReset = parseInt(headers["anthropic-ratelimit-unified-5h-reset"] ?? "");
  const parse7dUtil = parseFloat(headers["anthropic-ratelimit-unified-7d-utilization"] ?? "");
  const parse7dReset = parseInt(headers["anthropic-ratelimit-unified-7d-reset"] ?? "");

  return {
    primary: isNaN(parse5hUtil) ? null : {
      usedPercent: Math.round(parse5hUtil * 100 * 10) / 10,
      windowDurationMins: 300,
      resetsAt: isNaN(parse5hReset) ? null : parse5hReset,
    },
    secondary: isNaN(parse7dUtil) ? null : {
      usedPercent: Math.round(parse7dUtil * 100 * 10) / 10,
      windowDurationMins: 10080,
      resetsAt: isNaN(parse7dReset) ? null : parse7dReset,
    },
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
