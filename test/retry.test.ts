import { describe, expect, it, vi } from "vitest";

import { retryAsync } from "../src/retry.js";

describe("retryAsync", () => {
  it("retries retryable failures up to the configured limit", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    const result = await retryAsync(operation, {
      maxRetries: 3,
      delayMs: 0,
      shouldRetry: () => true,
      onRetry,
    });

    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]?.[0]).toBe(1);
    expect(onRetry.mock.calls[1]?.[0]).toBe(2);
  });

  it("stops immediately for non-retryable failures", async () => {
    const error = new Error("fatal");
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error);
    const onRetry = vi.fn();

    await expect(
      retryAsync(operation, {
        maxRetries: 3,
        delayMs: 0,
        shouldRetry: () => false,
        onRetry,
      }),
    ).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
