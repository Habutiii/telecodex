import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  Codex,
  type ApprovalMode,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type Thread,
  type ThreadEvent,
  type UserInput,
} from "@openai/codex-sdk";

import type { TeleCodexConfig } from "./config.js";
import {
  getThread,
  listModels,
  listThreads,
  type CodexModelRecord,
  type CodexThreadRecord,
} from "./codex-state.js";
import {
  findLaunchProfile,
  formatLaunchProfileBehavior,
  type CodexLaunchProfile,
} from "./codex-launch.js";

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

export type CodexPromptInput = string | { text?: string; imagePaths?: string[]; stagedFileInstructions?: string };

export class CodexSessionService {
  private codex: Codex | null = null;
  private codexWorkspace: string | null = null;
  private thread: Thread | null = null;
  private currentWorkspace: string;
  private abortController: AbortController | null = null;
  private currentThreadId: string | null = null;
  private currentModel: string | undefined;
  private currentReasoningEffort: ModelReasoningEffort | undefined;
  private currentLaunchProfile: CodexLaunchProfile;
  private activeThreadLaunchProfile: CodexLaunchProfile | null = null;
  private sessionTokens = { input: 0, cached: 0, output: 0 };

  private constructor(private readonly config: TeleCodexConfig) {
    this.currentWorkspace = config.workspace;
    this.currentLaunchProfile = getLaunchProfile(config, config.defaultLaunchProfileId);
  }

  static async create(config: TeleCodexConfig, options?: CreateOptions): Promise<CodexSessionService> {
    const service = new CodexSessionService(config);
    service.currentWorkspace = resolveLaunchWorkspace(
      options?.workspace ?? config.workspace,
      config.workspace,
      config.workspaceRoot,
    );
    service.currentModel = options?.model ?? config.codexModel;
    service.currentReasoningEffort = options?.reasoningEffort as ModelReasoningEffort | undefined;
    service.currentLaunchProfile = getLaunchProfile(
      config,
      options?.launchProfileId ?? config.defaultLaunchProfileId,
    );
    service.resetCodexClient();

    if (options?.resumeThreadId) {
      await service.resumeThread(options.resumeThreadId);
      return service;
    }

    if (options?.deferThreadStart) {
      return service;
    }

    await service.newThread(service.currentWorkspace, service.currentModel);
    return service;
  }

