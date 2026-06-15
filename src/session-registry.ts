import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { type AgentType, getActiveAgent } from "./agent-state.js";
import { findLaunchProfile } from "./codex-launch.js";
import { createSessionService, type CodexSessionService } from "./codex-session.js";
import type { TeleCodexConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  label?: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  updatedAt: number;
}

export interface GetOrCreateSessionOptions {
  deferThreadStart?: boolean;
  ignoreMetadata?: boolean;
  replaceExisting?: boolean;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly pendingSessions = new Map<TelegramContextKey, Promise<CodexSessionService>>();
  private readonly creationVersions = new Map<TelegramContextKey, number>();
  private readonly telecodexDir: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: TeleCodexConfig) {
    this.telecodexDir = path.join(config.workspace, ".telecodex");
    this.loadPersistedMetadata(getActiveAgent());
  }

  // Per-agent persist file.  Falls back to the legacy contexts.json (treated as Codex data).
  private persistPathFor(agent: AgentType): string {
    return path.join(this.telecodexDir, `contexts-${agent}.json`);
  }

  // Dispose live session services and reload the new agent's saved metadata.
  // Thread IDs and workspace info are preserved per agent so sessions resume on switch-back.
  switchAgent(newAgent: AgentType): void {
    // Cancel any in-flight creates for the current agent.
    for (const key of this.pendingSessions.keys()) {
      this.bumpCreationVersion(key);
    }
    this.pendingSessions.clear();

    // Dispose live session services (subprocess / SDK connections).
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    // Notify the bot maps so they can clean up their per-key state.
    for (const key of this.sessions.keys()) {
      this.onRemoveCallback?.(key);
    }
    this.sessions.clear();

    // Swap metadata to the new agent's saved state.
    this.metadata.clear();
    this.loadPersistedMetadata(newAgent);
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: GetOrCreateSessionOptions,
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    const pending = this.pendingSessions.get(contextKey);

    if (session && options?.replaceExisting) {
      session.dispose();
      this.sessions.delete(contextKey);
      session = undefined;
      this.bumpCreationVersion(contextKey);
    } else if (pending && options?.replaceExisting) {
      this.bumpCreationVersion(contextKey);
    }

    if (session) {
      return session;
    }

    if (pending && !options?.replaceExisting) {
      return pending;
    }

    const meta = options?.ignoreMetadata ? undefined : this.metadata.get(contextKey);
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    const requestVersion = this.creationVersions.get(contextKey) ?? 0;

    let createPromise!: Promise<CodexSessionService>;
    createPromise = (async (): Promise<CodexSessionService> => {
      const created = await createSessionService(getActiveAgent(), this.config, {
        workspace: meta?.workspace,
        model: meta?.model,
        reasoningEffort: meta?.reasoningEffort,
        launchProfileId,
        deferThreadStart: options?.deferThreadStart && !meta?.threadId,
        resumeThreadId: meta?.threadId ?? undefined,
      });

      if ((this.creationVersions.get(contextKey) ?? 0) !== requestVersion) {
        created.dispose();
        const replacement = this.pendingSessions.get(contextKey);
        if (replacement && replacement !== createPromise) {
          return replacement;
        }
        const current = this.sessions.get(contextKey);
        if (current) {
          return current;
        }
      }

      this.sessions.set(contextKey, created);
      return created;
    })();

    this.pendingSessions.set(contextKey, createPromise);

    try {
      return await createPromise;
    } finally {
      if (this.pendingSessions.get(contextKey) === createPromise) {
        this.pendingSessions.delete(contextKey);
      }
    }
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionService): void {
    const info = session.getInfo();
    this.metadata.set(contextKey, {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      ...(this.metadata.get(contextKey)?.label ? { label: this.metadata.get(contextKey)?.label } : {}),
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      updatedAt: Date.now(),
    });
    this.persistMetadata();
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  listContextsForThread(threadId: string): ContextMetadata[] {
    return this.listContexts().filter((context) => context.threadId === threadId);
  }

  updateContextLabel(contextKey: TelegramContextKey, label: string): void {
    const existing = this.metadata.get(contextKey);
    if (!existing) {
      return;
    }

    if (existing.label === label) {
      return;
    }

    this.metadata.set(contextKey, { ...existing, label });
    this.persistMetadata();
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    this.bumpCreationVersion(contextKey);
    this.pendingSessions.delete(contextKey);
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const contextKey of this.pendingSessions.keys()) {
      this.bumpCreationVersion(contextKey);
    }
    this.pendingSessions.clear();
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private persistMetadata(): void {
    const targetPath = this.persistPathFor(getActiveAgent());
    try {
      if (!existsSync(this.telecodexDir)) {
        mkdirSync(this.telecodexDir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(agent: AgentType): void {
    // Primary path for this agent; fall back to the legacy contexts.json for Codex only.
    const primaryPath = this.persistPathFor(agent);
    const legacyPath = path.join(this.telecodexDir, "contexts.json");
    const isLegacyFallback =
      !existsSync(primaryPath) && agent === "codex" && existsSync(legacyPath);
    const targetPath = existsSync(primaryPath)
      ? primaryPath
      : isLegacyFallback
        ? legacyPath
        : null;

    if (!targetPath) return;

    try {
      const raw = readFileSync(targetPath, "utf8");
      const data = JSON.parse(raw) as ContextMetadata[];
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, entry);
        }
      }
    } catch {
      // Silently ignore load errors.
    }

    // Migrate from the legacy path by writing to the per-agent path immediately.
    if (isLegacyFallback && this.metadata.size > 0) {
      this.persistMetadata();
    }
  }

  private bumpCreationVersion(contextKey: TelegramContextKey): void {
    this.creationVersions.set(contextKey, (this.creationVersions.get(contextKey) ?? 0) + 1);
  }
}

function resolveLaunchProfileId(
  config: TeleCodexConfig,
  meta: ContextMetadata | undefined,
): string | undefined {
  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn(
    `Unknown persisted launch profile "${meta.launchProfileId}" for ${meta.contextKey}. Falling back to ${config.defaultLaunchProfileId}.`,
  );
  return undefined;
}
