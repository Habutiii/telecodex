import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

import type { TeleCodexConfig } from "./config.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  type CodexLaunchProfile,
} from "./codex-launch.js";

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH ?? "claude";

// ---------------------------------------------------------------------------
// Public types (preserved interface from the original codex-session.ts)
// ---------------------------------------------------------------------------

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}

export interface CodexModelRecord {
  slug: string;
  displayName: string;
}

export interface CodexSessionCallbacks {
  onTextDelta: (delta: string) => void;
  onToolStart: (toolName: string, toolCallId: string) => void;
  onToolUpdate: (toolCallId: string, partialResult: string) => void;
  onToolEnd: (toolCallId: string, isError: boolean) => void;
  onAgentEnd: () => void;
  onTodoUpdate?: (items: Array<{ text: string; completed: boolean }>) => void;
  onTurnComplete?: (usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }) => void;
}

export interface CodexSessionInfo {
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId: string;
  launchProfileLabel: string;
  launchProfileBehavior: string;
  sandboxMode: string;
  approvalPolicy: string;
  unsafeLaunch: boolean;
  nextLaunchProfileId?: string;
  nextLaunchProfileLabel?: string;
  nextLaunchProfileBehavior?: string;
  nextUnsafeLaunch?: boolean;
  sessionTokens?: {
    input: number;
    cached: number;
    output: number;
  };
}

export interface CreateOptions {
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  deferThreadStart?: boolean;
  resumeThreadId?: string;
}

export type CodexPromptInput =
  | string
  | { text?: string; imagePaths?: string[]; stagedFileInstructions?: string };

// ---------------------------------------------------------------------------
// Claude Code stream-json event types
// ---------------------------------------------------------------------------

interface ClaudeSystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd: string;
  model: string;
  tools?: string[];
  permissionMode?: string;
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

