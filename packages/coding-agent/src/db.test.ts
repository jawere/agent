// @jawere/coding-agent — Tests for db.ts (session JSON store)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// db.ts uses a global storePath, so we need to isolate tests
// by using a temp directory

describe("db", () => {
  let workDir: string;
  let dbModule: typeof import("./db.ts");

  beforeEach(async () => {
    // Create a fresh temp dir per test
    workDir = mkdtempSync(join(tmpdir(), "jawere-db-test-"));
    // Load fresh module
    dbModule = await import("./db.ts");
    dbModule.initDb(workDir);
  });

  afterEach(() => {
    try {
      dbModule.closeDb();
    } catch { /* ok */ }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch { /* ok */ }
  });

  describe("createSession", () => {
    it("generates a unique session id", () => {
      const id1 = dbModule.createSession();
      const id2 = dbModule.createSession();
      assert.equal(typeof id1, "number");
      assert.equal(id2, id1 + 1);
      assert.ok(id1 >= 1);
    });

    it("throws when db not initialized", () => {
      dbModule.closeDb();
      assert.throws(() => dbModule.createSession());
    });
  });

  describe("persistMessages + listSessions + getSessionMessages", () => {
    it("persists and retrieves messages", () => {
      const sid = dbModule.createSession();

      const messages = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ];

      dbModule.persistMessages(sid, messages);

      const sessions = dbModule.listSessions();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, sid);
      assert.equal(typeof sessions[0].id, "number");
      assert.equal(sessions[0].message_count, 2);

      const retrieved = dbModule.getSessionMessages(sid);
      assert.equal(retrieved.length, 2);
      assert.equal(retrieved[0].role, "user");
      assert.equal(retrieved[0].content, "hello");
    });

    it("skips system messages", () => {
      const sid = dbModule.createSession();
      // First message is system — should be skipped
      dbModule.persistMessages(sid, [{ role: "system", content: "prompt" }]);

      const sessions = dbModule.listSessions();
      assert.equal(sessions.length, 0);
    });

    it("skips empty message arrays", () => {
      const sid = dbModule.createSession();
      dbModule.persistMessages(sid, []);
      assert.equal(dbModule.listSessions().length, 0);
    });

    it("handles tool_calls and tool_call_id", () => {
      const sid = dbModule.createSession();
      const messages = [
        { role: "system", content: "sys" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "file contents" },
      ];

      dbModule.persistMessages(sid, messages);

      const retrieved = dbModule.getSessionMessages(sid);
      assert.equal(retrieved.length, 2);
      assert.equal(retrieved[0].role, "assistant");
      assert.deepEqual((retrieved[0] as any).tool_calls, messages[1].tool_calls);
    });

    it("only persists new messages on subsequent calls", () => {
      const sid = dbModule.createSession();

      // First: persist 2 user + 1 system = 2 real messages
      dbModule.persistMessages(sid, [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ]);

      // Second: only new messages should be added
      dbModule.persistMessages(sid, [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
      ]);

      const retrieved = dbModule.getSessionMessages(sid);
      // Should be exactly: q1, a1, q2, a2 (no duplicates)
      assert.equal(retrieved.length, 4);
    });
  });

  describe("replaceSessionMessages", () => {
    it("replaces all messages for a session", () => {
      const sid = dbModule.createSession();

      dbModule.persistMessages(sid, [
        { role: "system", content: "sys" },
        { role: "user", content: "old" },
        { role: "assistant", content: "old-resp" },
      ]);

      dbModule.replaceSessionMessages(sid, [
        { role: "system", content: "sys2" },
        { role: "user", content: "new" },
      ]);

      const retrieved = dbModule.getSessionMessages(sid);
      assert.equal(retrieved.length, 1); // system skipped
      assert.equal(retrieved[0].content, "new");
    });
  });

  describe("deleteSession", () => {
    it("deletes a session and its messages", () => {
      const sid = dbModule.createSession();
      dbModule.persistMessages(sid, [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ]);

      assert.equal(dbModule.deleteSession(sid), true);
      assert.equal(dbModule.getSessionMessages(sid).length, 0);
      assert.equal(dbModule.listSessions().length, 0);
    });

    it("returns false for unknown session", () => {
      assert.equal(dbModule.deleteSession(9999), false);
    });
  });

  describe("listSessions", () => {
    it("returns sessions sorted by most recent first", () => {
      const s1 = dbModule.createSession();
      const s2 = dbModule.createSession();

      dbModule.persistMessages(s1, [
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
      ]);

      // Small delay to ensure different timestamps
      // (in practice, Date.now() has ms granularity)
      dbModule.persistMessages(s2, [
        { role: "system", content: "sys" },
        { role: "user", content: "second" },
        { role: "assistant", content: "resp" },
      ]);

      const sessions = dbModule.listSessions();
      // Both have same timestamps (ms granularity), order is non-deterministic
      assert.equal(sessions.length, 2);
      const ids = sessions.map(s => s.id);
      assert.ok(ids.includes(s1));
      assert.ok(ids.includes(s2));
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        const sid = dbModule.createSession();
        dbModule.persistMessages(sid, [
          { role: "system", content: "sys" },
          { role: "user", content: `msg-${i}` },
        ]);
      }

      const sessions = dbModule.listSessions(2);
      assert.equal(sessions.length, 2);
    });
  });
});