  getInfo(): CodexSessionInfo {
    const effectiveLaunchProfile = this.activeThreadLaunchProfile ?? this.currentLaunchProfile;
    const info: CodexSessionInfo = {
      threadId: this.thread?.id ?? this.currentThreadId,
      workspace: this.currentWorkspace,
      model: this.currentModel ?? this.config.codexModel,
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

    if (this.sessionTokens.input > 0 || this.sessionTokens.cached > 0 || this.sessionTokens.output > 0) {
      info.sessionTokens = { ...this.sessionTokens };
    }

    return info;
  }

  isProcessing(): boolean {
    return this.abortController !== null;
  }

  hasActiveThread(): boolean {
    return this.thread !== null;
  }

  getCurrentWorkspace(): string {
    return this.currentWorkspace;
  }

  async prompt(input: CodexPromptInput, callbacks: CodexSessionCallbacks): Promise<void> {
    if (!this.thread) {
      throw new Error("Codex thread is not initialized");
    }

    if (this.abortController) {
      throw new Error("A Codex turn is already in progress");
    }

    const controller = new AbortController();
    this.abortController = controller;
    let lastAgentText = "";

    // Track cumulative aggregated_output per command item to compute deltas.
    const lastCommandOutput = new Map<string, string>();

    try {
      const { events } = await this.thread.runStreamed(this.buildSdkInput(input), { signal: controller.signal });

      for await (const event of events) {
        this.handleThreadEvent(event);

        switch (event.type) {
          case "item.started":
          case "item.updated": {
            const item = event.item;
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                lastAgentText = item.text;
                callbacks.onTextDelta(delta);
              } else {
                lastAgentText = item.text;
              }
            } else if (item.type === "command_execution") {
              if (event.type === "item.started") {
                // Record baseline so the first item.updated delta is computed correctly.
                lastCommandOutput.set(item.id, item.aggregated_output);
                callbacks.onToolStart(item.command, item.id);
              } else {
                // aggregated_output grows monotonically; pass only the new portion.
                const prev = lastCommandOutput.get(item.id) ?? "";
                const delta = computeTextDelta(prev, item.aggregated_output);
                lastCommandOutput.set(item.id, item.aggregated_output);
                if (delta) {
                  callbacks.onToolUpdate(item.id, delta);
                }
              }
            } else if (item.type === "web_search") {
              if (event.type === "item.started") {
                const label = truncate(item.query, 60);
                callbacks.onToolStart(`🔍 ${label}`, item.id);
                callbacks.onToolUpdate(item.id, item.query);
              }
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "item.completed": {
            const item = event.item;
            if (item.type === "agent_message") {
              const delta = computeTextDelta(lastAgentText, item.text);
              if (delta) {
                callbacks.onTextDelta(delta);
              }
              lastAgentText = item.text;
            } else if (item.type === "command_execution") {
              // Pass any output that arrived only in the completion event (e.g. fast
              // commands that never fired item.updated).
              const prev = lastCommandOutput.get(item.id) ?? "";
              const delta = computeTextDelta(prev, item.aggregated_output);
              if (delta) {
                callbacks.onToolUpdate(item.id, delta);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "file_change") {
              const toolId = item.id;
              const summary = item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
              callbacks.onToolStart("file_change", toolId);
              callbacks.onToolUpdate(toolId, summary);
              callbacks.onToolEnd(toolId, item.status === "failed");
            } else if (item.type === "mcp_tool_call") {
              callbacks.onToolStart(`mcp:${item.server}/${item.tool}`, item.id);
              if (item.error) {
                callbacks.onToolUpdate(item.id, item.error.message);
              }
              callbacks.onToolEnd(item.id, item.status === "failed");
            } else if (item.type === "web_search") {
              callbacks.onToolEnd(item.id, false);
            } else if (item.type === "error") {
              callbacks.onToolStart("⚠️ error", item.id);
              callbacks.onToolUpdate(item.id, item.message);
              callbacks.onToolEnd(item.id, true);
            } else if (item.type === "todo_list") {
              callbacks.onTodoUpdate?.(item.items);
            }
            break;
          }
          case "turn.completed": {
            // Accumulate and deliver usage BEFORE onAgentEnd so that
            // finalizeResponse() can read lastTurnUsage when building the
            // final message text.
            const u = event.usage;
            this.sessionTokens.input += u.input_tokens;
            this.sessionTokens.cached += u.cached_input_tokens;
            this.sessionTokens.output += u.output_tokens;
            callbacks.onTurnComplete?.({
              inputTokens: u.input_tokens,
              cachedInputTokens: u.cached_input_tokens,
              outputTokens: u.output_tokens,
            });
            callbacks.onAgentEnd();
            break;
          }
          case "turn.failed":
            throw new Error(event.error.message);
          case "error":
            throw new Error(event.message);
          default:
            break;
        }
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  async abort(): Promise<boolean> {
    if (!this.abortController) {
      return false;
    }

    this.abortController.abort();
    return true;
  }

  async newThread(workspace?: string, model?: string): Promise<CodexSessionInfo> {
    this.ensureIdle("start a new thread");

    const effectiveWorkspace = resolveLaunchWorkspace(
      workspace ?? this.currentWorkspace,
      this.config.workspace,
      this.config.workspaceRoot,
    );
    const effectiveModel = model ?? this.currentModel;
    this.currentWorkspace = effectiveWorkspace;
    this.ensureCodexClientWorkspace(effectiveWorkspace);
    this.thread = this.getCodex().startThread(this.buildThreadOptions(effectiveWorkspace, effectiveModel));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = this.thread.id ?? null;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  async resumeThread(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("resume a thread");

    const workspace = resolveLaunchWorkspace(
      this.currentWorkspace,
      this.config.workspace,
      this.config.workspaceRoot,
    );
    this.currentWorkspace = workspace;
    this.ensureCodexClientWorkspace(workspace);
    this.thread = this.getCodex().resumeThread(
      threadId,
      this.buildThreadOptions(workspace, this.currentModel),
    );
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = threadId;
    return this.getInfo();
  }

  async switchSession(threadId: string): Promise<CodexSessionInfo> {
    this.ensureIdle("switch session");

    const record = getThread(threadId);
    const workspace = resolveLaunchWorkspace(
      record?.cwd ?? this.currentWorkspace,
      this.config.workspace,
      this.config.workspaceRoot,
    );
    const model = record?.model || undefined;

    this.currentWorkspace = workspace;
    this.ensureCodexClientWorkspace(workspace);
    this.thread = this.getCodex().resumeThread(threadId, this.buildThreadOptions(workspace, model));
    this.activeThreadLaunchProfile = this.currentLaunchProfile;
    this.currentThreadId = threadId;
    if (model) {
      this.currentModel = model;
    }
    return this.getInfo();
  }

  listAllSessions(limit?: number): CodexThreadRecord[] {
    const requestedLimit = limit ?? 20;
    return listThreads(Math.max(requestedLimit, 200))
      .filter((thread) => isWithinWorkspaceRoot(thread.cwd, this.config.workspaceRoot))
      .slice(0, requestedLimit);
  }

  listWorkspaces(): string[] {
    return listWorkspaceDirectories(this.config.workspaceRoot);
  }

  listModels(): CodexModelRecord[] {
    return listModels();
  }

  setModel(slug: string): string {
    this.currentModel = slug;
    return slug;
  }

  setReasoningEffort(effort: ModelReasoningEffort): void {
    this.currentReasoningEffort = effort;
  }

  setLaunchProfile(profileId: string): CodexLaunchProfile {
    this.currentLaunchProfile = getLaunchProfile(this.config, profileId);
    this.resetCodexClient();
    return this.currentLaunchProfile;
  }

  getSelectedLaunchProfile(): CodexLaunchProfile {
    return this.currentLaunchProfile;
  }

  handback(): { threadId: string | null; workspace: string } {
    const info = { threadId: this.currentThreadId, workspace: this.currentWorkspace };
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
    return info;
  }

  dispose(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.thread = null;
    this.currentThreadId = null;
    this.activeThreadLaunchProfile = null;
  }

  private buildSdkInput(input: CodexPromptInput): Input {
    if (typeof input === "string") {
      return input;
    }

    const parts: UserInput[] = [];
    const textParts: string[] = [];

    if (input.stagedFileInstructions) {
      textParts.push(input.stagedFileInstructions);
    }
    if (input.text) {
      textParts.push(input.text);
    }
    if (textParts.length > 0) {
      parts.push({ type: "text", text: textParts.join("\n\n") });
    }

    for (const imagePath of input.imagePaths ?? []) {
      parts.push({ type: "local_image", path: imagePath });
    }

    if (parts.length === 0) {
      return "";
    }
    if (parts.length === 1 && parts[0]?.type === "text") {
      return parts[0].text;
    }
    return parts;
  }

  private buildThreadOptions(workspace: string, model?: string): {
    model?: string;
    sandboxMode: SandboxMode;
    workingDirectory: string;
    approvalPolicy: ApprovalMode;
    skipGitRepoCheck: true;
    modelReasoningEffort?: ModelReasoningEffort;
  } {
    const effectiveModel = model ?? this.currentModel ?? this.config.codexModel;
    const options = {
      model: effectiveModel,
      sandboxMode: this.currentLaunchProfile.sandboxMode,
      workingDirectory: workspace,
      approvalPolicy: this.currentLaunchProfile.approvalPolicy,
      skipGitRepoCheck: true as const,
    };

    if (this.currentReasoningEffort) {
      return {
        ...options,
        modelReasoningEffort: this.currentReasoningEffort,
      };
    }

    return options;
  }

  private ensureIdle(action: string): void {
    if (this.abortController) {
      throw new Error(`Cannot ${action} while a turn is in progress`);
    }
  }

  private handleThreadEvent(event: ThreadEvent): void {
    if (event.type === "thread.started") {
      this.currentThreadId = event.thread_id;
    }
  }

  private getCodex(): Codex {
    if (!this.codex) {
      this.resetCodexClient();
    }

    return this.codex!;
  }

  private ensureCodexClientWorkspace(workspace: string): void {
    if (!this.codex || this.codexWorkspace !== workspace) {
      this.resetCodexClient();
    }
  }

  private resetCodexClient(): void {
    this.codex = new Codex({
      apiKey: this.config.codexApiKey,
      config: {
        approval_policy: this.currentLaunchProfile.approvalPolicy,
        projects: {
          [toTomlQuotedKey(this.currentWorkspace)]: {
            trust_level: "untrusted",
          },
        },
      },
      env: buildCodexEnv(this.config.codexApiKey),
    });
    this.codexWorkspace = this.currentWorkspace;
  }
}

function getLaunchProfile(config: TeleCodexConfig, profileId: string): CodexLaunchProfile {
  const profile = findLaunchProfile(config.launchProfiles, profileId);
  if (!profile) {
    throw new Error(`Unknown launch profile: ${profileId}`);
  }
  return profile;
}

function resolveLaunchWorkspace(workspace: string, fallbackWorkspace: string, workspaceRoot: string): string {
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

function buildCodexEnv(apiKey?: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  if (apiKey) {
    env.CODEX_API_KEY = apiKey;
  }

  return env;
}

function toTomlQuotedKey(value: string): string {
  return JSON.stringify(value);
}

function computeTextDelta(previousText: string, nextText: string): string {
  return nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