interface ClaudeAssistantEvent {
  type: "assistant";
  message: {
    id?: string;
    role: "assistant";
    content: ContentBlock[];
    model?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  session_id: string;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

interface ClaudeUserEvent {
  type: "user";
  message: {
    role: "user";
    content: ToolResultBlock[];
  };
  session_id: string;
}

interface ClaudeResultEvent {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns";
  result?: string;
  session_id: string;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  error?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

type ClaudeEvent =
  | ClaudeSystemInitEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export const CLAUDE_MODELS: CodexModelRecord[] = [
  { slug: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
  { slug: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  { slug: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
  { slug: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
];

// ---------------------------------------------------------------------------
// Session service
// ---------------------------------------------------------------------------

export class ClaudeCodexSessionService {
  private sessionId: string | null = null;
  private currentWorkspace: string;
  private currentModel: string | undefined;
  private currentReasoningEffort: string | undefined;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private activeProcess: ReturnType<typeof spawn> | null = null;
  private sessionTokens = { input: 0, cached: 0, output: 0 };

  private constructor(private readonly config: TeleCodexConfig) {
    this.currentWorkspace = config.workspace;
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
  }

  static async create(
    config: TeleCodexConfig,
    options?: CreateOptions,
  ): Promise<ClaudeCodexSessionService> {
    const service = new ClaudeCodexSessionService(config);
    service.currentWorkspace = resolveLaunchWorkspace(
      options?.workspace ?? config.workspace,
      config.workspace,
      config.workspaceRoot,
    );
    service.currentModel = options?.model ?? config.claudeModel;
    service.currentReasoningEffort = options?.reasoningEffort;
    service.currentLaunchProfile = getLaunchProfile(
      config,
      options?.launchProfileId ?? config.defaultLaunchProfileId,
    );

    if (options?.resumeThreadId) {
      service.sessionId = options.resumeThreadId;
      service.activeThreadLaunchProfile = service.currentLaunchProfile;
      return service;
    }

    // For Claude Code, sessions are created lazily on first prompt.
    service.activeThreadLaunchProfile = options?.deferThreadStart ? null : service.currentLaunchProfile;
    return service;
  }

  getInfo(): CodexSessionInfo {
    const effectiveLaunchProfile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    const info: CodexSessionInfo = {
      threadId: this.sessionId,
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.claudeModel,
      launchProfileId: effectiveLaunchProfile.id,
      launchProfileLabel: effectiveLaunchProfile.label,
      launchProfileBehavior: formatLaunchProfileBehavior(effectiveLaunchProfile),
      sandboxMode: effectiveLaunchProfile.sandboxMode,
      approvalPolicy: effectiveLaunchProfile.approvalPolicy,
      unsafeLaunch: effectiveLaunchProfile.unsafe,
    };

    if (this.currentReasoningEffort) {
      info.reasoningEffort = this.currentReasoningEffort;
    }

    if (
      this.activeThreadLaunchProfile &&
      this.activeThreadLaunchProfile.id !== this.currentLaunchProfile.id
    ) {
      info.nextLaunchProfileId = this.currentLaunchProfile.id;
      info.nextLaunchProfileLabel = this.currentLaunchProfile.label;
      info.nextLaunchProfileBehavior = formatLaunchProfileBehavior(this.currentLaunchProfile);
      info.nextUnsafeLaunch = this.currentLaunchProfile.unsafe;
    }

    if (
      this.sessionTokens.input > 0 ||
      this.sessionTokens.cached > 0 ||
      this.sessionTokens.output > 0
    ) {
      info.sessionTokens = { ...this.sessionTokens };
    }

    return info;
  }

  isProcessing(): boolean {
    return this.activeProcess !== null;
  }

  hasActiveThread(): boolean {
    return this.sessionId !== null || this.activeThreadLaunchProfile !== null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (this.activeProcess) {
      throw new Error("A Claude Code turn is already in progress");
    }

    const promptText = buildPromptText(input);
    const args = buildClaudeArgs(promptText, {
      sessionId: this.sessionId,
      model: this.currentModel ?? this.config.claudeModel,
      launchProfile: this.currentLaunchProfile,
    });

    return new Promise<void>((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, {
        cwd: this.currentWorkspace,
        env: buildClaudeEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.activeProcess = child;
      this.activeThreadLaunchProfile = this.currentLaunchProfile;

      const stderrChunks: Buffer[] = [];
      const rl = readline.createInterface({ input: child.stdout });
      let lastAgentText = "";
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (this.activeProcess === child) {
          this.activeProcess = null;
        }
        rl.close();
        fn();
      };

      child.stderr.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      child.once("error", (error) => {
        settle(() => reject(error));
      });

      child.once("exit", (code, signal) => {
        if (!settled) {
          if (signal === "SIGTERM" || signal === "SIGKILL") {
            // Aborted by the user — treat as a clean end without calling onAgentEnd.
            settle(() => resolve());
            return;
          }
          if (code !== 0 && code !== null) {
            const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
            settle(() =>
              reject(
                new Error(
                  `Claude Code exited with code ${code}${stderr ? `: ${stderr}` : ""}`,
                ),
              ),
            );
          } else {
            settle(() => resolve());
          }
        }
      });

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let event: ClaudeEvent;
        try {
          event = JSON.parse(trimmed) as ClaudeEvent;
        } catch {
          return;
        }

        switch (event.type) {
          case "system": {
            const sysEvent = event as ClaudeSystemInitEvent;
            if (sysEvent.subtype === "init" && !this.sessionId) {
              this.sessionId = sysEvent.session_id;
            }
            break;
          }

          case "assistant": {
            const assistantEvent = event as ClaudeAssistantEvent;
            for (const block of assistantEvent.message.content) {
              if (block.type === "text") {
                const fullText = block.text;
                const delta = computeTextDelta(lastAgentText, fullText);
                if (delta) {
                  lastAgentText = fullText;
                  callbacks.onTextDelta(delta);
                } else {
                  lastAgentText = fullText;
                }
              } else if (block.type === "tool_use") {
                callbacks.onToolStart(block.name, block.id);
              }
            }
            break;
          }

          case "user": {
            const userEvent = event as ClaudeUserEvent;
            for (const block of userEvent.message.content) {
              if (block.type === "tool_result") {
                const isError = block.is_error ?? false;
                const resultText =
                  typeof block.content === "string"
                    ? block.content
                    : block.content
                        .filter((c) => c.type === "text")
                        .map((c) => c.text ?? "")
                        .join("");

                if (resultText) {
                  callbacks.onToolUpdate(block.tool_use_id, truncate(resultText, 500));
                }
                callbacks.onToolEnd(block.tool_use_id, isError);
              }
            }
            break;
          }

          case "result": {
            const resultEvent = event as ClaudeResultEvent;

            if (resultEvent.subtype !== "success" || resultEvent.is_error) {
              const errorMessage =
                resultEvent.error ?? resultEvent.result ?? "Claude Code failed";
              settle(() => reject(new Error(errorMessage)));
              return;
            }

            const usage = resultEvent.usage;
            if (usage) {
              const inputTokens = usage.input_tokens;
              const cachedTokens = usage.cache_read_input_tokens ?? 0;
              const outputTokens = usage.output_tokens;

              this.sessionTokens.input += inputTokens;
              this.sessionTokens.cached += cachedTokens;
              this.sessionTokens.output += outputTokens;

              callbacks.onTurnComplete?.({
                inputTokens,
                cachedInputTokens: cachedTokens,
                outputTokens,
              });
            }

            callbacks.onAgentEnd();
            settle(() => resolve());
            break;
          }

          default:
            break;
        }
      });

      // Claude reads the prompt from CLI args, not stdin.
      child.stdin.end();
    });
  }

  async abort(): Promise<boolean> {
    if (!this.activeProcess) {
      return false;
    }

    // Send SIGTERM but do NOT null activeProcess here — let the exit handler in
    // prompt() clean it up so isProcessing() stays accurate until the process exits.
    this.activeProcess.kill("SIGTERM");
    return true;
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    if (this.activeProcess) {
      throw new Error("Cannot start a new session while a turn is in progress");
    }

    const effectiveWorkspace = resolveLaunchWorkspace(
      workspace ?? this.currentWorkspace,
      this.config.workspace,
      this.config.workspaceRoot,
    );

    this.currentWorkspace = effectiveWorkspace;
    this.sessionId = null;
    this.activeThreadLaunchProfile = this.currentLaunchProfile;

    if (model) {
      this.currentModel = model;
    }

    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    if (this.activeProcess) {
      throw new Error("Cannot resume a session while a turn is in progress");
    }

    this.sessionId = threadId;
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    if (this.activeProcess) {
      throw new Error("Cannot switch session while a turn is in progress");
    }

    const record = findClaudeSessionSync(threadId);
    if (record?.cwd) {
      const workspace = resolveLaunchWorkspace(
        record.cwd,
        this.config.workspace,
        this.config.workspaceRoot,
      );
      this.currentWorkspace = workspace;
      if (record.model) {
        this.currentModel = record.model;
      }
    }

    this.sessionId = threadId;
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    return this.getInfo();
  }

  listAllSessions(limit?: number): CodexThreadRecord[] {
    const requestedLimit = limit ?? 20;
    try {
      const sessions = listClaudeSessionsSync(this.config.workspaceRoot);
      return sessions.slice(0, requestedLimit);
    } catch {
      return [];
    }
  }

  listWorkspaces(): string[] {
    return listWorkspaceDirectories(this.config.workspaceRoot);
  }

  listModels(): CodexModelRecord[] {
    return CLAUDE_MODELS;
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setReasoningEffort(effort: string): void {
    this.currentReasoningEffort = effort;
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    return this.currentLaunchProfile;
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.sessionId, workspace: this.currentWorkspace };
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
    this.sessionId = null;
    this.activeThreadLaunchProfile = null;
    return info;
  }

  dispose(): void {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
    this.sessionId = null;
    this.activeThreadLaunchProfile = null;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildPromptText(input: CodexPromptInput): string {
  if (typeof input === "string") {
    return input;
  }

  const parts: string[] = [];
  if (input.stagedFileInstructions) {
    parts.push(input.stagedFileInstructions);
  }
  if (input.text) {
    parts.push(input.text);
  }
  return parts.join("\n\n");
}

function buildClaudeArgs(
  prompt: string,
  options: {
    sessionId: string | null;
    model?: string;
    launchProfile: CodexLaunchProfile;
  },
): string[] {
  const args: string[] = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
  ];

  if (options.sessionId) {
    args.push("--resume", options.sessionId);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.launchProfile.sandboxMode === "danger-full-access") {
    args.push("--allow-dangerously-skip-permissions");
  }

  args.push(prompt);
  return args;
}

function buildClaudeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function getLaunchProfile(config: TeleCodexConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}

function resolveLaunchWorkspace(
  workspace: string,
  fallbackWorkspace: string,
  workspaceRoot: string,
): string {
  if (!isWithinWorkspaceRoot(workspace, workspaceRoot)) {
    return fallbackWorkspace;
  }
  if (existsDirectory(workspace)) {
    return path.resolve(workspace);
  }
  if (existsDirectory(fallbackWorkspace)) {
    return path.resolve(fallbackWorkspace);
  }
  return workspace;
}

function isWithinWorkspaceRoot(workspace: string, workspaceRoot: string): boolean {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedRoot = path.resolve(workspaceRoot);
  const relative = path.relative(resolvedRoot, resolvedWorkspace);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function listWorkspaceDirectories(workspaceRoot: string): string[] {
  const root = path.resolve(workspaceRoot);
  const directories = new Set<string>([root]);

  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(fullPath).isDirectory())) {
        directories.add(fullPath);
      }
    }
  } catch {
    return [root];
  }

  return [...directories].sort((left, right) => {
    if (left === root) return -1;
    if (right === root) return 1;
    return left.localeCompare(right);
  });
}

function existsDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Claude session storage reader (~/.claude/projects/)
// ---------------------------------------------------------------------------

function getClaudeProjectsDir(): string {
  return path.join(homedir(), ".claude", "projects");
}

interface RawSessionData {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  firstUserMessage: string;
  createdAt: Date;
  updatedAt: Date;
}

function parseClaudeJsonl(filePath: string): RawSessionData | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const stat = statSync(filePath);
  const updatedAt = new Date(stat.mtimeMs);
  const createdAt = new Date(stat.ctimeMs);

  let sessionId = "";
  let title = "";
  let cwd = "";
  let model: string | null = null;
  let firstUserMessage = "";

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type as string | undefined;
    const sid = obj.sessionId as string | undefined;
    if (sid && !sessionId) {
      sessionId = sid;
    }

    if (type === "ai-title" && !title) {
      title = (obj.aiTitle as string | undefined) ?? "";
    }

    if (type === "user" && !cwd) {
      cwd = (obj.cwd as string | undefined) ?? "";
    }

    if (type === "last-prompt" && !firstUserMessage) {
      firstUserMessage = (obj.lastPrompt as string | undefined) ?? "";
    }

    if (type === "assistant" && !model) {
      const msg = obj.message as Record<string, unknown> | undefined;
      if (msg) {
        model = (msg.model as string | undefined) ?? null;
      }
    }
  }

  if (!sessionId) return null;

  return { id: sessionId, title, cwd, model, firstUserMessage, createdAt, updatedAt };
}

function listClaudeSessionsSync(workspaceRoot: string | undefined): CodexThreadRecord[] {
  const projectsDir = getClaudeProjectsDir();
  const results: CodexThreadRecord[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir)
      .map((entry) => path.join(projectsDir, entry))
      .filter((p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      });
  } catch {
    return [];
  }

  for (const projectDir of projectDirs) {
    let files: string[];
    try {
      files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const data = parseClaudeJsonl(filePath);
      if (!data) continue;

      if (workspaceRoot && data.cwd) {
        if (!isWithinWorkspaceRoot(data.cwd, workspaceRoot)) {
          continue;
        }
      }

      results.push({
        id: data.id,
        title: data.title,
        cwd: data.cwd,
        model: data.model,
        firstUserMessage: data.firstUserMessage,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      });
    }
  }

  return results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

function findClaudeSessionSync(sessionId: string): CodexThreadRecord | null {
  const projectsDir = getClaudeProjectsDir();

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir)
      .map((entry) => path.join(projectsDir, entry))
      .filter((p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      });
  } catch {
    return null;
  }

  for (const projectDir of projectDirs) {
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const data = parseClaudeJsonl(filePath);
    if (data) {
      return {
        id: data.id,
        title: data.title,
        cwd: data.cwd,
        model: data.model,
        firstUserMessage: data.firstUserMessage,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      };
    }
  }

  return null;
}

// Re-export for codex-state.ts compatibility
export { listClaudeSessionsSync as listAllClaudeSessionsSync, findClaudeSessionSync };

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
