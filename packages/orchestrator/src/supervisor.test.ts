// @jawere/orchestrator — Tests for Supervisor (instance CRUD)

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Supervisor } from "./supervisor.ts";

describe("Supervisor", () => {
  let workDir: string;
  let supervisor: Supervisor;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "jawere-orch-"));
    supervisor = new Supervisor({ instancesDir: workDir });
  });

  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  describe("createInstance", () => {
    it("creates an instance with a unique id", async () => {
      const inst = await supervisor.createInstance();
      assert.ok(inst.id.startsWith("jawere-"));
      assert.equal(inst.status, "stopped");
    });

    it("stores optional sessionId and model", async () => {
      const inst = await supervisor.createInstance({
        sessionId: "sess-1",
        model: "gpt-4o",
      });
      assert.equal(inst.sessionId, "sess-1");
      assert.equal(inst.model, "gpt-4o");
    });

    it("enforces maxInstances limit", async () => {
      const smallSup = new Supervisor({
        instancesDir: workDir,
        maxInstances: 2,
      });

      await smallSup.createInstance();
      await smallSup.createInstance();

      await assert.rejects(
        smallSup.createInstance(),
        /Max instances reached/,
      );
    });
  });

  describe("listInstances", () => {
    it("returns empty array initially", async () => {
      assert.deepEqual(await supervisor.listInstances(), []);
    });

    it("returns all created instances sorted by lastActive desc", async () => {
      const i1 = await supervisor.createInstance();
      const i2 = await supervisor.createInstance();

      const list = await supervisor.listInstances();
      assert.equal(list.length, 2);
      // Most recent first
      assert.equal(list[0].id, i2.id);
      assert.equal(list[1].id, i1.id);
    });
  });

  describe("getState", () => {
    it("returns instance by id", async () => {
      const inst = await supervisor.createInstance({ model: "claude" });
      const state = await supervisor.getState(inst.id);
      assert.ok(state);
      assert.equal(state.model, "claude");
    });

    it("returns undefined for unknown id", async () => {
      const state = await supervisor.getState("unknown");
      assert.equal(state, undefined);
    });
  });

  describe("removeInstance", () => {
    it("removes an instance", async () => {
      const inst = await supervisor.createInstance();
      await supervisor.removeInstance(inst.id);

      const list = await supervisor.listInstances();
      assert.equal(list.length, 0);
    });

    it("does not throw for non-existent instance", async () => {
      await supervisor.removeInstance("nope");
    });
  });

  describe("newSession", () => {
    it("clears sessionId", async () => {
      const inst = await supervisor.createInstance({ sessionId: "old" });
      await supervisor.newSession(inst.id);

      const state = await supervisor.getState(inst.id);
      assert.equal(state?.sessionId, undefined);
    });

    it("throws for unknown instance", async () => {
      await assert.rejects(
        supervisor.newSession("nope"),
        /Instance not found/,
      );
    });
  });

  describe("switchSession", () => {
    it("sets sessionId", async () => {
      const inst = await supervisor.createInstance();
      await supervisor.switchSession(inst.id, "new-session");

      const state = await supervisor.getState(inst.id);
      assert.equal(state?.sessionId, "new-session");
    });
  });

  describe("forkSession", () => {
    it("creates a new session id", async () => {
      const inst = await supervisor.createInstance();
      const newId = await supervisor.forkSession(inst.id, "original-session");

      assert.ok(newId.startsWith("fork-"));
      // sessionId.slice(0,12) = "original-ses" (12 chars from "original-session")
      assert.ok(newId.includes("original-ses"));

      const state = await supervisor.getState(inst.id);
      assert.equal(state?.sessionId, newId);
    });
  });

  describe("prompt", () => {
    it("throws not-implemented error", async () => {
      const inst = await supervisor.createInstance();
      await assert.rejects(
        supervisor.prompt(inst.id, "hello"),
        /Orchestrator RPC not yet implemented/,
      );
    });

    it("throws for unknown instance", async () => {
      await assert.rejects(
        supervisor.prompt("nope", "hello"),
        /Instance not found/,
      );
    });
  });
});
