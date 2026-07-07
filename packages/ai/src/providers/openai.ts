// @jawere/ai — OpenAI provider implementation (Responses API + Chat Completions fallback)

import OpenAI from "openai";
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
} from "../types.ts";
import { EventStream } from "../event-stream.ts";

// ── Tool conversion helpers ──────────────────────────────────────────

function convertToolsToOpenAI(tools?: ToolDef[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters && Object.keys(t.parameters).length > 0
        ? t.parameters
        : { type: "object", properties: {} },
    },
  }));
}

function convertToolsToResponses(tools?: ToolDef[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters && Object.keys(t.parameters).length > 0
      ? t.parameters
      : { type: "object", properties: {} },
  }));
}

// ── OpenAI Responses API stream ──────────────────────────────────────

export function openAIResponsesStream(
  client: OpenAI,
  model: Model<"openai-responses">,
  context: Context,
  options: SimpleStreamOptions = {},
): EventStream<AssistantMessageEvent, AssistantMessage> {
  const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
    (event) => event.type === "message_end" || event.type === "error",
    (event) => {
      const content: (TextContent | ToolCallContent)[] = [];
      return {
        role: "assistant",
        content,
        stopReason: event.type === "error" ? "error" : event.stopReason,
        errorMessage: event.type === "error" ? event.message : undefined,
        model: model.id,
      };
    },
  );

  (async () => {
    try {
      const responseTools = convertToolsToResponses(options.tools);

      const response = await client.responses.create(
        {
          model: model.id,
          input: context.map((m) => {
            if (m.role === "user") {
              const text = m.content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("\n");
              return { role: "user" as const, content: text };
            }
            if (m.role === "assistant") {
              const text = m.content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("\n");
              return { role: "assistant" as const, content: text };
            }
            return {
              role: m.role as "user" | "assistant",
              content: JSON.stringify(m.content),
            };
          }),
          stream: true,
          ...(responseTools ? { tools: responseTools } : {}),
        },
        { signal: options.signal },
      );

      let messageId = crypto.randomUUID();
      stream.push({ type: "message_start", messageId });

      for await (const event of response) {
        if (event.type === "response.output_text.delta") {
          stream.push({
            type: "message_delta",
            delta: event.delta,
            messageId,
          });
        } else if (event.type === "response.completed") {
          stream.push({
            type: "message_end",
            stopReason: "end",
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", message: msg });
    }
  })();

  return stream;
}

// ── OpenAI Chat Completions fallback ─────────────────────────────────

export function openAICompletionsStream(
  client: OpenAI,
  model: Model<"openai-completions">,
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
      // Convert our context to OpenAI Chat Completions format
      const messages = context.map((m) => {
        if (m.role === "user") {
          return {
            role: "user" as const,
            content: m.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
          };
        }
        if (m.role === "assistant") {
          const textBlocks = m.content.filter(
            (c): c is TextContent => c.type === "text",
          );
          const toolBlocks = m.content.filter(
            (c): c is ToolCallContent => c.type === "toolCall",
          );
          return {
            role: "assistant" as const,
            content: textBlocks.map((c) => c.text).join("\n") || null,
            tool_calls: toolBlocks.length > 0
              ? toolBlocks.map((tc) => ({
                  id: tc.id,
                  type: "function" as const,
                  function: { name: tc.name, arguments: tc.arguments },
                }))
              : undefined,
          };
        }
        if (m.role === "toolResult") {
          return m.content.map((tr) => ({
            role: "tool" as const,
            tool_call_id: tr.toolCallId,
            content:
              tr.content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("\n") || "",
          }));
        }
        return { role: (m as any).role || "user", content: "" };
      }).flat() as any[];

      const openaiTools = convertToolsToOpenAI(options.tools);

      const completion = await client.chat.completions.create(
        {
          model: model.id,
          messages: messages as any,
          stream: true,
          ...(openaiTools ? { tools: openaiTools } : {}),
        },
        { signal: options.signal },
      );

      let messageId = crypto.randomUUID();
      stream.push({ type: "message_start", messageId });

      let toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const chunk of completion) {
        const delta = chunk.choices?.[0]?.delta;

        if (delta?.content) {
          stream.push({ type: "message_delta", delta: delta.content, messageId });
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            let entry = toolCalls.get(idx);
            if (!entry) {
              entry = { id: tc.id ?? crypto.randomUUID(), name: tc.function?.name ?? "", args: "" };
              toolCalls.set(idx, entry);
              stream.push({
                type: "tool_call_start",
                id: entry.id,
                name: entry.name,
                messageId,
              });
            }
            if (tc.function?.arguments) {
              entry.args += tc.function.arguments;
              stream.push({
                type: "tool_call_delta",
                id: entry.id,
                delta: tc.function.arguments,
              });
            }
          }
        }

        if (chunk.choices?.[0]?.finish_reason) {
          // End tool calls
          for (const [, tc] of toolCalls) {
            stream.push({
              type: "tool_call_end",
              id: tc.id,
              arguments: tc.args,
            });
          }

          const usage = chunk.usage
            ? {
                input: chunk.usage.prompt_tokens,
                output: chunk.usage.completion_tokens,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: chunk.usage.total_tokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              }
            : undefined;

          stream.push({
            type: "message_end",
            usage,
            stopReason: chunk.choices[0].finish_reason,
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", message: msg });
    }
  })();

  return stream;
}

// ── Provider factory ─────────────────────────────────────────────────

export function openAIProvider(
  apiKey?: string,
  baseURL?: string,
): Provider<"openai-responses" | "openai-completions"> {
  const resolveApiKey = (): string | undefined => {
    if (apiKey) return apiKey;
    return process.env.OPENAI_API_KEY;
  };

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: resolveApiKey,
    source: "$OPENAI_API_KEY",
  };

  const client = new OpenAI({
    apiKey: resolveApiKey() ?? "missing",
    baseURL: baseURL ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  });

  return {
    id: "openai",
    name: "OpenAI",
    baseUrl: baseURL ?? "https://api.openai.com/v1",
    auth,

    getModels(): Model<any>[] {
      return [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          api: "openai-responses",
          provider: "openai",
          baseUrl: baseURL ?? "https://api.openai.com/v1",
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 16384,
          input: ["text", "image"],
          cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 1.25 },
        },
        {
          id: "gpt-4o-mini",
          name: "GPT-4o Mini",
          api: "openai-responses",
          provider: "openai",
          baseUrl: baseURL ?? "https://api.openai.com/v1",
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 16384,
          input: ["text", "image"],
          cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.075 },
        },
        {
          id: "gpt-4.1",
          name: "GPT-4.1",
          api: "openai-responses",
          provider: "openai",
          baseUrl: baseURL ?? "https://api.openai.com/v1",
          reasoning: false,
          contextWindow: 1048576,
          maxTokens: 32768,
          input: ["text"],
          cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0.5 },
        },
      ];
    },

    stream(model, context, options) {
      if (model.api === "openai-completions" || !client.responses) {
        return openAICompletionsStream(client, model as any, context, options);
      }
      return openAIResponsesStream(client, model as any, context, options);
    },
  };
}
