import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AgentType = "codex" | "claude";

const DISPLAY_NAMES: Record<AgentType, string> = {
  codex: "Codex",
  claude: "Claude Code",
};

export function agentDisplayName(agent: AgentType): string {
  return DISPLAY_NAMES[agent];
}

let persistPath: string | null = null;
let activeAgent: AgentType = "codex";

export function initAgentState(workspacePath: string): void {
  persistPath = path.join(workspacePath, ".telecodex", "agent.json");
  try {
    if (existsSync(persistPath)) {
      const raw = readFileSync(persistPath, "utf8");
      const data = JSON.parse(raw) as { activeAgent?: string };
      if (data.activeAgent === "codex" || data.activeAgent === "claude") {
        activeAgent = data.activeAgent;
      }
    }
  } catch {
    // ignore — fall back to default
  }
}

export function getActiveAgent(): AgentType {
  return activeAgent;
}

export function setActiveAgent(agent: AgentType): void {
  activeAgent = agent;
  if (!persistPath) return;
  try {
    const dir = path.dirname(persistPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(persistPath, JSON.stringify({ activeAgent: agent }, null, 2), "utf8");
  } catch (error) {
    console.warn("Failed to persist agent state:", error instanceof Error ? error.message : String(error));
  }
}
