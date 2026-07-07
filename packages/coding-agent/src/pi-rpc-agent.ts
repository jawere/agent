// @jawere/coding-agent — PiRpcAgent: spawns user's Pi binary in RPC mode
// Communicates via JSONL (stdin/stdout). Handles the full agent loop via Pi's battle-tested runtime.

import { spawn, type ChildProcess } from "child_process";
import type { Config } from "./config.js";

// ── Pi slash command (from get_commands RPC) ──

/** A command available from Pi for / autocomplete */
export interface PiSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

// ── Types (matches Pi's types from @earendil-works/pi-agent-core) ──

// ── Extension UI types (matches Pi's RpcExtensionUIRequest/RpcExtensionUIResponse) ──

/** Extension UI request from Pi (needs user interaction) */
export interface ExtensionUIRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
}

/** Response sent back to Pi for an extension UI request */
export interface ExtensionUIResponse {
  type: "extension_ui_response";
  id: string;
  value?: string;
  confirmed?: boolean;
  cancelled?: true;
}

/** Handler called when Pi needs user interaction. Returns response to send back, or null for fire-and-forget methods. */
export type ExtensionUIHandler = (request: ExtensionUIRequest) => Promise<ExtensionUIResponse | null>;

// ── Agent event types ──

/** Content block within a message (text or tool call/result) */
export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** A message in the agent conversation */
export interface AgentMessage {
  role: string;
  content: string | ContentBlock[];
  [key: string]: unknown;
}

/** Tool result message */
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError?: boolean;
}

/** Assistant message event from streaming */
export interface AssistantMessageEvent {
  type: string;
  partial?: AgentMessage;
}

