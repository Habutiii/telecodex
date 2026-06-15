import type { AgentType } from "./agent-state.js";
import { getActiveAgent } from "./agent-state.js";
import * as openaiAuth from "./codex-auth-openai.js";
import * as claudeAuth from "./codex-auth-claude.js";

export type { AuthStatus, LoginResult, AuthRetryOptions } from "./codex-auth-openai.js";

export async function checkAuthStatus(): Promise<openaiAuth.AuthStatus> {
  return getActiveAgent() === "claude"
    ? claudeAuth.checkAuthStatus()
    : openaiAuth.checkAuthStatus();
}

export async function checkAuthStatusWithRetry(
  options?: openaiAuth.AuthRetryOptions,
): Promise<openaiAuth.AuthStatus> {
  return getActiveAgent() === "claude"
    ? claudeAuth.checkAuthStatusWithRetry(options)
    : openaiAuth.checkAuthStatusWithRetry(options);
}

export function clearAuthCache(): void {
  openaiAuth.clearAuthCache();
  claudeAuth.clearAuthCache();
}

export async function startLogin(): Promise<openaiAuth.LoginResult> {
  return getActiveAgent() === "claude" ? claudeAuth.startLogin() : openaiAuth.startLogin();
}

export async function startLogout(): Promise<openaiAuth.LoginResult> {
  return getActiveAgent() === "claude" ? claudeAuth.startLogout() : openaiAuth.startLogout();
}

// Check auth for a specific agent, regardless of the active agent.
// Used by /switch_agent to probe availability before showing options.
export async function checkAuthForAgent(agent: AgentType): Promise<openaiAuth.AuthStatus> {
  return agent === "claude"
    ? claudeAuth.checkAuthStatus()
    : openaiAuth.checkAuthStatus();
}
