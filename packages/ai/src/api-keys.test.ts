// @jawere/ai — Tests for KeyResolver

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { KeyResolver } from "./api-keys.ts";

describe("KeyResolver", () => {
  let resolver: KeyResolver;

  beforeEach(() => {
    resolver = new KeyResolver({ cacheTtlMs: 0 }); // no caching for tests
  });

  // ── Env var resolution ──────────────────────────────────────────

  it("resolves $VAR from env", async () => {
    process.env.TEST_KEY_1 = "secret123";
    const result = await resolver.resolve("$TEST_KEY_1");
    assert.equal(result.value, "secret123");
    assert.equal(result.cached, false);
    delete process.env.TEST_KEY_1;
  });

  it("returns fallback when env var not set", async () => {
    const result = await resolver.resolve("$NONEXISTENT_VAR|myfallback");
    assert.equal(result.value, "myfallback");
  });

  it("throws when env var not set and no fallback", async () => {
    await assert.rejects(
      resolver.resolve("$NONEXISTENT_VAR"),
      /Failed to resolve/,
    );
  });

  it("throws when env var is empty", async () => {
    process.env.TEST_EMPTY = "";
    await assert.rejects(resolver.resolve("$TEST_EMPTY"), /Failed to resolve/);
    delete process.env.TEST_EMPTY;
  });

  // ── Raw value resolution ────────────────────────────────────────

  it("resolves raw values directly", async () => {
    const result = await resolver.resolve("literal-key");
    assert.equal(result.value, "literal-key");
    assert.equal(result.cached, false);
  });

  // ── Command resolution ──────────────────────────────────────────

  it("resolves !command via shell", async () => {
    const result = await resolver.resolve("!echo test-output");
    assert.equal(result.value, "test-output");
  });

  it("takes only first line of command output", async () => {
    const result = await resolver.resolve("!printf 'line1\\nline2'");
    assert.equal(result.value, "line1");
  });

  it("throws when command produces no output", async () => {
    await assert.rejects(
      resolver.resolve("!echo -n ''"),
      /Command produced no output/,
    );
  });

  it("throws on command timeout", async () => {
    const kr = new KeyResolver({ commandTimeoutMs: 50 });
    await assert.rejects(
      kr.resolve("!sleep 5"),
      /Command failed/,
    );
  });

  // ── File resolution ─────────────────────────────────────────────

  it("resolves file: prefix", async () => {
    const { writeFile, unlink } = await import("node:fs/promises");
    const path = "/tmp/jawere-test-key-file";
    await writeFile(path, "file-secret\n");
    try {
      const result = await resolver.resolve(`file:${path}`);
      assert.equal(result.value, "file-secret");
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it("throws for missing file", async () => {
    await assert.rejects(
      resolver.resolve("file:/tmp/nonexistent-key-file-12345"),
      /File read failed/,
    );
  });

  // ── Cache ───────────────────────────────────────────────────────

  it("caches resolved keys", async () => {
    const kr = new KeyResolver({ cacheTtlMs: 60000 });
    process.env.TEST_CACHED = "cached-val";
    const r1 = await kr.resolve("$TEST_CACHED");
    assert.equal(r1.cached, false);

    const r2 = await kr.resolve("$TEST_CACHED");
    assert.equal(r2.cached, true);
    assert.equal(r2.value, "cached-val");
    delete process.env.TEST_CACHED;
  });

  it("invalidate removes specific cached key", async () => {
    const kr = new KeyResolver({ cacheTtlMs: 60000 });
    process.env.TEST_INV = "will-be-invalidated";
    await kr.resolve("$TEST_INV");
    kr.invalidate("$TEST_INV");

    delete process.env.TEST_INV;
    // Now it should fail since cache is cleared and env var is gone
    await assert.rejects(kr.resolve("$TEST_INV"), /Failed to resolve/);
  });

  it("clearCache removes all cached keys", async () => {
    const kr = new KeyResolver({ cacheTtlMs: 60000 });
    process.env.TEST_C1 = "v1";
    await kr.resolve("$TEST_C1");
    kr.clearCache();

    const r = await kr.resolve("$TEST_C1");
    assert.equal(r.cached, false);
    delete process.env.TEST_C1;
  });

  // ── resolveFirst ────────────────────────────────────────────────

  it("resolveFirst returns first successful source", async () => {
    process.env.TEST_FIRST = "primary";
    const result = await resolver.resolveFirst(["$TEST_FIRST", "$TEST_FALLBACK"]);
    assert.equal(result.value, "primary");
    delete process.env.TEST_FIRST;
  });

  it("resolveFirst falls back to next source", async () => {
    process.env.TEST_FALLBACK = "fallback";
    const result = await resolver.resolveFirst([
      "$NONEXISTENT_1",
      "$NONEXISTENT_2",
      "$TEST_FALLBACK",
    ]);
    assert.equal(result.value, "fallback");
    delete process.env.TEST_FALLBACK;
  });

  it("resolveFirst throws when all sources fail", async () => {
    await assert.rejects(
      resolver.resolveFirst(["$NOPE_1", "$NOPE_2"]),
      /All key sources failed/,
    );
  });
});