/**
 * Agent events emitted by Pi on stdout.
 * These match Pi's AgentEvent type from @earendil-works/pi-agent-core exactly.
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

// ── PiRpcAgent ────────────────────────────────────────────────────────

/** Listener for agent events from Pi's stdout. */
export type AgentEventListener = (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;

export class PiRpcAgent {
  private process: ChildProcess | null = null;
  private buffer = "";
  private requestId = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners: Array<AgentEventListener> = [];
  private stderr = "";
  private exited = false;
  private exitError: Error | null = null;

  private config: Config;
  private extensionUIHandler: ExtensionUIHandler | null = null;

  constructor(config: Config, extensionUIHandler?: ExtensionUIHandler) {
    this.config = config;
    if (extensionUIHandler) this.extensionUIHandler = extensionUIHandler;
  }

  /** Set or replace the handler for extension UI requests */
  setExtensionUIHandler(handler: ExtensionUIHandler): void {
    this.extensionUIHandler = handler;
  }

  // ── Public API (matches PersistentAgent) ──────────────────────────

  /** Subscribe to agent events (turn_start, tool_execution_*, turn_end, agent_end) */
  subscribe(listener: AgentEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  /** Send a user prompt. Returns immediately — events stream asynchronously. */
  async prompt(message: string, signal?: AbortSignal): Promise<void> {
    await this.ensureStarted();
    const response = await this.send({ type: "prompt", message });
    const data = this.getData(response);
    // prompt response is just { success: true }
  }

  /** Abort the current agent run */
  async abort(): Promise<void> {
    if (!this.process) return;
    try {
      await this.send({ type: "abort" });
    } catch { /* ignore if process died */ }
  }

  /** Wait for the agent to finish processing (agent_end event) */
  waitForIdle(timeout = 600000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error("Timeout waiting for agent to become idle"));
      }, timeout);

      const unsub = this.subscribe((event) => {
        if (event.type === "agent_end") {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
  }

  /** Get current messages from Pi session */
  async getMessages(): Promise<AgentMessage[]> {
    if (!this.process) return [];
    const response = await this.send({ type: "get_messages" });
    const data = this.getData<{ messages: AgentMessage[] }>(response);
    return data.messages ?? [];
  }

  /** Get available slash commands from Pi (extensions, prompt templates, skills) */
  async getCommands(): Promise<PiSlashCommand[]> {
    if (!this.process) return [];
    try {
      const response = await this.send({ type: "get_commands" });
      const data = this.getData<{ commands: PiSlashCommand[] }>(response);
      return data.commands ?? [];
    } catch {
      return []; // Pi may not support get_commands yet
    }
  }

  /** Stop the Pi process */
  stop(): void {
    if (this.process) {
      // Clear pending
      for (const [, p] of this.pending) {
        p.reject(new Error("Agent stopped"));
      }
      this.pending.clear();

      this.process.kill("SIGTERM");
      // Force kill after 2s
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill("SIGKILL");
        }
      }, 2000);
      this.process = null;
    }
  }

  /** Get collected stderr (for debugging) */
  getStderr(): string {
    return this.stderr;
  }

  // ── RPC internals ──────────────────────────────────────────────────

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.exited) return;

    this.buffer = "";
    this.requestId = 0;
    this.pending.clear();
    this.stderr = "";
    this.exited = false;
    this.exitError = null;

    const piPath = "pi"; // resolved at startup by pi-resolver.ts
    const args = [
      "--mode", "rpc",
      "--provider", this.config.provider,
      "--model", this.config.model,
      "--thinking", this.config.thinkingLevel || "medium",
    ];

    // Pass API key via env (Pi reads provider-specific or AI_API_KEY)
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (this.config.apiKey) {
      env.AI_API_KEY = this.config.apiKey;
      // Also set provider-specific key so Pi's KeyResolver picks it up
      const providerUpper = this.config.provider.toUpperCase();
      env[`${providerUpper}_API_KEY`] = this.config.apiKey;
    }

    this.process = spawn(piPath, args, {
      cwd: this.config.workDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      this.stderr += data.toString();
      // Forward to parent stderr for visibility
      process.stderr.write(data);
    });

    this.process.on("error", (err) => {
      this.exitError = new Error(`Pi process error: ${err.message}`);
      this.rejectAll(this.exitError);
    });

    this.process.on("exit", (code) => {
      this.exited = true;
      if (code !== 0 && !this.exitError) {
        this.exitError = new Error(`Pi exited with code ${code}. stderr: ${this.stderr.slice(-500)}`);
      }
      this.rejectAll(this.exitError ?? new Error("Pi process exited"));
      this.process = null;
    });

    // Wait briefly for process to start
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  private async send(command: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; error?: string }> {
    if (!this.process || this.exited) {
      throw this.exitError ?? new Error("Pi process not running");
    }

    const id = `j_${++this.requestId}`;
    const fullCmd = { ...command, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${command.type}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as any); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      try {
        this.process!.stdin!.write(JSON.stringify(fullCmd) + "\n");
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private getData<T>(response: { success: boolean; data?: unknown; error?: string }): T {
    if (!response.success) {
      throw new Error(response.error ?? "Unknown RPC error");
    }
    return (response.data ?? {}) as T;
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line);
      } catch {
        continue; // skip malformed JSON
      }

      // Responses have type="response" and an id matching a pending request
      if (data.type === "response" && typeof data.id === "string") {
        const pending = this.pending.get(data.id as string);
        if (pending) {
          this.pending.delete(data.id as string);
          pending.resolve(data);
        }
        continue;
      }

      // Extension UI requests — route to handler, NOT broadcast as agent events
      if (data.type === "extension_ui_request") {
        this.handleExtensionUIRequest(data as unknown as ExtensionUIRequest);
        continue;
      }

      // Everything else is an agent event — broadcast to listeners
      const event = data as unknown as AgentEvent;
      for (const listener of this.listeners) {
        try {
          const signal = new AbortController().signal;
          listener(event, signal);
        } catch {
          // Don't let one bad listener break others
        }
      }
    }
  }

  /** Handle an extension UI request: call handler, write response back to Pi stdin */
  private handleExtensionUIRequest(request: ExtensionUIRequest): void {
    const handler = this.extensionUIHandler;
    if (!handler) {
      // No handler registered — auto-cancel the request
      this.writeResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
      return;
    }

    // Call handler asynchronously, with optional timeout
    const timeout = request.timeout ?? 30000;
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => {
        this.writeResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
        resolve(null);
      }, timeout),
    );

    Promise.race([handler(request), timeoutPromise]).then((response) => {
      if (response) {
        this.writeResponse(response);
      }
      // null responses are for fire-and-forget methods (notify, setStatus, etc.)
    });
  }

  /** Write a response line to Pi's stdin */
  private writeResponse(response: ExtensionUIResponse | Record<string, unknown>): void {
    try {
      if (this.process?.stdin?.writable && !this.exited) {
        this.process.stdin.write(JSON.stringify(response) + "\n");
      }
    } catch {
      // Process may have died — ignore write errors
    }
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }
}
