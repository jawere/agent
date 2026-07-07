// @jawere/ai — Cloudflare AI Gateway provider
// Uses Cloudflare AI Gateway which proxies requests to multiple AI providers.

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

export interface CloudflareConfig {
  /** Cloudflare Account ID */
  accountId?: string;
  /** AI Gateway name */
  gatewayName?: string;
  /** API token (not the global key) */
  apiToken?: string;
  /** Custom base URL (for enterprise) */
  baseUrl?: string;
}

/**
 * Cloudflare AI Gateway provider.
 * Acts as a proxy — delegates to the underlying provider through Cloudflare.
 */
export function cloudflareProvider(
  config: CloudflareConfig = {},
  keyResolver?: KeyResolver,
): Provider<"openai-completions"> {
  const resolver = keyResolver ?? getDefaultKeyResolver();
  const accountId = config.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const gatewayName = config.gatewayName || process.env.CLOUDFLARE_GATEWAY || "default";
  const baseUrl = config.baseUrl || `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayName}`;

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: async () => {
      if (config.apiToken) return config.apiToken;
      try {
        const resolved = await resolver.resolve("$CLOUDFLARE_API_TOKEN");
        return resolved.value;
      } catch {
        return process.env.CLOUDFLARE_API_TOKEN || "";
      }
    },
    source: "$CLOUDFLARE_API_TOKEN",
  };

  return {
    id: "cloudflare",
    name: "Cloudflare AI Gateway",
    baseUrl,
    auth,

    getModels(): Model<"openai-completions">[] {
      return [
        {
          id: "workers-ai",
          name: "Cloudflare Workers AI",
          api: "openai-completions",
          provider: "cloudflare",
          baseUrl,
          reasoning: false,
          contextWindow: 131072,
          maxTokens: 4096,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ];
    },

    stream(model, context, options) {
      return cloudflareStream(baseUrl, model, context, options, config.apiToken);
    },
  };
}

function cloudflareStream(
  baseUrl: string,
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
  apiToken?: string,
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
      const token = apiToken || process.env.CLOUDFLARE_API_TOKEN || "";
      const messages = context.map((m) => ({
        role: m.role,
        content: m.content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).text)
          .join("\n"),
      }));

      const cfTools = options?.tools && options.tools.length > 0
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

      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "cf-aig-cache-ttl": options?.cacheRetention === "long" ? "86400" : "0",
        },
        body: JSON.stringify({
          model: model.id,
          messages,
          stream: true,
          max_tokens: model.maxTokens || 4096,
          ...(cfTools ? { tools: cfTools } : {}),
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Cloudflare API error ${response.status}: ${errBody}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      const messageId = crypto.randomUUID();

      stream.push({ type: "message_start", messageId });

      let toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

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
          if (dataStr === "[DONE]") {
            stream.push({ type: "message_end", stopReason: "end" });
            continue;
          }

          try {
            const chunk = JSON.parse(dataStr);
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
                stream.push({ type: "tool_call_end", id: tc.id, arguments: tc.args });
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
          } catch {
            // Skip unparseable lines
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", message: msg });
    }
  })();

  return stream;
}
