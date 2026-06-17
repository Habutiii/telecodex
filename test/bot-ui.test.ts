import { describe, expect, it } from "vitest";

import {
  formatSessionLabel,
  renderHelpMessage,
  renderSessionListMessage,
  renderWelcomeFirstTime,
  renderWelcomeReturning,
} from "../src/bot-ui.js";

describe("bot-ui", () => {
  describe("renderHelpMessage", () => {
    it("contains all command groups", () => {
      const { html, plain } = renderHelpMessage();
      expect(html).toContain("Session");
      expect(html).toContain("Model");
      expect(html).toContain("Auth");
      expect(html).toContain("Utility");
      expect(plain).toContain("/new");
      expect(plain).toContain("/help");
      expect(plain).toContain("/retry");
    });

    it("lists all 13 commands", () => {
      const { plain } = renderHelpMessage();
      const commandMatches = plain.match(/\/\w+/g) ?? [];
      expect(commandMatches.length).toBe(13);
    });

    it("returns valid HTML with bold tags", () => {
      const { html } = renderHelpMessage();
      expect(html).toContain("<b>");
      expect(html).toContain("</b>");
    });
  });

  describe("renderWelcomeFirstTime", () => {
    it("shows welcome without auth warning", () => {
      const { html, plain } = renderWelcomeFirstTime();
      expect(html).toContain("TeleCodex is ready");
      expect(plain).toContain("/help");
      expect(html).not.toContain("⚠️");
    });

    it("includes auth warning when provided", () => {
      const { html, plain } = renderWelcomeFirstTime("Not authenticated");
      expect(html).toContain("⚠️");
      expect(plain).toContain("Not authenticated");
    });
  });

  describe("renderWelcomeReturning", () => {
    it("shows session info for returning user", () => {
      const { html, plain } = renderWelcomeReturning(
        "<b>Thread:</b> abc123",
        "Thread: abc123",
        false,
      );
      expect(html).toContain("TeleCodex");
      expect(html).toContain("abc123");
      expect(plain).toContain("abc123");
    });

    it("shows topic label for topic sessions", () => {
      const { html } = renderWelcomeReturning("", "", true);
      expect(html).toContain("topic session");
    });

    it("includes auth warning when provided", () => {
      const { html } = renderWelcomeReturning("", "", false, "Expired");
      expect(html).toContain("⚠️");
      expect(html).toContain("Expired");
    });
  });

  describe("formatSessionLabel", () => {
    it("formats basic session label", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-project",
        title: "fix the login bug",
        relativeTime: "3h ago",
        isActive: false,
      });
      expect(label).toContain("📁");
      expect(label).toContain("my-project");
      expect(label).toContain("fix the login bug");
      expect(label).toContain("3h ago");
    });

    it("shows checkmark for active session", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "now",
        isActive: true,
      });
      expect(label).toContain("✅");
    });

    it("appends model tag when available", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "test",
        relativeTime: "1m ago",
        model: "gpt-4o",
        isActive: false,
      });
      expect(label).toContain("gpt-4o");
    });

    it("truncates long workspace names", () => {
      const label = formatSessionLabel({
        workspace: "/home/user/my-very-long-project-name",
        title: "test",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label).toContain("my-very-l…");
    });

    it("includes the session number when provided", () => {
      const label = formatSessionLabel({
        index: 7,
        workspace: "/project",
        title: "test",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label).toContain("7. test");
    });

    it("truncates long titles to 20 chars", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "this is an extremely long title that should be truncated",
        relativeTime: "1m",
        isActive: false,
      });
      expect(label.length).toBeLessThan(120);
    });

    it("handles missing title gracefully", () => {
      const label = formatSessionLabel({
        workspace: "/project",
        title: "",
        relativeTime: "5m ago",
        isActive: false,
      });
      expect(label).toContain("(untitled)");
    });

    it("truncates long model names", () => {
      const label = formatSessionLabel({
        workspace: "/p",
        title: "t",
        relativeTime: "1m",
        model: "very-long-model-name-here",
        isActive: false,
      });
      expect(label).toContain("very-long…");
    });
  });

  describe("renderSessionListMessage", () => {
    it("renders title, first message, workspace, age, and model", () => {
      const { html, plain } = renderSessionListMessage(
        [
          {
            index: 1,
            workspace: "/home/user/telecodex",
            title: "Improve sessions UX",
            firstUserMessage: "The /sessions function is hard to understand from Telegram.",
            relativeTime: "2h ago",
            model: "gpt-5.4",
            isActive: true,
            boundContextLabels: ["Project Chat / topic 42"],
          },
        ],
        1,
      );

      expect(html).toContain("<b>Recent threads</b> (1)");
      expect(html).toContain("Improve sessions UX");
      expect(html).toContain("telecodex · 2h ago · gpt-5.4");
      expect(html).toContain("The /sessions function is hard to understand");
      expect(html).toContain("Telegram: Project Chat / topic 42");
      expect(plain).toContain("1. ✅ Improve sessions UX");
    });

    it("mentions when later pages contain more threads", () => {
      const { plain } = renderSessionListMessage(
        [
          {
            index: 1,
            workspace: "/project",
            title: "One",
            firstUserMessage: "",
            relativeTime: "just now",
            isActive: false,
          },
        ],
        3,
      );

      expect(plain).toContain("2 more on later pages");
    });
  });
});
