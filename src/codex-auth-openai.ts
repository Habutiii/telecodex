import { execFile } from "node:child_process";
import { homedir } from "node:os";

export interface AuthStatus {
  authenticated: boolean;
  method: "api-key" | "cli" | "none" | "unknown";
  detail: string;
}

export interface AuthRetryOptions {
  attempts?: number;
  delayMs?: number;
}

const CODEX_CLI = "codex";
const COMMAND_TIMEOUT_MS = 10_000;
const AUTH_CACHE_TTL_MS = 30_000;

let cachedAuthStatus: { status: AuthStatus; expiresAt: number } | undefined;

/**
 * Check whether Codex is currently authenticated by shelling out to `codex login status`.
 * Results are cached for 30 seconds to avoid per-message CLI invocations.
 */
export async function checkAuthStatus(): Promise<AuthStatus> {
  if (cachedAuthStatus && Date.now() < cachedAuthStatus.expiresAt) {
    return cachedAuthStatus.status;
  }

  try {
    const { stdout } = await runCodexCommand(["login", "status"]);
    const output = stdout.trim();
    const status: AuthStatus = {
      authenticated: true,
      method: "cli",
      detail: output || "Authenticated via Codex CLI",
    };
    cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
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

/**
 * Clear the cached auth status so the next check hits the CLI.
 */
export function clearAuthCache(): void {
  cachedAuthStatus = undefined;
}

function runCodexCommand(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      CODEX_CLI,
      args,
      {
        cwd: homedir(),
        timeout: COMMAND_TIMEOUT_MS,
        env: { ...process.env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          // Attach stdout/stderr to the error for richer diagnostics
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
      detail: "Codex CLI not found. Install it and run 'codex login'.",
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
  return /not logged in|unauthorized|authentication failed|invalid.*api.?key|no session/i.test(detail);
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
