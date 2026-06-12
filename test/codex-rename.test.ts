import { describe, expect, it } from "vitest";

import { normalizeThreadName } from "../src/codex-rename.js";

describe("codex-rename", () => {
  it("normalizes whitespace in thread names", () => {
    expect(normalizeThreadName("  Release   checklist\nthread  ")).toBe("Release checklist thread");
  });

  it("rejects empty thread names", () => {
    expect(() => normalizeThreadName("   ")).toThrow("Usage: /rename <new session title>");
  });

  it("caps very long thread names", () => {
    expect(normalizeThreadName("x".repeat(140))).toHaveLength(120);
  });
});
