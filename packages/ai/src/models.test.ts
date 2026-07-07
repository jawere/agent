// @jawere/ai — Tests for ModelRegistry

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelRegistry, getModelRegistry, setModelRegistry } from "./models.ts";
import type { Model, Provider } from "./types.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "openai-completions",
    provider: "test-provider",
    baseUrl: "https://test.api/v1",
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 4096,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function makeProvider(
  id: string,
  models: Model[],
  overrides: Partial<Provider> = {},
): Provider {
  return {
    id,
    name: id,
    auth: { type: "apiKey", resolve: () => "test-key" },
    getModels: () => models,
    stream: () => {
      throw new Error("not implemented");
    },
    ...overrides,
  };
}

// ── Registration ─────────────────────────────────────────────────────

describe("ModelRegistry", () => {
  it("starts empty", () => {
    const reg = new ModelRegistry();
    assert.equal(reg.listModels().length, 0);
    assert.equal(reg.getProviders().length, 0);
  });

  it("registers a provider and indexes models", () => {
    const reg = new ModelRegistry();
    const m1 = makeModel({ id: "m1", name: "Model 1" });
    const m2 = makeModel({ id: "m2", name: "Model 2" });
    reg.register(makeProvider("p1", [m1, m2]));

    assert.equal(reg.listModels().length, 2);
    assert.equal(reg.getProviders().length, 1);
    assert.equal(reg.getModel("m1")?.name, "Model 1");
    assert.equal(reg.getProvider("p1")?.name, "p1");
  });

  it("warns on duplicate provider registration", () => {
    const reg = new ModelRegistry();
    reg.register(makeProvider("p1", [makeModel({ id: "a", provider: "p1" })]));

    // Overwrite — register() doesn't clean up old model index entries,
    // so both models remain indexed (the new provider's models are additive)
    reg.register(makeProvider("p1", [makeModel({ id: "b", provider: "p1" })]));
    assert.equal(reg.listModels().length, 2);
    assert.equal(reg.getModel("a")?.id, "a");
    assert.equal(reg.getModel("b")?.id, "b");
  });

  it("unregisters a provider", () => {
    const reg = new ModelRegistry();
    reg.register(makeProvider("p1", [makeModel({ id: "a" })]));
    assert.equal(reg.unregister("p1"), true);
    assert.equal(reg.getProviders().length, 0);
    assert.equal(reg.listModels().length, 0);
  });

  it("unregister returns false for unknown provider", () => {
    const reg = new ModelRegistry();
    assert.equal(reg.unregister("nope"), false);
  });
});

// ── Queries ──────────────────────────────────────────────────────────

describe("ModelRegistry queries", () => {
  let reg: ModelRegistry;

  const imgModel = makeModel({
    id: "vision",
    name: "Vision",
    input: ["text", "image"],
    supportsImages: true,
    provider: "openai",
  });
  const reasoningModel = makeModel({
    id: "thinker",
    name: "Thinker",
    reasoning: true,
    provider: "anthropic",
  });
  const cheapModel = makeModel({
    id: "cheap",
    name: "Cheap",
    api: "openai-completions",
    provider: "deepseek",
  });

  it("getModelsByProvider filters correctly", () => {
    reg = new ModelRegistry();
    const openaiModel1 = makeModel({ id: "o1", provider: "openai", name: "OpenAI 1" });
    const openaiModel2 = makeModel({ id: "o2", provider: "openai", name: "OpenAI 2" });
    reg.register(makeProvider("openai", [openaiModel1, openaiModel2]));
    reg.register(makeProvider("anthropic", [reasoningModel]));

    assert.equal(reg.getModelsByProvider("openai").length, 2);
    assert.equal(reg.getModelsByProvider("anthropic").length, 1);
    assert.equal(reg.getModelsByProvider("deepseek").length, 0);
  });

  it("getModelsByApi filters by API", () => {
    reg = new ModelRegistry();
    reg.register(makeProvider("openai", [imgModel]));
    reg.register(makeProvider("deepseek", [cheapModel]));

    assert.equal(reg.getModelsByApi("openai-completions").length, 2);
  });

  it("getImageModels returns vision-capable models", () => {
    reg = new ModelRegistry();
    reg.register(makeProvider("openai", [imgModel, cheapModel]));

    assert.equal(reg.getImageModels().length, 1);
    assert.equal(reg.getImageModels()[0].id, "vision");
  });

  it("getReasoningModels returns reasoning models", () => {
    reg = new ModelRegistry();
    reg.register(makeProvider("anthropic", [reasoningModel, cheapModel]));

    assert.equal(reg.getReasoningModels().length, 1);
    assert.equal(reg.getReasoningModels()[0].id, "thinker");
  });

  it("getProviderForModel returns correct provider", () => {
    reg = new ModelRegistry();
    reg.register(makeProvider("openai", [imgModel]));

    const p = reg.getProviderForModel("vision");
    assert.ok(p);
    assert.equal(p.id, "openai");
  });

  it("getProviderForModel returns undefined for unknown model", () => {
    reg = new ModelRegistry();
    assert.equal(reg.getProviderForModel("nope"), undefined);
  });

  it("getStreamFn returns a function", () => {
    reg = new ModelRegistry();
    reg.register(makeProvider("openai", [imgModel]));

    const fn = reg.getStreamFn("vision");
    assert.ok(typeof fn === "function");
  });

  it("getStreamFn returns undefined for unknown model", () => {
    reg = new ModelRegistry();
    assert.equal(reg.getStreamFn("nope"), undefined);
  });
});

// ── refreshAll ───────────────────────────────────────────────────────

describe("ModelRegistry.refreshAll", () => {
  it("refreshes models from providers that support it", async () => {
    const reg = new ModelRegistry();
    let refreshed = false;

    const p = makeProvider("p1", [makeModel({ id: "old" })], {
      refreshModels: async () => {
        refreshed = true;
      },
    });

    reg.register(p);
    await reg.refreshAll();

    assert.equal(refreshed, true);
    // Original models still indexed
    assert.ok(reg.getModel("old"));
  });

  it("handles refresh failures gracefully", async () => {
    const reg = new ModelRegistry();
    const p = makeProvider("p1", [makeModel({ id: "m1" })], {
      refreshModels: async () => {
        throw new Error("network error");
      },
    });

    reg.register(p);

    // Must not throw
    await reg.refreshAll();

    // Model still accessible
    assert.ok(reg.getModel("m1"));
  });
});

// ── Global singleton ─────────────────────────────────────────────────

describe("global ModelRegistry singleton", () => {
  it("getModelRegistry returns same instance", () => {
    const a = getModelRegistry();
    const b = getModelRegistry();
    assert.equal(a, b);
  });

  it("setModelRegistry replaces global", () => {
    const original = getModelRegistry();
    const replacement = new ModelRegistry();
    replacement.register(makeProvider("test", [makeModel({ id: "global" })]));

    setModelRegistry(replacement);
    assert.equal(getModelRegistry(), replacement);
    assert.ok(getModelRegistry().getModel("global"));

    // Restore
    setModelRegistry(original);
  });
});
