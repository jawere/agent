// @jawere/orchestrator — RPC process management (spawn child agent processes)

import { ChildProcess, spawn } from "child_process";
import { randomBytes } from "crypto";
import type { RpcRequest, RpcResponse } from "./types.ts";

export interface RpcProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export class RpcProcess {
  private process: ChildProcess | null = null;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private buffer = "";
  private options: RpcProcessOptions;
  private timeout: number;

  constructor(options: RpcProcessOptions) {
    this.options = options;
    this.timeout = options.timeout ?? 30000;
  }

  start(): void {
    if (this.process) return;

    this.process = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      // Forward stderr to parent for debugging
      process.stderr.write(`[rpc-child stderr] ${data.toString()}`);
    });

    this.process.on("exit", (code) => {
      // Reject all pending requests
      for (const [, { reject }] of this.pending) {
        reject(new Error(`Child process exited with code ${code}`));
      }
      this.pending.clear();
      this.process = null;
    });
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.process) {
      this.start();
    }

    const id = randomBytes(8).toString("hex");
    const request: RpcRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC call timed out: ${method}`));
      }, this.timeout);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.process!.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response: RpcResponse = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (pending) {
          this.pending.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }
}
