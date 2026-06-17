import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import {
  checkAuthStatus,
  checkAuthStatusWithRetry,
  clearAuthCache,
} from "../src/codex-auth.js";

// Helper to make mockExecFile call its callback with success
function mockExecSuccess(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, stdout, stderr);
  });
}

// Helper to make mockExecFile call its callback with a non-zero exit error
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

// Helper to make mockExecFile throw (ENOENT — command not found)
function mockExecNotFound(): void {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    const error = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    cb(error, "", "");
  });
}

describe("codex-auth", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    clearAuthCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkAuthStatus", () => {
    it("reports authenticated when API key is provided", async () => {
      const status = await checkAuthStatus("sk-test-key");
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("api-key");
      expect(status.detail).toContain("CODEX_API_KEY");
      // Should not call CLI when API key is present
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("reports authenticated when CLI auth succeeds", async () => {
      mockExecSuccess("Logged in as user@example.com");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("cli");
      expect(status.detail).toContain("user@example.com");
      expect(mockExecFile).toHaveBeenCalledWith(
        "codex",
        ["login", "status"],
        expect.objectContaining({ cwd: homedir() }),
        expect.any(Function),
      );
    });

    it("reports unauthenticated when CLI auth fails", async () => {
      mockExecFailure("Not logged in");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(status.detail).toContain("Not logged in");
    });

    it("reports unknown when the auth probe fails for a non-auth reason", async () => {
      mockExecFailure("Error loading configuration: No such file or directory (os error 2)");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("unknown");
      expect(status.detail).toContain("Error loading configuration");
    });

    it("reports unauthenticated when CLI is not found", async () => {
      mockExecNotFound();

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(status.detail).toContain("not found");
    });

    it("handles command timeout (signal termination)", async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const error = new Error("Command timed out") as Error & { signal?: string; stderr?: string; stdout?: string };
        error.signal = "SIGTERM";
        error.stderr = "";
        error.stdout = "";
        cb(error, "", "");
      });

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("unknown");
      expect(status.detail).toContain("SIGTERM");
    });

    it("handles empty CLI output gracefully", async () => {
      mockExecSuccess("");

      const status = await checkAuthStatus();
      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("cli");
      expect(status.detail).toBe("Authenticated via Codex CLI");
    });

    it("caches results across calls", async () => {
      mockExecSuccess("Logged in");

      const first = await checkAuthStatus();
      const second = await checkAuthStatus();

      expect(first).toEqual(second);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("does not cache unauthenticated results", async () => {
      mockExecFailure("Not logged in");

      const first = await checkAuthStatus();
      const second = await checkAuthStatus();

      expect(first.authenticated).toBe(false);
      expect(second.authenticated).toBe(false);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("recovers immediately after a transient failure", async () => {
      mockExecFailure("Command terminated with signal SIGTERM.");
      const first = await checkAuthStatus();

      mockExecSuccess("Logged in as user@example.com");
      const second = await checkAuthStatus();

      expect(first.authenticated).toBe(false);
      expect(second.authenticated).toBe(true);
      expect(second.detail).toContain("user@example.com");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("refreshes after clearAuthCache", async () => {
      mockExecSuccess("Logged in");
      await checkAuthStatus();

      clearAuthCache();
      mockExecSuccess("Still logged in");
      await checkAuthStatus();

      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("retries silently before returning a final unauthenticated result", async () => {
      mockExecFailure("Not logged in");

      const status = await checkAuthStatusWithRetry(undefined, { attempts: 2, delayMs: 0 });

      expect(status.authenticated).toBe(false);
      expect(status.method).toBe("none");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it("recovers during the silent retry window", async () => {
      mockExecFile.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const error = new Error("Command failed") as Error & { stderr?: string; stdout?: string };
        error.stderr = "Not logged in";
        error.stdout = "";
        cb(error, "", "Not logged in");
      });
      mockExecSuccess("Logged in as user@example.com");

      const status = await checkAuthStatusWithRetry(undefined, { attempts: 2, delayMs: 0 });

      expect(status.authenticated).toBe(true);
      expect(status.method).toBe("cli");
      expect(status.detail).toContain("user@example.com");
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });
});
