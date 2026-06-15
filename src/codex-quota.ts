import { getActiveAgent } from "./agent-state.js";
import * as openaiQuota from "./codex-quota-openai.js";
import * as claudeQuota from "./codex-quota-claude.js";

export type { CodexRateLimitWindow, CodexCreditsSnapshot } from "./codex-quota-claude.js";

// Union type covering snapshots from either backend.
export type CodexRateLimitSnapshot =
  | openaiQuota.CodexRateLimitSnapshot
  | claudeQuota.CodexRateLimitSnapshot;

export async function readCodexQuota(): Promise<CodexRateLimitSnapshot> {
  if (getActiveAgent() === "claude") {
    return claudeQuota.readCodexQuota();
  }
  return openaiQuota.readCodexQuota();
}

export function formatQuotaPlain(snapshot: CodexRateLimitSnapshot): string {
  if (snapshot.source === "claude") {
    return claudeQuota.formatQuotaPlain(snapshot);
  }
  return openaiQuota.formatQuotaPlain(snapshot);
}

export function formatQuotaHTML(
  snapshot: CodexRateLimitSnapshot,
  escape: (text: string) => string,
): string {
  if (snapshot.source === "claude") {
    return claudeQuota.formatQuotaHTML(snapshot, escape);
  }
  return openaiQuota.formatQuotaHTML(snapshot, escape);
}
