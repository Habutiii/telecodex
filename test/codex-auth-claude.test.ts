import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { setActiveAgent } from "../src/agent-state.js";
import {
  checkAuthStatus,
  clearAuthCache,
} from "../src/codex-auth.js";

function mockExecSuccess(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, stdout, stderr);
  });
}

function mockExecFailure(stderr: string, stdout = "", code?: string): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const error = new Error("Command failed") as Error & { stderr?: string; stdout?: string; code?: string };
    error.stderr = stderr;
    error.stdout = stdout;
    if (code) {
      error.code = code;
    }
    cb(error, stdout, stderr);
  });
}

describe("claude-auth", () => {
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    mockExecFile.mockReset();
    clearAuthCache();
    setActiveAgent("claude");
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    clearAuthCache();
    setActiveAgent("codex");
    vi.restoreAllMocks();
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }
  });

  it("reports authenticated when ANTHROPIC_API_KEY is provided", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";

    const status = await checkAuthStatus();

    expect(status.authenticated).toBe(true);
    expect(status.method).toBe("api-key");
    expect(status.detail).toContain("ANTHROPIC_API_KEY");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("reports authenticated when Claude CLI auth succeeds", async () => {
    mockExecSuccess(JSON.stringify({
      loggedIn: true,
      authMethod: "oauth",
      email: "user@example.com",
      subscriptionType: "max",
    }));

    const status = await checkAuthStatus();

    expect(status.authenticated).toBe(true);
    expect(status.method).toBe("cli");
    expect(status.detail).toContain("user@example.com");
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringContaining("claude"),
      ["auth", "status", "--json"],
      expect.objectContaining({ cwd: homedir() }),
      expect.any(Function),
    );
  });

  it("reports unauthenticated when Claude CLI says login is required", async () => {
    mockExecFailure("Not logged in");

    const status = await checkAuthStatus();

    expect(status.authenticated).toBe(false);
    expect(status.method).toBe("none");
    expect(status.detail).toContain("Not logged in");
  });

});
