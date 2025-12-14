export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 5000,
  backoffFactor: 2,
};

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
  "40001",
  "40P01",
]);

const RETRYABLE_MESSAGE_PATTERNS = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /connection refused/i,
  /connection reset/i,
  /network error/i,
  /socket hang up/i,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
];

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = (error as any).code;
  if (errorCode && RETRYABLE_ERROR_CODES.has(errorCode)) {
    return true;
  }

  const message = error.message;
  for (const pattern of RETRYABLE_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffFactor: number
): number {
  const delay = initialDelayMs * Math.pow(backoffFactor, attempt - 1);
  const jitter = Math.random() * 0.1 * delay;
  return Math.min(delay + jitter, maxDelayMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt === opts.maxAttempts) {
        throw error;
      }

      const delay = calculateDelay(
        attempt,
        opts.initialDelayMs,
        opts.maxDelayMs,
        opts.backoffFactor
      );

      await sleep(delay);
    }
  }

  throw lastError;
}
