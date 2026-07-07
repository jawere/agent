// @jawere/coding-agent — Agent runner using @jawere/agent

import type { Model, Provider } from "@jawere/ai";
import {
  openAIProvider,
  deepseekProvider,
  anthropicProvider,
  googleGenerativeAIProvider,
  groqProvider,
  xAIProvider,
  mistralProvider,
  openRouterProvider,
} from "@jawere/ai";
import { Agent } from "@jawere/agent";
import type { AgentMessage, AgentEvent, StreamFn } from "@jawere/agent";
import { createAgentTools } from "./agent-tools.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import {
  createSpinner,
  type Spinner,
  writeToolLine,
  writeAssistantResponse,
  stripThinking,
} from "@jawere/tui";
import type { Config } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────

export interface RunAgentOptions {
  config: Config;
  sessionId?: string;
  history?: any[];
  signal?: AbortSignal;
}

export interface RunAgentResult {
  history: any[];
  allMessages: AgentMessage[];
}

// ── Build model from config ──────────────────────────────────────────

function buildModel(config: Config): Model {
  return {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: config.provider,
    baseUrl: config.baseURL,
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 4096,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

// ── Provider factory ──────────────────────────────────────────────────

function createProvider(config: Config): Provider {
  const { apiKey, baseURL, provider } = config;

  switch (provider) {
    case "openai":
      return openAIProvider(apiKey, baseURL);
    case "deepseek":
      return deepseekProvider(apiKey, baseURL);
    case "anthropic":
      return anthropicProvider(apiKey);
    case "google":
      return googleGenerativeAIProvider(apiKey);
    case "groq":
      return groqProvider(apiKey);
    case "xai":
      return xAIProvider(apiKey);
    case "mistral":
      return mistralProvider(apiKey);
    case "openrouter":
      return openRouterProvider(apiKey);
    case "custom":
    default:
      return openAIProvider(apiKey, baseURL);
  }
}

// ── Persistent Agent wrapper ─────────────────────────────────────────

export class PersistentAgent {
  private agent: Agent;
  private provider: Provider;
  private model: Model;
  private workDir: string;

  constructor(config: Config) {
    this.workDir = config.workDir;
    this.provider = createProvider(config);
    this.model = buildModel(config);
    const tools = createAgentTools(config.workDir);

    const streamFn: StreamFn = (m, ctx, opts) =>
      this.provider.stream(m, ctx, opts);

    this.agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model: this.model,
        tools,
        messages: [],
      },
      streamFn,
      toolExecution: "parallel",
    });
  }

  /** Subscribe to agent events for display */
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void {
    return this.agent.subscribe(listener);
  }

  /** Send a user message and wait for the agent to finish */
  async prompt(message: string, signal?: AbortSignal): Promise<void> {
    await this.agent.prompt(message);
  }

  /** Abort the current run */
  abort(): void {
    this.agent.abort();
  }

  /** Wait for agent to become idle */
  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
  }

  /** Get current messages */
  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }
}

// ── Display subscriber ───────────────────────────────────────────────

export interface DisplayState {
  spinner: Spinner;
  pendingToolArgs: Map<string, Record<string, unknown>>;
  toolCount: number;
}

export function createDisplaySubscriber(state: DisplayState) {
  return async (event: AgentEvent, _signal: AbortSignal): Promise<void> => {
    switch (event.type) {
      case "turn_start":
        state.pendingToolArgs = new Map();
        state.toolCount = 0;
        state.spinner.start("Thinking…");
        break;

      case "message_update":
        // Keep spinner going during streaming
        break;

      case "tool_execution_start":
        try {
          const args = typeof event.args === "string"
            ? JSON.parse(event.args as string)
            : (event.args ?? {});
          state.pendingToolArgs.set(event.toolCallId, args as Record<string, unknown>);
        } catch {
          state.pendingToolArgs.set(event.toolCallId, {});
        }
        break;

      case "tool_execution_end":
        state.spinner.stop();
        const args = state.pendingToolArgs.get(event.toolCallId) ?? {};
        state.pendingToolArgs.delete(event.toolCallId);
        writeToolLine(event.toolName, args, event.isError);
        state.toolCount++;
        break;

      case "turn_end":
        state.spinner.stop();
        const msg = event.message;
        const hasToolCalls = event.toolResults.length > 0 || state.toolCount > 0;

        if (!hasToolCalls && msg.role === "assistant" && msg.content) {
          const textBlocks = msg.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          const cleanText = stripThinking(textBlocks);
          if (cleanText.trim()) {
            writeAssistantResponse(cleanText);
          }
        }
        break;

      case "agent_end":
        state.spinner.stop();
        break;
    }
  };
}

// ── Main runner (kept for backward compat) ───────────────────────────

export async function runAgent(
  userMessage: string,
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const { config, sessionId, history: _rawHistory, signal } = options;

  const provider = createProvider(config);
  const model = buildModel(config);
  const tools = createAgentTools(config.workDir);

  const streamFn: StreamFn = (m, ctx, opts) =>
    provider.stream(m, ctx, opts);

  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      messages: [],
    },
    streamFn,
    toolExecution: "parallel",
    sessionId,
  });

  const displayState: DisplayState = {
    spinner: createSpinner(),
    pendingToolArgs: new Map(),
    toolCount: 0,
  };

  const unsub = agent.subscribe(createDisplaySubscriber(displayState));

  try {
    await agent.prompt(userMessage);
  } finally {
    unsub();
  }

  return {
    history: agent.state.messages as any[],
    allMessages: agent.state.messages,
  };
}
