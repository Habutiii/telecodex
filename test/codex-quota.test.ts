import { describe, expect, it, vi } from "vitest";

import { formatQuotaHTML, formatQuotaPlain, type CodexRateLimitSnapshot } from "../src/codex-quota.js";

describe("codex-quota", () => {
  it("formats quota windows and credits", () => {
    vi.setSystemTime(new Date("2026-06-12T00:00:00Z"));
    const snapshot: CodexRateLimitSnapshot = {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent: 16,
        windowDurationMins: 300,
        resetsAt: Date.parse("2026-06-12T05:00:00Z") / 1000,
      },
      secondary: {
        usedPercent: 47,
        windowDurationMins: 10080,
        resetsAt: Date.parse("2026-06-15T01:00:00Z") / 1000,
      },
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: "0",
      },
      individualLimit: null,
      planType: "plus",
      rateLimitReachedType: null,
    };

    expect(formatQuotaPlain(snapshot)).toBe(
      [
        "Codex quota (plus)",
        "Primary: 16% used · 84% left · 5h window · resets in 5h 0m",
        "Secondary: 47% used · 53% left · 7d window · resets in 3d 1h",
        "Credits: 0 available",
      ].join("\n"),
    );
  });

  it("escapes dynamic HTML fields", () => {
    const snapshot: CodexRateLimitSnapshot = {
      limitId: "codex",
      limitName: null,
      primary: null,
      secondary: null,
      credits: null,
      individualLimit: null,
      planType: "<plus>",
      rateLimitReachedType: "primary",
    };

    expect(formatQuotaHTML(snapshot, (value) => value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"))).toBe(
      ["<b>Codex quota (&lt;plus&gt;)</b>", "Limit reached: primary"].join("\n"),
    );
  });
});
