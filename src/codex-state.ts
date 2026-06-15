import { getActiveAgent } from "./agent-state.js";
import * as openaiState from "./codex-state-openai.js";
import * as claudeState from "./codex-state-claude.js";

export type { CodexThreadRecord, CodexModelRecord } from "./codex-state-openai.js";

export function findLatestDatabase(): string | null {
  return getActiveAgent() === "claude"
    ? claudeState.findLatestDatabase()
    : openaiState.findLatestDatabase();
}

export function listThreads(limit = 20): openaiState.CodexThreadRecord[] {
  return getActiveAgent() === "claude"
    ? claudeState.listThreads(limit)
    : openaiState.listThreads(limit);
}

export function getThread(id: string): openaiState.CodexThreadRecord | null {
  return getActiveAgent() === "claude"
    ? claudeState.getThread(id)
    : openaiState.getThread(id);
}

export function listModels(): openaiState.CodexModelRecord[] {
  return getActiveAgent() === "claude"
    ? claudeState.listModels()
    : openaiState.listModels();
}
