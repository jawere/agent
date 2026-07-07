// @jawere/orchestrator — Supervisor: manages live agent instances

import { writeFile, readFile, unlink, mkdir, readdir } from "fs/promises";
import { resolve, join } from "path";
import { existsSync } from "fs";
import type {
  InstanceInfo,
  OrchestratorConfig,
  OrchestratorSupervisor,
} from "./types.ts";

const DEFAULT_CONFIG: OrchestratorConfig = {
  instancesDir: join(process.cwd(), ".jawere", "instances"),
  rpcTimeout: 30000,
  maxInstances: 10,
};

export class Supervisor implements OrchestratorSupervisor {
  private config: OrchestratorConfig;

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.config.instancesDir)) {
      await mkdir(this.config.instancesDir, { recursive: true });
    }
  }

  private instancePath(id: string): string {
    return resolve(this.config.instancesDir, `${id}.json`);
  }

  private async readInstance(id: string): Promise<InstanceInfo | undefined> {
    try {
      const data = await readFile(this.instancePath(id), "utf-8");
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  private async writeInstance(info: InstanceInfo): Promise<void> {
    await this.ensureDir();
    await writeFile(this.instancePath(info.id), JSON.stringify(info, null, 2));
  }

  async createInstance(options?: {
    sessionId?: string;
    model?: string;
  }): Promise<InstanceInfo> {
    await this.ensureDir();

    // Check instance limit
    const existing = await this.listInstances();
    if (existing.length >= this.config.maxInstances) {
      throw new Error(
        `Max instances reached (${this.config.maxInstances}). Remove an instance first.`,
      );
    }

    const id = `jawere-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const info: InstanceInfo = {
      id,
      status: "stopped",
      sessionId: options?.sessionId,
      model: options?.model,
      createdAt: now,
      lastActive: now,
    };

    await this.writeInstance(info);
    return info;
  }

  async listInstances(): Promise<InstanceInfo[]> {
    await this.ensureDir();

    try {
      const files = await readdir(this.config.instancesDir);
      const instances: InstanceInfo[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const instance = await this.readInstance(file.replace(".json", ""));
        if (instance) instances.push(instance);
      }

      return instances.sort(
        (a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime(),
      );
    } catch {
      return [];
    }
  }

  async removeInstance(id: string): Promise<void> {
    const path = this.instancePath(id);
    if (existsSync(path)) {
      await unlink(path);
    }
  }

  async getState(id: string): Promise<InstanceInfo | undefined> {
    return this.readInstance(id);
  }

  async prompt(
    id: string,
    message: string,
  ): Promise<{ messages: unknown[] }> {
    const instance = await this.readInstance(id);
    if (!instance) throw new Error(`Instance not found: ${id}`);

    // Update last active
    instance.lastActive = new Date().toISOString();
    instance.status = "running";
    await this.writeInstance(instance);

    // In the future, this would spawn a child process and communicate via RPC
    // For now, throw a descriptive error
    throw new Error(
      "Orchestrator RPC not yet implemented. Use the main jawere CLI for direct interaction.",
    );
  }

  async newSession(id: string): Promise<void> {
    const instance = await this.readInstance(id);
    if (!instance) throw new Error(`Instance not found: ${id}`);
    instance.sessionId = undefined;
    instance.sessionName = undefined;
    instance.lastActive = new Date().toISOString();
    await this.writeInstance(instance);
  }

  async switchSession(id: string, sessionId: string): Promise<void> {
    const instance = await this.readInstance(id);
    if (!instance) throw new Error(`Instance not found: ${id}`);
    instance.sessionId = sessionId;
    instance.lastActive = new Date().toISOString();
    await this.writeInstance(instance);
  }

  async forkSession(id: string, sessionId: string): Promise<string> {
    const instance = await this.readInstance(id);
    if (!instance) throw new Error(`Instance not found: ${id}`);
    const newSessionId = `fork-${sessionId.slice(0, 12)}-${Date.now().toString(36)}`;
    instance.sessionId = newSessionId;
    instance.lastActive = new Date().toISOString();
    await this.writeInstance(instance);
    return newSessionId;
  }
}
