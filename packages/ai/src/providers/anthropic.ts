// @jawere/ai — Anthropic provider (Messages API with SSE streaming)
// Uses native fetch — no SDK dependency required.

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  Provider,
  ApiKeyAuth,
  TextContent,
  ToolCallContent,
  ToolDef,
  ImageContent,
} from "../types.ts";
import { EventStream } from "../event-stream.ts";
import { KeyResolver, getDefaultKeyResolver } from "../api-keys.ts";

// ── Types ────────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  source?: { type: string; media_type: string; data: string };
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

interface AnthropicSSEEvent {
  type: string;
  message?: {
    id: string;
    type: string;
    role: string;
    content: AnthropicContentBlock[];
    stop_reason?: string;
    stop_sequence?: string;
    usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    model?: string;
  };
  content_block?: AnthropicContentBlock;
  delta?: { type: string; text?: string; partial_json?: string };
  index?: number;
  error?: { type: string; message: string };
  usage?: { input_tokens: number; output_tokens: number };
}

// ── Message conversion ───────────────────────────────────────────────

function convertContextToAnthropic(context: Context, model: Model): {
  system?: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{ role: string; content: unknown }>;
} {
  const messages: Array<{ role: string; content: unknown }> = [];
  let systemText = "";

  for (const msg of context) {
    if (msg.role === "user") {
      // Check if this is actually a system prompt (first message, role user)
      // Anthropic uses a separate system parameter
      const textBlocks = msg.content.filter((c): c is TextContent => c.type === "text");
      const imageBlocks = msg.content.filter((c): c is ImageContent => c.type === "image");

      if (messages.length === 0 && imageBlocks.length === 0) {
        // Could be system prompt — we'll handle this below
      }

      const content: AnthropicContentBlock[] = [];
      for (const tb of textBlocks) {
        content.push({ type: "text", text: tb.text });
      }
      for (const ib of imageBlocks) {
        if (ib.source.type === "base64") {
          content.push({
            type: "image",
            source: { type: "base64", media_type: ib.source.mediaType, data: ib.source.data },
          });
        }
      }
      messages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const content: AnthropicContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          content.push({ type: "text", text: block.text });
        } else if (block.type === "toolCall") {
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: safeJsonParse(block.arguments),
          });
        }
      }
      messages.push({ role: "assistant", content });
    } else if (msg.role === "toolResult") {
      for (const tr of msg.content) {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: tr.toolCallId,
            content: tr.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
            is_error: tr.isError,
          }],
        });
      }
    }
  }

  // Build system prompt with cache control if supported
  const system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];

  // Extract system-like content from the first user message
  if (messages.length > 0 && messages[0].role === "user") {
    const firstContent = messages[0].content as AnthropicContentBlock[];
    const textBlocks = firstContent.filter((b) => b.type === "text" && b.text);
    // If first message is long, treat as system prompt
    if (textBlocks.length === 1 && textBlocks[0].text!.length > 500) {
      systemText = textBlocks[0].text!;
      messages.shift(); // Remove from messages
    }
  }

  if (systemText) {
    system.push({
      type: "text",
      text: systemText,
      ...(model.supportsPromptCaching ? { cache_control: { type: "ephemeral" } } : {}),
    });
  }

  return { system: system.length > 0 ? system : undefined, messages };
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ── Tool conversion ──────────────────────────────────────────────────

function convertToolsToAnthropic(tools?: ToolDef[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters && Object.keys(t.parameters).length > 0
      ? t.parameters
      : { type: "object", properties: {} },
  }));
}

// ── Stream function ──────────────────────────────────────────────────

