// @jawere/agent — Tests for proxy.ts (ProxyMessageEventStream)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ProxyAssistantMessageEvent,
  ProxyStreamOptions,
} from "./proxy.ts";

// We test the ProxyMessageEventStream class directly
// (imported via the streamProxy module's internal class)
import { streamProxy } from "./proxy.ts";
import type { Model, Context } from "@jawere/ai";

// ── ProxyMessageEventStream (tested via streamProxy latency) ──────

// The ProxyMessageEventStream is an internal class used by streamProxy.
// We can't easily test streamProxy without a real server.
// Instead, we verify the type interface and basic structure.

describe("streamProxy", () => {
  it("exports as a function", () => {
    assert.equal(typeof streamProxy, "function");
  });

  it("returns an AsyncIterable with finalResult", () => {
    const model: Model = {
      id: "test",
      name: "test",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://test",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 4096,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    const context: Context = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ];

    const options: ProxyStreamOptions = {
      authToken: "test-token",
      proxyUrl: "https://localhost:9999",
    };

    const stream = streamProxy(model, context, options);

    // Should be an async iterable
    assert.ok(Symbol.asyncIterator in stream);
    // Should have finalResult
    assert.ok("finalResult" in stream);
  });
});
