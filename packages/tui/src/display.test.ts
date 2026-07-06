// @jawere/tui — Tests for display.ts (formatting functions)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatToolStart,
  formatToolEnd,
  stripThinking,
} from "./display.ts";

// ── Helpers ──────────────────────────────────────────────────────────

/** Strip ANSI escape sequences for plain-text assertion. */
function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── stripThinking ────────────────────────────────────────────────────

describe("stripThinking", () => {
  it("removes <think> tags (but keeps content between them)", () => {
    const input = "<think>reasoning here</think>actual response";
    const result = stripThinking(input);
    // tags stripped, content between tags remains
    assert.ok(!result.includes("<think>"));
    assert.ok(!result.includes("</think>"));
    assert.ok(result.includes("reasoning"));
    assert.ok(result.includes("actual response"));
  });

  it("removes <thinking> tags", () => {
    const input = "<thinking>some thoughts</thinking>answer";
    const result = stripThinking(input);
    assert.ok(!result.includes("<thinking>"));
    assert.ok(result.includes("some thoughts"));
    assert.ok(result.includes("answer"));
  });

  it("removes DeepSeek-style <|think|>...<|response|> blocks", () => {
    const input = "<|think|>chain of thought<|response|>final answer";
    const result = stripThinking(input);
    // The entire block including content is removed
    assert.ok(!result.includes("chain of thought"));
    assert.ok(result.includes("final answer"));
  });

  it("removes <tool_calls> XML blocks entirely", () => {
    const input = "text <tool_calls>...</tool_calls> more text";
    const result = stripThinking(input);
    assert.ok(!result.includes("<tool_calls>"));
    assert.ok(result.includes("text"));
    assert.ok(result.includes("more text"));
  });

  it("removes XML tool tags but keeps other content", () => {
    const input = "before <invoke name=\"read\"><parameter>stuff</parameter></invoke> after";
    const result = stripThinking(input);
    assert.ok(!result.includes("<invoke"));
    assert.ok(!result.includes("<parameter"));
    assert.ok(result.includes("stuff"));
    assert.ok(result.includes("before"));
    assert.ok(result.includes("after"));
  });

  it("collapses triple+ newlines", () => {
    const input = "line1\n\n\n\nline2";
    const result = stripThinking(input);
    assert.equal(result, "line1\n\nline2");
  });

  it("returns empty string unchanged", () => {
    assert.equal(stripThinking(""), "");
  });

  it("returns clean text unchanged", () => {
    const input = "This is a normal response with no thinking blocks.";
    assert.equal(stripThinking(input), input);
  });
});

// ── formatToolStart ──────────────────────────────────────────────────

describe("formatToolStart", () => {
  it("formats read with path (uses short path to avoid ANSI truncation)", () => {
    const result = formatToolStart("read", {
      path: "file.ts",
    });
    const p = plain(result);
    assert.ok(p.includes("read"));
    assert.ok(p.includes("file.ts"));
  });

  it("formats read with offset and limit", () => {
    // ANSI codes inflate the raw string length; use a very short path
    const result = formatToolStart("read", { path: "f", offset: 1, limit: 1 });
    const p = plain(result);
    assert.ok(p.includes("f"));
    assert.ok(p.includes("read"));
  });

  it("formats read with offset only", () => {
    const result = formatToolStart("read", { path: "f", offset: 1 });
    const p = plain(result);
    assert.ok(p.includes("f"));
    assert.ok(p.includes("read"));
  });

  it("formats read with limit only", () => {
    const result = formatToolStart("read", { path: "f", limit: 1 });
    const p = plain(result);
    assert.ok(p.includes("f"));
    assert.ok(p.includes("read"));
  });

  it("formats bash with command", () => {
    const result = formatToolStart("bash", {
      command: "npm run build",
    });
    const p = plain(result);
    assert.ok(p.includes("bash"));
    assert.ok(p.includes("npm run build"));
  });

  it("formats grep with pattern", () => {
    const result = formatToolStart("grep", {
      pattern: "function Agent",
    });
    const p = plain(result);
    assert.ok(p.includes("grep"));
    assert.ok(p.includes("function Agent"));
  });

  it("formats web_search with query", () => {
    const result = formatToolStart("web_search", {
      query: "ts 5.6",
    });
    const p = plain(result);
    assert.ok(p.includes("web_search"));
    assert.ok(p.includes("ts 5.6"));
  });

  it("truncates long lines to maxWidth", () => {
    const result = formatToolStart(
      "read",
      { path: "a".repeat(200) },
      { maxWidth: 200 },
    );
    const p = plain(result);
    // With large maxWidth, the visible text should be truncated somewhere
    assert.ok(p.length < 200);
    assert.ok(p.includes("read"));
  });

  it("shows just tool name when no args", () => {
    const result = formatToolStart("ls", {});
    const p = plain(result);
    assert.ok(p.includes("ls"));
  });
});

// ── formatToolEnd ────────────────────────────────────────────────────

describe("formatToolEnd", () => {
  it("shows checkmark for success", () => {
    const result = formatToolEnd("read", false);
    assert.ok(result.includes("read"));
    assert.ok(result.includes("✓"));
  });

  it("shows cross for error", () => {
    const result = formatToolEnd("write", true);
    assert.ok(result.includes("write"));
    assert.ok(result.includes("✗"));
  });
});
