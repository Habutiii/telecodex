import type { AgentType } from "./agent-state.js";
import { getActiveAgent } from "./agent-state.js";
import type { CodexLaunchProfile } from "./codex-launch.js";
import { OpenAICodexSessionService } from "./codex-session-openai.js";
import { ClaudeCodexSessionService } from "./codex-session-claude.js";
import type { TeleCodexConfig } from "./config.js";

// Re-export shared types — session callbacks/info from the OpenAI impl, thread/model records from state
export type {
  CodexSessionCallbacks,
  CodexSessionInfo,
  CodexPromptInput,
  CreateOptions,
} from "./codex-session-openai.js";

export type { CodexThreadRecord, CodexModelRecord } from "./codex-state-openai.js";

export { listWorkspaceDirectories } from "./codex-session-openai.js";

import type { CreateOptions } from "./codex-session-openai.js";

// Unified interface satisfied by both backends
export interface CodexSessionService {
  getInfo(): import("./codex-session-openai.js").CodexSessionInfo;
  isProcessing(): boolean;
  hasActiveThread(): boolean;
  getCurrentWorkspace(): string;
  prompt(
    input: import("./codex-session-openai.js").CodexPromptInput,
    callbacks: import("./codex-session-openai.js").CodexSessionCallbacks,
  ): Promise<void>;
  abort(): Promise<boolean>;
  newThread(workspace?: string, model?: string): Promise<import("./codex-session-openai.js").CodexSessionInfo>;
  resumeThread(threadId: string): Promise<import("./codex-session-openai.js").CodexSessionInfo>;
  switchSession(threadId: string): Promise<import("./codex-session-openai.js").CodexSessionInfo>;
  listAllSessions(limit?: number): import("./codex-state-openai.js").CodexThreadRecord[];
  listWorkspaces(): string[];
  listModels(): import("./codex-state-openai.js").CodexModelRecord[];
  setModel(slug: string): string;
  setReasoningEffort(effort: string): void;
  setLaunchProfile(profileId: string): CodexLaunchProfile;
  getSelectedLaunchProfile(): CodexLaunchProfile;
  handback(): { threadId: string | null; workspace: string };
  dispose(): void;
}

export async function createSessionService(
  agentType: AgentType,
  config: TeleCodexConfig,
  options?: CreateOptions,
): Promise<CodexSessionService> {
  if (agentType === "claude") {
    return ClaudeCodexSessionService.create(config, options) as Promise<CodexSessionService>;
  }
  return OpenAICodexSessionService.create(config, options) as Promise<CodexSessionService>;
}

export { getActiveAgent };