export function anthropicMessagesStream(
  apiKey: string,
  model: Model<"anthropic-messages">,
  context: Context,
  options: SimpleStreamOptions = {},
): EventStream<AssistantMessageEvent, AssistantMessage> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "message_end" || event.type === "error",
    (event) => ({
      role: "assistant",
      content: [],
      stopReason: event.type === "error" ? "error" : event.stopReason,
      errorMessage: event.type === "error" ? event.message : undefined,
      model: model.id,
    }),
  );

  (async () => {
    try {
      const { system, messages } = convertContextToAnthropic(context, model);

      const body: Record<string, unknown> = {
        model: model.id,
        max_tokens: model.maxTokens || 4096,
        messages,
        stream: true,
      };

      if (system) body.system = system;

      // Tools
      const anthropicTools = convertToolsToAnthropic(options.tools);
      if (anthropicTools) body.tools = anthropicTools;

      // Thinking budget
      if (options.thinkingBudget && model.reasoning) {
        body.thinking = { type: "enabled", budget_tokens: options.thinkingBudget };
        body.max_tokens = Math.max(model.maxTokens || 4096, options.thinkingBudget + 1024);
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          ...(options.signal ? {} : {}),
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let messageId = crypto.randomUUID() as string;
      let currentToolIndex = -1;
      let toolUseIds: Map<number, string> = new Map();

      stream.push({ type: "message_start", messageId });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") continue;

          try {
            const event: AnthropicSSEEvent = JSON.parse(dataStr);

            switch (event.type) {
              case "message_start":
                if (event.message) {
                  messageId = event.message.id;
                  stream.push({ type: "message_start", messageId });
                }
                break;

              case "content_block_start":
                if (event.content_block) {
                  const block = event.content_block;
                  const idx = event.index ?? 0;

                  if (block.type === "text") {
                    // Text block — deltas will follow
                  } else if (block.type === "tool_use") {
                    currentToolIndex = idx;
                    const toolId = block.id || crypto.randomUUID();
                    toolUseIds.set(idx, toolId);
                    stream.push({
                      type: "tool_call_start",
                      id: toolId,
                      name: block.name || "unknown",
                      messageId,
                    });
                  }
                }
                break;

              case "content_block_delta":
                if (event.delta) {
                  if (event.delta.type === "text_delta" && event.delta.text) {
                    stream.push({
                      type: "message_delta",
                      delta: event.delta.text,
                      messageId,
                    });
                  } else if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
                    const idx = event.index ?? 0;
                    const toolId = toolUseIds.get(idx);
                    if (toolId) {
                      stream.push({
                        type: "tool_call_delta",
                        id: toolId,
                        delta: event.delta.partial_json,
                      });
                    }
                  }
                }
                break;

              case "content_block_stop": {
                const idx = event.index ?? 0;
                const toolId = toolUseIds.get(idx);
                if (toolId) {
                  stream.push({
                    type: "tool_call_end",
                    id: toolId,
                    arguments: "", // arguments were accumulated via deltas; final assembly happens on consumer side
                  });
                }
                break;
              }

              case "message_delta":
                // Contains stop_reason and usage
                if (event.delta?.text) {
                  // sometimes stop_reason comes here
                }
                if (event.usage) {
                  stream.push({
                    type: "message_end",
                    stopReason: "end_turn",
                    usage: event.usage ? {
                      input: event.usage.input_tokens || 0,
                      output: event.usage.output_tokens || 0,
                      cacheRead: (event.usage as any).cache_read_input_tokens || 0,
                      cacheWrite: (event.usage as any).cache_creation_input_tokens || 0,
                      totalTokens: (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
                      cost: calculateAnthropicCost(model, event.usage),
                    } : undefined,
                  });
                }
                break;

              case "message_stop":
                // Final message event
                break;

              case "error":
                stream.push({ type: "error", message: event.error?.message || "Unknown error" });
                break;
            }
          } catch {
            // Skip unparseable lines
          }
        }
      }

      // Ensure we end the stream
      stream.push({ type: "message_end", stopReason: "end_turn" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", message: msg });
    }
  })();

  return stream;
}

// ── Cost calculation ─────────────────────────────────────────────────

function calculateAnthropicCost(
  model: Model,
  usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
) {
  const input = (usage.input_tokens || 0) * (model.cost.input / 1_000_000);
  const output = (usage.output_tokens || 0) * (model.cost.output / 1_000_000);
  const cacheRead = (usage.cache_read_input_tokens || 0) * (model.cost.cacheRead / 1_000_000);
  const cacheWrite = (usage.cache_creation_input_tokens || 0) * (model.cost.cacheWrite / 1_000_000);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

// ── Provider factory ─────────────────────────────────────────────────

export function anthropicProvider(
  apiKey?: string,
  keyResolver?: KeyResolver,
): Provider<"anthropic-messages"> {
  const resolver = keyResolver ?? getDefaultKeyResolver();

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: async () => {
      if (apiKey) return apiKey;
      const resolved = await resolver.resolve("$ANTHROPIC_API_KEY");
      return resolved.value;
    },
    source: "$ANTHROPIC_API_KEY",
  };

  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    auth,

    getModels(): Model<"anthropic-messages">[] {
      return [
        {
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          reasoning: false,
          contextWindow: 200000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
          supportsPromptCaching: true,
          supportsImages: true,
        },
        {
          id: "claude-opus-4-20250514",
          name: "Claude Opus 4",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          reasoning: true,
          contextWindow: 200000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
          supportsPromptCaching: true,
          supportsImages: true,
          thinkingBudgets: { low: 1024, medium: 4096, high: 8192, xhigh: 16384 },
        },
        {
          id: "claude-haiku-3-5-20241022",
          name: "Claude 3.5 Haiku",
          api: "anthropic-messages",
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          reasoning: false,
          contextWindow: 200000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
          supportsPromptCaching: true,
          supportsImages: true,
        },
      ];
    },

    stream(model, context, options) {
      return anthropicMessagesStream(
        apiKey || process.env.ANTHROPIC_API_KEY || "",
        model as Model<"anthropic-messages">,
        context,
        options,
      );
    },
  };
}
