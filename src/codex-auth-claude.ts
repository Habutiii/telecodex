import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface AuthStatus {
  authenticated: boolean;
  method: "api-key" | "cli" | "none" | "unknown";
  detail: string;
}

export interface LoginResult {
  success: boolean;
  message: string;
}

export interface AuthRetryOptions {
  attempts?: number;
  delayMs?: number;
}

const AUTH_CACHE_TTL_MS = 30_000;

let cachedAuthStatus: { status: AuthStatus; expiresAt: number } | undefined;

/**
 * Check whether Claude Code is currently authenticated by inspecting ~/.claude/.
 * Results are cached for 30 seconds.
 */
export async function checkAuthStatus(): Promise<AuthStatus> {
  if (cachedAuthStatus && Date.now() < cachedAuthStatus.expiresAt) {
    return cachedAuthStatus.status;
  }

  const status = checkClaudeCliAuth();
  if (status.authenticated) {
    cachedAuthStatus = { status, expiresAt: Date.now() + AUTH_CACHE_TTL_MS };
  }
  return status;
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

/**
 * Login is not interactive via the bot. Instruct the user to set ANTHROPIC_API_KEY.
 */
export async function startLogin(): Promise<LoginResult> {
  clearAuthCache();
  return {
    success: false,
    message:
      "Run `claude` interactively on the host to complete OAuth login, " +
      "then restart the bot.",
  };
}

/**
 * Logout is not applicable when using API key auth.
 */
export async function startLogout(): Promise<LoginResult> {
  clearAuthCache();
  return {
    success: false,
    message:
      "Run `claude auth logout` on the host to sign out, then restart the bot.",
  };
}

function checkClaudeCliAuth(): AuthStatus {
  const claudeDir = path.join(homedir(), ".claude");
  if (!existsSync(claudeDir)) {
    return {
      authenticated: false,
      method: "none",
      detail: "No Claude Code credentials found. Run `claude` on the host to complete OAuth login.",
    };
  }

  // Claude Code stores OAuth state in ~/.claude/settings.json (not a credentials file).
  // Its presence indicates the user has completed OAuth login via the claude CLI.
  const settingsPath = path.join(claudeDir, "settings.json");
  if (existsSync(settingsPath)) {
    return {
      authenticated: true,
      method: "cli",
      detail: "Authenticated via Claude Code (~/.claude/)",
    };
  }

  return {
    authenticated: false,
    method: "none",
    detail: "No Claude Code credentials found. Set ANTHROPIC_API_KEY or run `claude` on the host.",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
