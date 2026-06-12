export interface RetryAsyncOptions {
  maxRetries: number;
  delayMs: number;
  shouldRetry: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => Promise<void> | void;
}

export async function retryAsync<T>(operation: () => Promise<T>, options: RetryAsyncOptions): Promise<T> {
  const maxRetries = Math.max(0, options.maxRetries);
  const delayMs = Math.max(0, options.delayMs);

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxRetries || !options.shouldRetry(error)) {
        throw error;
      }

      attempt += 1;
      await options.onRetry?.(attempt, error);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
