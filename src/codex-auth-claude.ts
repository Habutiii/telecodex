import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface AuthStatus {
  authenticated: boolean;
  method: "api-key" | "cli" | "none" | "unknown";
  detail: string;
}

export interface AuthRetryOptions {
  attempts?: number;
  delayMs?: number;
}

const COMMAND_TIMEOUT_MS = 10_000;
const AUTH_CACHE_TTL_MS = 30_000;

function resolveClaudeBin(): string {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  const candidates = [
    path.join(homedir(), ".local/bin/claude"),
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "claude";
}

const CLAUDE_CLI = resolveClaudeBin();

let cachedAuthStatus: { status: AuthStatus; expiresAt: number } | undefined;

export async function checkAuthStatus(): Promise<AuthStatus> {
  if (cachedAuthStatus && Date.now() < cachedAuthStatus.expiresAt) {
    return cachedAuthStatus.status;
  }

  if (process.env.ANTHROPIC_API_KEY) {
    const status: AuthStatus = {
      authenticated: true,
      method: "api-key",
      detail: "Authenticated via ANTHROPIC_API_KEY",
    };
    cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    return status;
  }

  try {
    const { stdout } = await runClaudeCommand(["auth", "status", "--json"]);
    const status = parseStatusOutput(stdout);
    if (status.authenticated) {
      cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
    }
    return status;
  } catch (error) {
    return parseCommandError(error);
  }
}

export async function checkAuthStatusWithRetry(
  options: AuthRetryOptions = {},
): Promise<AuthStatus> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const delayMs = Math.max(0, options.delayMs ?? 1_000);

  let status = await checkAuthStatus();
  if (status.authenticated || attempts === 1) {
    return status;
  }

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    clearAuthCache();
    if (delayMs > 0) {
      await delay(delayMs);
    }
    status = await checkAuthStatus();
    if (status.authenticated) {
      return status;
    }
  }

  return status;
}

export function clearAuthCache(): void {
  cachedAuthStatus = undefined;
}

function parseStatusOutput(output: string): AuthStatus {
  const trimmed = output.trim();
  if (!trimmed) {
    return {
      authenticated: false,
      method: "unknown",
      detail: "Claude auth status returned no output.",
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      loggedIn?: boolean;
      authMethod?: string;
      email?: string;
      subscriptionType?: string;
      orgName?: string;
    };
    if (parsed.loggedIn) {
      const detailParts = [
        "Authenticated via Claude Code CLI",
        parsed.email,
        parsed.subscriptionType,
        parsed.orgName,
      ].filter((value): value is string => Boolean(value));
      return {
        authenticated: true,
        method: parsed.authMethod === "apiKey" ? "api-key" : "cli",
        detail: detailParts.join(" | "),
      };
    }
    return {
      authenticated: false,
      method: "none",
      detail: "Not authenticated",
    };
  } catch {
    return {
      authenticated: false,
      method: "unknown",
      detail: trimmed,
    };
  }
}

function runClaudeCommand(
  args: string[],
  timeout = COMMAND_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_CLI,
      args,
      {
        cwd: homedir(),
        timeout,
        env: { ...process.env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as Error & { stdout?: string; stderr?: string };
          enriched.stdout = typeof stdout === "string" ? stdout : "";
          enriched.stderr = typeof stderr === "string" ? stderr : "";
          reject(enriched);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  });
}

function parseCommandError(error: unknown): AuthStatus {
  const errno = (error as NodeJS.ErrnoException)?.code;
  if (errno === "ENOENT") {
    return {
      authenticated: false,
      method: "none",
      detail: "Claude CLI not found. Install it and run 'claude auth login'.",
    };
  }

  const detail = extractErrorMessage(error) || "Not authenticated";
  if (isDefinitiveUnauthenticatedDetail(detail)) {
    return {
      authenticated: false,
      method: "none",
      detail,
    };
  }

  return {
    authenticated: false,
    method: "unknown",
    detail,
  };
}

function isDefinitiveUnauthenticatedDetail(detail: string): boolean {
  return /not logged in|not authenticated|login required|unauthorized|authentication failed/i.test(detail);
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const enriched = error as { stderr?: string; stdout?: string; message?: string; signal?: string };
    const stderr = enriched.stderr?.trim();
    if (stderr) {
      return stderr;
    }
    const stdout = enriched.stdout?.trim();
    if (stdout) {
      return stdout;
    }
    if (enriched.signal) {
      return `Command terminated with signal ${enriched.signal}.`;
    }
    if (enriched.message) {
      return enriched.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
