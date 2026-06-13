import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findLaunchProfile } from "./codex-launch.js";
import { CodexSessionService } from "./codex-session.js";
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

export interface PruneMissingWorkspacesResult {
  removedContextKeys: TelegramContextKey[];
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly pendingSessions = new Map<TelegramContextKey, Promise<CodexSessionService>>();
  private readonly creationVersions = new Map<TelegramContextKey, number>();
  private readonly persistPath: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: TeleCodexConfig) {
    this.persistPath = path.join(config.workspace, ".telecodex", "contexts.json");
    this.loadPersistedMetadata();
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
      const created = await CodexSessionService.create(this.config, {
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

  pruneMissingWorkspaces(): PruneMissingWorkspacesResult {
    const removedContextKeys: TelegramContextKey[] = [];

    for (const [contextKey, meta] of this.metadata.entries()) {
      if (existsSync(meta.workspace)) {
        continue;
      }

      this.bumpCreationVersion(contextKey);
      this.pendingSessions.delete(contextKey);
      const session = this.sessions.get(contextKey);
      session?.dispose();
      this.sessions.delete(contextKey);
      this.metadata.delete(contextKey);
      this.onRemoveCallback?.(contextKey);
      removedContextKeys.push(contextKey);
    }

    if (removedContextKeys.length > 0) {
      this.persistMetadata();
    }

    return { removedContextKeys };
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
    try {
      const dir = path.dirname(this.persistPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = [...this.metadata.values()];
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      if (!existsSync(this.persistPath)) {
        return;
      }
      const raw = readFileSync(this.persistPath, "utf8");
      const data = JSON.parse(raw) as ContextMetadata[];
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, entry);
        }
      }
    } catch {
      // Silently ignore load errors.
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
