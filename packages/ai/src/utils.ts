// @jawere/ai — Token estimation and retry utilities

import type { Usage } from "./types.ts";

// ── Token estimation ────────────────────────────────────────────────

/** Rough heuristic: 4 chars ≈ 1 token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateContextTokens(messages: { content?: unknown }[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as any[]) {
        if (block?.text) {
          total += estimateTokens(block.text);
        } else if (block?.arguments) {
          total += estimateTokens(block.arguments);
        } else if (block?.name) {
          total += 10; // overhead for tool call metadata
        }
      }
    }
  }
  return total;
}

export function getLastAssistantUsage(messages: { role: string; usage?: Usage }[]): Usage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].usage) {
      return messages[i].usage;
    }
  }
  return undefined;
}

// ── Retry logic ─────────────────────────────────────────────────────

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Retry only on these error substrings; empty = retry all */
  retryOn?: string[];
  signal?: AbortSignal;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryOn: [],
  signal: undefined as unknown as AbortSignal,
};

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    if (opts.signal?.aborted) {
      throw new Error("Aborted");
    }

    try {
      return await fn(attempt);
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt > opts.maxRetries) break;

      // Check if this error type should be retried
      if (opts.retryOn.length > 0) {
        const shouldRetry = opts.retryOn.some(
          (pattern) => lastError!.message.includes(pattern),
        );
        if (!shouldRetry) throw lastError;
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 1000,
        opts.maxDelayMs,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ── Truncation ──────────────────────────────────────────────────────

export function truncateOutput(
  output: string,
  maxBytes: number = 50000,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(output, "utf-8") <= maxBytes) {
    return { text: output, truncated: false };
  }

  // Truncate to maxBytes, preserving UTF-8 boundaries
  const buf = Buffer.from(output, "utf-8");
  let end = maxBytes;
  // Walk backward to find a valid UTF-8 boundary
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }

  const truncated = buf.slice(0, end).toString("utf-8");
  return { text: truncated, truncated: true };
}
