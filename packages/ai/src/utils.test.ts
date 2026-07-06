// @jawere/ai — Tests for utils.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateContextTokens,
  getLastAssistantUsage,
  truncateOutput,
  withRetry,
} from "./utils.ts";

// ── estimateTokens ──────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("estimates ~4 chars per token", () => {
    // 40 chars → ceil(40/4) = 10
    assert.equal(estimateTokens("1234567890123456789012345678901234567890"), 10);
  });

  it("rounds up for remainder", () => {
    assert.equal(estimateTokens("abc"), 1); // ceil(3/4) = 1
    assert.equal(estimateTokens("abcde"), 2); // ceil(5/4) = 2
  });

  it("handles unicode (counts bytes, not code points)", () => {
    const result = estimateTokens("🚀🌍");
    assert.ok(result >= 1);
  });
});

// ── estimateContextTokens ───────────────────────────────────────────

describe("estimateContextTokens", () => {
  it("returns 0 for empty array", () => {
    assert.equal(estimateContextTokens([]), 0);
  });

  it("sums tokens from string content", () => {
    const msgs = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there" },
    ];
    // "Hello world" = 11 chars → ceil(11/4) = 3
    // "Hi there" = 8 chars → ceil(8/4) = 2
    // Total = 5
    assert.equal(estimateContextTokens(msgs), 5);
  });

  it("handles content blocks array", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "toolCall", name: "read", arguments: "{}" },
        ],
      },
    ];
    // "Hello" = 5 chars → 2 tokens + "{}" = 2 chars → 1 token
    // (the code checks text → arguments → name in order, only picks first match per block)
    assert.equal(estimateContextTokens(msgs), 3);
  });

  it("skips messages without content", () => {
    assert.equal(estimateContextTokens([{ role: "system" }]), 0);
  });
});

// ── getLastAssistantUsage ───────────────────────────────────────────

describe("getLastAssistantUsage", () => {
  const sampleUsage = {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  it("returns last assistant usage", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello", usage: { ...sampleUsage, totalTokens: 100 } },
      { role: "user", content: "ok" },
      { role: "assistant", content: "bye", usage: sampleUsage },
    ];
    assert.deepEqual(getLastAssistantUsage(msgs), sampleUsage);
  });

  it("returns undefined when no assistant has usage", () => {
    assert.equal(getLastAssistantUsage([{ role: "user", content: "hi" }]), undefined);
  });

  it("skips assistants without usage", () => {
    const msgs = [
      { role: "assistant", content: "hi" },
      { role: "assistant", content: "bye", usage: sampleUsage },
    ];
    assert.deepEqual(getLastAssistantUsage(msgs), sampleUsage);
  });
});

// ── truncateOutput ──────────────────────────────────────────────────

describe("truncateOutput", () => {
  it("returns text unchanged when under limits", () => {
    const result = truncateOutput("short", 100000);
    assert.equal(result.text, "short");
    assert.equal(result.truncated, false);
  });

  it("truncates long output", () => {
    const long = "a".repeat(60000);
    const result = truncateOutput(long, 50000);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text, "utf-8") <= 50000);
  });

  it("preserves UTF-8 boundaries", () => {
    const text = "🚀".repeat(20000); // each is 4 bytes
    const result = truncateOutput(text, 40000);
    // Should not have broken surrogate pairs
    assert.equal(result.truncated, true);
    assert.doesNotThrow(() => Buffer.from(result.text, "utf-8").toString("utf-8"));
  });
});

// ── withRetry ───────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(async () => 42);
    assert.equal(result, 42);
  });

  it("retries on failure and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "ok";
      },
      { baseDelayMs: 1, maxRetries: 3 },
    );
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("throws after max retries", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("always fail");
        },
        { baseDelayMs: 1, maxRetries: 2 },
      ),
      /always fail/,
    );
    assert.equal(calls, 3); // initial + 2 retries
  });

  it("respects retryOn filter", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("permanent failure");
        },
        { baseDelayMs: 1, retryOn: ["retriable"] },
      ),
      /permanent failure/,
    );
    assert.equal(calls, 1); // no retry — error doesn't match retryOn
  });

  it("retries when error matches retryOn", async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error("this is retriable");
        },
        { baseDelayMs: 1, maxRetries: 2, retryOn: ["retriable"] },
      ),
      /retriable/,
    );
    assert.equal(calls, 3);
  });

  it("aborts on signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      withRetry(async () => "ok", { signal: ctrl.signal }),
      /Aborted/,
    );
  });
});
