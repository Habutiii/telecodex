import { spawn } from "node:child_process";
import readline from "node:readline";

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
  source: "codex";
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexCreditsSnapshot | null;
  individualLimit: unknown;
  planType: string | null;
  rateLimitReachedType: string | null;
}

type ApiRateLimitSnapshot = Omit<CodexRateLimitSnapshot, "source">;

interface JsonRpcMessage {
  id?: number;
  result?: {
    rateLimits?: ApiRateLimitSnapshot;
    rateLimitsByLimitId?: Record<string, ApiRateLimitSnapshot | undefined> | null;
  };
  error?: {
    message?: string;
  };
}

const APP_SERVER_TIMEOUT_MS = 15000;

export async function readCodexQuota(): Promise<CodexRateLimitSnapshot> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const rl = readline.createInterface({ input: child.stdout });
    let settled = false;
    const timeout = setTimeout(() => {
      settle(() => reject(new Error("Timed out reading Codex quota.")));
    }, APP_SERVER_TIMEOUT_MS);

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      rl.close();
      child.kill("SIGTERM");
      fn();
    };

    child.once("error", (error) => {
      settle(() => reject(error));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.once("exit", (code, signal) => {
      if (!settled && code !== 0) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        settle(() => reject(new Error(`Codex app-server exited with ${detail}${stderr ? `: ${stderr}` : ""}`)));
      }
    });

    rl.on("line", (line) => {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }

      if (message.id === 1) {
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        child.stdin.write(`${JSON.stringify({ method: "account/rateLimits/read", id: 2 })}\n`);
        return;
      }

      if (message.id === 2) {
        if (message.error) {
          settle(() => reject(new Error(message.error?.message || "Failed to read Codex quota.")));
          return;
        }

        const snapshot = message.result?.rateLimitsByLimitId?.codex ?? message.result?.rateLimits;
        if (!snapshot) {
          settle(() => reject(new Error("Codex quota response did not include rate limits.")));
          return;
        }

        settle(() => resolve({ source: "codex", ...snapshot }));
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "telecodex",
            title: "TeleCodex",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
      })}\n`,
    );
  });
}

export function formatQuotaPlain(snapshot: CodexRateLimitSnapshot): string {
  return formatQuota(snapshot, false);
}

export function formatQuotaHTML(snapshot: CodexRateLimitSnapshot, escape: (text: string) => string): string {
  const lines = formatQuotaLines(snapshot);
  const [title, ...details] = lines;
  return [`<b>${escape(title)}</b>`, ...details.map(escape)].join("\n");
}

function formatQuota(snapshot: CodexRateLimitSnapshot, html: boolean): string {
  return formatQuotaLines(snapshot)
    .map((line, index) => (html && index === 0 ? `<b>${line}</b>` : line))
    .join("\n");
}

function formatQuotaLines(snapshot: CodexRateLimitSnapshot): string[] {
  const title = ["Codex quota", snapshot.planType ? `(${snapshot.planType})` : undefined].filter(Boolean).join(" ");
  const lines = [title];

  const windows = [
    ["Primary", snapshot.primary],
    ["Secondary", snapshot.secondary],
  ] as const;

  for (const [label, window] of windows) {
    if (!window) {
      continue;
    }

    lines.push(`${label}: ${formatWindow(window)}`);
  }

  if (snapshot.credits) {
    lines.push(`Credits: ${formatCredits(snapshot.credits)}`);
  }
  if (snapshot.rateLimitReachedType) {
    lines.push(`Limit reached: ${snapshot.rateLimitReachedType}`);
  }

  return lines;
}

function formatWindow(window: CodexRateLimitWindow): string {
  const used = Math.round(window.usedPercent);
  const left = Math.max(0, 100 - used);
  const duration = formatWindowDuration(window.windowDurationMins);
  const reset = formatReset(window.resetsAt);
  return [`${used}% used`, `${left}% left`, duration, reset].filter(Boolean).join(" · ");
}

function formatWindowDuration(minutes: number | null): string | undefined {
  if (!minutes) {
    return undefined;
  }
  if (minutes % (60 * 24) === 0) {
    return `${minutes / (60 * 24)}d window`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h window`;
  }
  return `${minutes}m window`;
}

function formatReset(resetsAt: number | null): string | undefined {
  if (!resetsAt) {
    return undefined;
  }

  const seconds = Math.max(0, Math.round(resetsAt - Date.now() / 1000));
  if (seconds < 60) {
    return "resets in <1m";
  }

  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `resets in ${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `resets in ${hours}h ${minutes % 60}m`;
  }
  return `resets in ${minutes}m`;
}

function formatCredits(credits: CodexCreditsSnapshot): string {
  if (credits.unlimited) {
    return "unlimited";
  }
  if (credits.balance !== null) {
    return credits.hasCredits ? credits.balance : `${credits.balance} available`;
  }
  return credits.hasCredits ? "available" : "none";
}
