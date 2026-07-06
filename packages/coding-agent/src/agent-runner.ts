// @jawere/coding-agent — Agent-based runner (wired to @jawere/agent + @jawere/ai providers)

import type { Model, Provider } from "@jawere/ai";
import { openAIProvider } from "@jawere/ai";
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
  history: AgentMessage[];
  signal?: AbortSignal;
}

export interface RunAgentResult {
  history: any[];
  /** Full AgentMessage[] for session persistence */
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

/**
 * Create a Provider using @jawere/ai's built-in provider implementations.
 * Selects the correct provider based on config.provider.
 * All providers accept (apiKey?, baseURL?) constructor signature.
 */
function createProvider(config: Config): Provider {
  return openAIProvider(config.apiKey, config.baseURL);
}

// ── Streaming display ─────────────────────────────────────────────────

interface DisplayState {
  spinner: Spinner;
  streamedText: string[];
  nativeToolCalls: Map<number, { id: string; name: string; arguments: string }>;
  hasStarted: boolean;
  /** Buffer toolCallId → args so we can write the full line on tool_execution_end */
  pendingToolArgs: Map<string, Record<string, unknown>>;
}

/**
 * Subscribe to Agent events and drive terminal display.
 * Mirrors the legacy agent-runner display behavior:
 * - Spinner during streaming
 * - Tool call lines with checkmarks
 * - Assistant text on final turn
 */
function createDisplaySubscriber(state: DisplayState) {
  return async (event: AgentEvent, _signal: AbortSignal): Promise<void> => {
    switch (event.type) {
      case "turn_start":
        state.streamedText = [];
        state.nativeToolCalls = new Map();
        state.pendingToolArgs = new Map();
        state.hasStarted = false;
        state.spinner.start("Thinking…");
        break;

      case "message_update": {
        // Silently accumulate streaming text — never shown to user
        const msg = event.message;
        if (msg.role === "assistant" && msg.content) {
          for (const block of msg.content) {
            if (block.type === "text") {
              state.streamedText.push(block.text);
            }
          }
          state.hasStarted = true;
        }
        break;
      }

      case "tool_execution_start": {
        // Buffer args so we can write a full line on tool_execution_end
        try {
          const args = typeof event.args === "string"
            ? JSON.parse(event.args as string)
            : (event.args ?? {});
          state.pendingToolArgs.set(event.toolCallId, args as Record<string, unknown>);
        } catch {
          state.pendingToolArgs.set(event.toolCallId, {});
        }
        break;
      }

      case "tool_execution_end": {
        // Write complete tool line atomically: name, detail, checkmark
        state.spinner.stop();
        const args = state.pendingToolArgs.get(event.toolCallId) ?? {};
        state.pendingToolArgs.delete(event.toolCallId);
        writeToolLine(event.toolName, args, event.isError);
        break;
      }

      case "turn_end": {
        state.spinner.stop();
        const msg = event.message;
        const hasToolCalls = event.toolResults.length > 0;

        if (hasToolCalls) {
          // Discard intermediate streamed text — only tool lines matter
        } else if (msg.role === "assistant" && msg.content) {
          // Final turn with no tool calls — render assistant summary
          const text = msg.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("");
          const cleanText = stripThinking(text);
          if (cleanText.trim()) {
            writeAssistantResponse(cleanText);
          }
        }
        break;
      }

      case "agent_end":
        state.spinner.stop();
        break;
    }
  };
}

// ── Convert history ───────────────────────────────────────────────────

/**
 * Convert legacy ChatCompletionMessageParam[] to AgentMessage[].
 * The CLI stores history as legacy OpenAI format; we need to convert
 * to AgentMessage for use with the Agent class.
 */
function legacyHistoryToAgentMessages(history: any[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  for (const msg of history) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      result.push({
        role: "user",
        content: [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }],
      });
    } else if (msg.role === "assistant") {
      const content: any[] = [];
      if (typeof msg.content === "string" && msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: "toolCall",
            id: tc.id,
            name: tc.function?.name ?? tc.name ?? "",
            arguments: tc.function?.arguments ?? tc.arguments ?? "",
          });
        }
      }
      result.push({ role: "assistant", content } as AgentMessage);
    } else if (msg.role === "tool") {
      result.push({
        role: "toolResult",
        content: [{
          type: "toolResult",
          toolCallId: msg.tool_call_id,
          content: [{ type: "text", text: typeof msg.content === "string" ? msg.content : "" }],
        }],
      } as AgentMessage);
    }
  }
  return result;
}

/**
 * Convert AgentMessage[] back to legacy format for DB persistence.
 */
function agentMessagesToLegacyHistory(messages: AgentMessage[]): any[] {
  return messages.map((msg) => {
    if (msg.role === "user") {
      return {
        role: "user",
        content: msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
      };
    }
    if (msg.role === "assistant") {
      const textBlocks = msg.content.filter((c) => c.type === "text");
      const toolBlocks = msg.content.filter((c) => c.type === "toolCall");
      const result: any = {
        role: "assistant",
        content: textBlocks.map((c) => c.text).join("") || null,
      };
      if (toolBlocks.length > 0) {
        result.tool_calls = toolBlocks.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return result;
    }
    if (msg.role === "toolResult") {
      return {
        role: "tool",
        tool_call_id: msg.content[0]?.toolCallId ?? "",
        content: msg.content[0]?.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n") ?? "",
      };
    }
    return msg;
  });
}

// ── Main run function ─────────────────────────────────────────────────

export async function runAgent(
  userMessage: string,
  options: RunAgentOptions,
): Promise<RunAgentResult> {
  const { config, sessionId, history: rawHistory, signal } = options;

  const model = buildModel(config);
  const provider = createProvider(config);
  const tools = createAgentTools(config.workDir);

  // Convert legacy history to AgentMessage[]
  const history = legacyHistoryToAgentMessages(rawHistory);

  // Build initial messages: history + new user prompt
  const initialMessages: AgentMessage[] = [
    ...history,
    { role: "user", content: [{ type: "text", text: userMessage }] },
  ];

  // Stream function wrapping the @jawere/ai provider
  const streamFn: StreamFn = (m, ctx, opts) => provider.stream(m, ctx, opts);

  // Create Agent instance — tools flow through agent-loop → streamOptions → provider
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      tools,
      messages: [],
    },
    streamFn,
    sessionId,
  });

  // Display state
  const displayState: DisplayState = {
    spinner: createSpinner(),
    streamedText: [],
    nativeToolCalls: new Map(),
    pendingToolArgs: new Map(),
    hasStarted: false,
  };

  const unsubscribe = agent.subscribe(createDisplaySubscriber(displayState));

  try {
    await agent.prompt(initialMessages);
  } finally {
    unsubscribe();
  }

  // Return history in legacy format for DB persistence
  const newMessages = agent.state.messages;
  const legacyHistory = agentMessagesToLegacyHistory(newMessages);

  return { history: legacyHistory, allMessages: newMessages };
}
