import { describe, expect, it, vi } from "vitest";

import { TaskQueue } from "../src/task-queue.js";

async function flushQueue(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("TaskQueue", () => {
  it("runs tasks immediately when idle and serializes later tasks", async () => {
    const queue = new TaskQueue<string>();
    const order: string[] = [];

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = vi.fn(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = vi.fn(async () => {
      order.push("second");
    });

    const firstResult = queue.enqueue("ctx", first);
    const secondResult = queue.enqueue("ctx", second);

    expect(firstResult).toEqual({ position: 0, started: true });
    expect(secondResult).toEqual({ position: 1, started: false });
    expect(queue.hasWork("ctx")).toBe(true);
    expect(queue.isRunning("ctx")).toBe(true);
    expect(queue.pendingCount("ctx")).toBe(1);
    expect(order).toEqual(["first:start"]);

    releaseFirst();
    await flushQueue();

    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(queue.hasWork("ctx")).toBe(false);
    expect(queue.isRunning("ctx")).toBe(false);
    expect(queue.pendingCount("ctx")).toBe(0);
  });

  it("continues processing after a task failure", async () => {
    const onTaskError = vi.fn();
    const queue = new TaskQueue<string>(onTaskError);
    const order: string[] = [];

    queue.enqueue("ctx", async () => {
      order.push("first");
      throw new Error("boom");
    });
    queue.enqueue("ctx", async () => {
      order.push("second");
    });

    await flushQueue();

    expect(order).toEqual(["first", "second"]);
    expect(onTaskError).toHaveBeenCalledTimes(1);
    expect(onTaskError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
    expect(queue.hasWork("ctx")).toBe(false);
  });

  it("can clear pending tasks without interrupting the running task", async () => {
    const queue = new TaskQueue<string>();

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const seen: string[] = [];
    queue.enqueue("ctx", async () => {
      seen.push("first:start");
      await firstBlocked;
      seen.push("first:end");
    });
    queue.enqueue("ctx", async () => {
      seen.push("second");
    });
    queue.enqueue("ctx", async () => {
      seen.push("third");
    });

    expect(queue.clearPending("ctx")).toBe(2);
    expect(queue.pendingCount("ctx")).toBe(0);

    releaseFirst();
    await flushQueue();

    expect(seen).toEqual(["first:start", "first:end"]);
    expect(queue.hasWork("ctx")).toBe(false);
  });
});
