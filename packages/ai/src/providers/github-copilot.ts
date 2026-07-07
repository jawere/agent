// @jawere/ai — GitHub Copilot provider
// Uses GitHub Copilot's token-based authentication.
// Tokens are obtained via the GitHub CLI (gh auth token) or OAuth device flow.

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

export interface GitHubCopilotConfig {
  /** OAuth token or "!gh auth token" command */
  token?: string;
  /** Base URL (enterprise support) */
  baseUrl?: string;
}

/**
 * GitHub Copilot provider.
 * Uses OpenAI-compatible API with GitHub authentication headers.
 */
export function githubCopilotProvider(
  config: GitHubCopilotConfig = {},
  keyResolver?: KeyResolver,
): Provider<"github-copilot"> {
  const resolver = keyResolver ?? getDefaultKeyResolver();
  const baseUrl = config.baseUrl || "https://api.githubcopilot.com";

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: async () => {
      if (config.token) return config.token;
      try {
        const resolved = await resolver.resolve("!gh auth token 2>/dev/null");
        return resolved.value;
      } catch {
        return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
      }
    },
    source: "!gh auth token",
  };

  return {
    id: "github-copilot",
    name: "GitHub Copilot",
    baseUrl,
    auth,

    getModels(): Model<"github-copilot">[] {
      return [
        {
          id: "gpt-4o",
          name: "GitHub Copilot GPT-4o",
          api: "github-copilot",
          provider: "github-copilot",
          baseUrl,
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 16384,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // Included in subscription
          supportsImages: true,
        },
        {
          id: "claude-sonnet-4",
          name: "GitHub Copilot Claude Sonnet 4",
          api: "github-copilot",
          provider: "github-copilot",
          baseUrl,
          reasoning: false,
          contextWindow: 200000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          supportsImages: true,
        },
      ];
    },

    stream(model, context, options) {
      return copilotStream(baseUrl, model, context, options, config.token);
    },
  };
}

function copilotStream(
  baseUrl: string,
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
  token?: string,
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

      const apiKey = token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "missing";
      const client = new OpenAI({
        apiKey,
        baseURL: `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      });

      // Build headers for Copilot-specific features
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

      const integrationId = "vscode";

      const copilotTools = options?.tools && options.tools.length > 0
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

      const response = await (client as any).post("/chat/completions", {
        model: model.id,
        messages,
        stream: true,
        max_tokens: model.maxTokens || 4096,
        copilot_integration_id: integrationId,
        ...(copilotTools ? { tools: copilotTools } : {}),
      }, {
        signal: options?.signal,
      });

      // Handle streaming response manually since Copilot might have different event format
      let messageId = crypto.randomUUID();
      stream.push({ type: "message_start", messageId });

      let toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const chunk of response) {
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
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      stream.push({ type: "error", message: msg });
    }
  })();

  return stream;
}
