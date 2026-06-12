export interface EnqueueResult {
  position: number;
  started: boolean;
}

type QueuedTask = () => Promise<void>;

type QueueState = {
  running: boolean;
  items: QueuedTask[];
};

export class TaskQueue<Key> {
  private readonly states = new Map<Key, QueueState>();

  constructor(private readonly onTaskError?: (key: Key, error: unknown) => void) {}

  enqueue(key: Key, task: QueuedTask): EnqueueResult {
    const state = this.getOrCreateState(key);
    const position = state.items.length + (state.running ? 1 : 0);

    state.items.push(task);
    this.kick(key);

    return {
      position,
      started: position === 0,
    };
  }

  hasWork(key: Key): boolean {
    const state = this.states.get(key);
    return Boolean(state && (state.running || state.items.length > 0));
  }

  isRunning(key: Key): boolean {
    return Boolean(this.states.get(key)?.running);
  }

  pendingCount(key: Key): number {
    return this.states.get(key)?.items.length ?? 0;
  }

  clearPending(key: Key): number {
    const state = this.states.get(key);
    if (!state) {
      return 0;
    }

    const cleared = state.items.length;
    state.items = [];
    this.cleanupIfIdle(key, state);
    return cleared;
  }

  private kick(key: Key): void {
    const state = this.states.get(key);
    if (!state || state.running) {
      return;
    }

    const task = state.items.shift();
    if (!task) {
      this.cleanupIfIdle(key, state);
      return;
    }

    state.running = true;
    void task()
      .catch((error) => {
        this.onTaskError?.(key, error);
      })
      .finally(() => {
        state.running = false;
        if (state.items.length === 0) {
          this.cleanupIfIdle(key, state);
          return;
        }
        this.kick(key);
      });
  }

  private getOrCreateState(key: Key): QueueState {
    let state = this.states.get(key);
    if (!state) {
      state = { running: false, items: [] };
      this.states.set(key, state);
    }
    return state;
  }

  private cleanupIfIdle(key: Key, state: QueueState): void {
    if (!state.running && state.items.length === 0) {
      this.states.delete(key);
    }
  }
}
