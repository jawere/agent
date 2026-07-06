// @jawere/ai — Generic OpenAI-compatible provider factory
// Used for providers that expose an OpenAI-compatible API:
// Groq, xAI, Fireworks, Together, OpenRouter, Mistral, GitHub Copilot, etc.

import type {
  Model,
  SimpleStreamOptions,
  Provider,
  ApiKeyAuth,
  Context,
  ToolDef,
} from "../types.ts";
import type { AssistantMessageEvent, AssistantMessage } from "../types.ts";
import { KeyResolver, getDefaultKeyResolver } from "../api-keys.ts";
import { EventStream } from "../event-stream.ts";

export interface OpenAICompatibleProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  /** Env var name for the API key */
  apiKeyEnv: string;
  /** Default models to register */
  models: Model<"openai-completions">[];
}

/**
 * Create an OpenAI-compatible provider.
 * Uses the OpenAI SDK (dynamically imported) with a custom base URL.
 */
export function openAICompatibleProvider(
  config: OpenAICompatibleProviderConfig,
  keyResolver?: KeyResolver,
): Provider<"openai-completions"> {
  const resolver = keyResolver ?? getDefaultKeyResolver();

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: async () => {
      try {
        const resolved = await resolver.resolve(`$${config.apiKeyEnv}`);
        return resolved.value;
      } catch {
        return process.env[config.apiKeyEnv] || "";
      }
    },
    source: `$${config.apiKeyEnv}`,
  };

  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth,

    getModels(): Model<"openai-completions">[] {
      return config.models.map((m) => ({
        ...m,
        provider: config.id,
        baseUrl: config.baseUrl,
      }));
    },

    stream(model, context, options) {
      return openAICompatibleStream(
        config.baseUrl,
        config.apiKeyEnv,
        model,
        context,
        options,
      );
    },
  };
}

function openAICompatibleStream(
  baseUrl: string,
  apiKeyEnv: string,
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
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
      const { default: OpenAI } = await import("openai");

      const apiKey = process.env[apiKeyEnv] || "missing";
      const client = new OpenAI({ apiKey, baseURL: baseUrl });

      // Convert context to OpenAI Chat Completions format
      const messages = context.map((m) => {
        if (m.role === "user") {
          return {
            role: "user" as const,
            content: m.content
              .filter((c) => c.type === "text")
              .map((c) => (c as any).text)
              .join("\n"),
          };
        }
        if (m.role === "assistant") {
          const textBlocks = m.content.filter((c) => c.type === "text");
          const toolBlocks = m.content.filter((c) => c.type === "toolCall");
          return {
            role: "assistant" as const,
            content: textBlocks.map((c) => (c as any).text).join("\n") || null,
            tool_calls: toolBlocks.length > 0
              ? toolBlocks.map((tc: any) => ({
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
            tool_call_id: (tr as any).toolCallId,
            content: (tr as any).content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n") || "",
          }));
        }
        return { role: (m as any).role || "user", content: "" };
      }).flat() as any[];

      const openaiTools = options?.tools && options.tools.length > 0
        ? options.tools.map((t: ToolDef) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters && Object.keys(t.parameters).length > 0
                ? t.parameters
                : { type: "object", properties: {} },
            },
          }))
        : undefined;

      const completion = await client.chat.completions.create(
        {
          model: model.id,
          messages: messages as any,
          stream: true,
          max_tokens: model.maxTokens || 4096,
          ...(openaiTools ? { tools: openaiTools } : {}),
        },
        { signal: options?.signal },
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
          for (const [, tc] of toolCalls) {
            stream.push({
              type: "tool_call_end",
              id: tc.id,
              arguments: tc.args,
            });
          }

          stream.push({
            type: "message_end",
            stopReason: chunk.choices[0].finish_reason,
            usage: chunk.usage ? {
              input: chunk.usage.prompt_tokens,
              output: chunk.usage.completion_tokens,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: chunk.usage.total_tokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            } : undefined,
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

// ── Pre-configured providers ─────────────────────────────────────────

export function groqProvider(apiKey?: string): Provider<"openai-completions"> {
  return openAICompatibleProvider({
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    models: [
      {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B (Groq)",
        api: "openai-completions",
        provider: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
        reasoning: false,
        contextWindow: 131072,
        maxTokens: 8192,
        input: ["text"],
        cost: { input: 0.59, output: 0.79, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}

export function xAIProvider(apiKey?: string): Provider<"openai-completions"> {
  return openAICompatibleProvider({
    id: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    models: [
      {
        id: "grok-3-beta",
        name: "Grok 3 Beta",
        api: "openai-completions",
        provider: "xai",
        baseUrl: "https://api.x.ai/v1",
        reasoning: true,
        contextWindow: 131072,
        maxTokens: 8192,
        input: ["text"],
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}

export function fireworksProvider(apiKey?: string): Provider<"openai-completions"> {
  return openAICompatibleProvider({
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    models: [
      {
        id: "accounts/fireworks/models/llama-v3p1-405b-instruct",
        name: "Llama 3.1 405B (Fireworks)",
        api: "openai-completions",
        provider: "fireworks",
        baseUrl: "https://api.fireworks.ai/inference/v1",
        reasoning: false,
        contextWindow: 131072,
        maxTokens: 8192,
        input: ["text"],
        cost: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}

export function togetherProvider(apiKey?: string): Provider<"openai-completions"> {
  return openAICompatibleProvider({
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    models: [
      {
        id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        name: "Llama 3.3 70B (Together)",
        api: "openai-completions",
        provider: "together",
        baseUrl: "https://api.together.xyz/v1",
        reasoning: false,
        contextWindow: 131072,
        maxTokens: 8192,
        input: ["text"],
        cost: { input: 0.88, output: 0.88, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
