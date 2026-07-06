// @jawere/ai — Tests for EventStream

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventStream, createAssistantEventStream } from "./event-stream.ts";
import type { AssistantMessageEvent } from "./types.ts";

// ── Basic EventStream ────────────────────────────────────────────────

describe("EventStream", () => {
  it("iterates over pushed events", async () => {
    const stream = new EventStream<number, string>(
      (e) => e === -1,
      (e) => `final:${e}`,
    );

    stream.push(1);
    stream.push(2);
    stream.push(3);
    stream.push(-1); // terminal

    const results: number[] = [];
    for await (const v of stream) {
      results.push(v);
    }

    assert.deepEqual(results, [1, 2, 3, -1]);
    assert.equal(await stream.finalResult, "final:-1");
  });

  it("resolves finalResult from terminal event", async () => {
    const stream = new EventStream<number, number>(
      (e) => e >= 10,
      (e) => e * 2,
    );

    stream.push(1);
    stream.push(10);

    const result = await stream.finalResult;
    assert.equal(result, 20);
  });

  it("supports multiple consumers via async iterator", async () => {
    const stream = new EventStream<string, string>(
      (e) => e === "done",
      (e) => e,
    );

    const collect = async () => {
      const items: string[] = [];
      for await (const v of stream) items.push(v);
      return items;
    };

    const promise = collect();
    stream.push("a");
    stream.push("b");
    stream.push("done");

    const items = await promise;
    assert.deepEqual(items, ["a", "b", "done"]);
  });

  it("end() without result finishes iteration", async () => {
    const stream = new EventStream<number, number>(
      (e) => e === -1,
      (e) => e,
    );

    stream.push(1);
    stream.end();

    const results: number[] = [];
    for await (const v of stream) {
      results.push(v);
    }

    assert.deepEqual(results, [1]);
  });

  it("end() with result sets finalResult", async () => {
    const stream = new EventStream<number, string>(
      (e) => e === -1,
      (e) => `value:${e}`,
    );

    stream.push(1);
    stream.end("explicit");

    // Drain iterator
    for await (const _ of stream) { /* noop */ }

    assert.equal(await stream.finalResult, "explicit");
  });

  it("does not push after terminal event", async () => {
    const stream = new EventStream<number, string>(
      (e) => e === -1,
      (e) => "done",
    );

    stream.push(1);
    stream.push(-1); // terminal
    stream.push(2); // should be ignored
    stream.push(3); // should be ignored

    const results: number[] = [];
    for await (const v of stream) {
      results.push(v);
    }

    assert.deepEqual(results, [1, -1]);
  });

  it("handles late consumer (buffers events)", async () => {
    const stream = new EventStream<number, string>(
      (e) => e === 0,
      (e) => "zero",
    );

    stream.push(1);
    stream.push(2);
    stream.push(0);

    // Now consume
    const results: number[] = [];
    for await (const v of stream) {
      results.push(v);
    }

    assert.deepEqual(results, [1, 2, 0]);
  });
});

// ── createAssistantEventStream ───────────────────────────────────────

describe("createAssistantEventStream", () => {
  it("yields assistant message events", async () => {
    const stream = createAssistantEventStream();

    stream.push({ type: "message_start", messageId: "msg-1" });
    stream.push({ type: "message_delta", delta: "hello", messageId: "msg-1" });
    stream.push({ type: "message_end", stopReason: "stop", usage: undefined });

    const events: AssistantMessageEvent[] = [];
    for await (const evt of stream) {
      events.push(evt);
    }

    assert.equal(events.length, 3);
    assert.equal(events[0].type, "message_start");
    assert.equal(events[1].type, "message_delta");
    assert.equal(events[2].type, "message_end");
  });

  it("finalResult resolves to AssistantMessage on message_end", async () => {
    const stream = createAssistantEventStream();

    stream.push({ type: "message_start", messageId: "m1" });
    stream.push({
      type: "message_end",
      stopReason: "end_turn",
      usage: {
        input: 50,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 70,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      model: "test-model",
    });

    // Drain
    for await (const _ of stream) { /* noop */ }

    const result = await stream.finalResult;
    assert.equal(result.role, "assistant");
    assert.equal(result.stopReason, "end_turn");
  });

  it("finalResult resolves to error on error event", async () => {
    const stream = createAssistantEventStream();

    stream.push({ type: "error", message: "API error" });

    for await (const _ of stream) { /* noop */ }

    const result = await stream.finalResult;
    assert.equal(result.role, "assistant");
    assert.equal(result.stopReason, "error");
  });
});
