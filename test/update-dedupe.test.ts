import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UpdateDeduper } from "../src/update-dedupe.js";

describe("UpdateDeduper", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function createDeduper(): UpdateDeduper {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "telecodex-dedupe-"));
    tempRoots.push(tempRoot);
    return new UpdateDeduper("bot-token", tempRoot);
  }

  it("allows the first occurrence of an update id", () => {
    const deduper = createDeduper();

    expect(deduper.shouldProcess(123, 1_000)).toBe(true);
  });

  it("rejects duplicate update ids within the ttl window", () => {
    const deduper = createDeduper();

    expect(deduper.shouldProcess(123, 1_000)).toBe(true);
    expect(deduper.shouldProcess(123, 2_000)).toBe(false);
  });

  it("allows processing again after the ttl expires", () => {
    const deduper = createDeduper();

    expect(deduper.shouldProcess(123, 1_000)).toBe(true);
    expect(deduper.shouldProcess(123, 1_000 + 10 * 60 * 1000 + 1)).toBe(true);
  });
});
