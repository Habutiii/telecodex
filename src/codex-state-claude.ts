import {
  listAllClaudeSessionsSync,
  findClaudeSessionSync,
  CLAUDE_MODELS,
} from "./codex-session-claude.js";

export type { CodexThreadRecord, CodexModelRecord } from "./codex-session-claude.js";

export function findLatestDatabase(): string | null {
  return null;
}

export function listThreads(limit = 20): import("./codex-session.js").CodexThreadRecord[] {
  try {
    return listAllClaudeSessionsSync(undefined).slice(0, limit);
  } catch {
    return [];
  }
}

export function getThread(id: string): import("./codex-session.js").CodexThreadRecord | null {
  return findClaudeSessionSync(id);
}

export function listModels(): import("./codex-session.js").CodexModelRecord[] {
  return CLAUDE_MODELS;
}
