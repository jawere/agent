// @jawere/ai — Azure OpenAI provider
// Uses OpenAI SDK with Azure configuration — dynamically imported.

import type {
  Model,
  SimpleStreamOptions,
  Provider,
  ApiKeyAuth,
  Context,
  AssistantMessageEvent,
  AssistantMessage,
  ToolDef,
} from "../types.ts";
import { EventStream } from "../event-stream.ts";
import { KeyResolver, getDefaultKeyResolver } from "../api-keys.ts";

export function azureOpenAIProvider(
  endpoint?: string,
  apiKey?: string,
  deploymentName?: string,
  apiVersion?: string,
  keyResolver?: KeyResolver,
): Provider<"azure-openai-responses" | "openai-completions"> {
  const resolver = keyResolver ?? getDefaultKeyResolver();
  const resolvedEndpoint = endpoint || process.env.AZURE_OPENAI_ENDPOINT || "";
  const resolvedApiVersion = apiVersion || process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: async () => {
      if (apiKey) return apiKey;
      try {
        const resolved = await resolver.resolve("$AZURE_OPENAI_API_KEY");
        return resolved.value;
      } catch {
        return process.env.AZURE_OPENAI_API_KEY || "";
      }
    },
    source: "$AZURE_OPENAI_API_KEY",
  };

  return {
    id: "azure",
    name: "Azure OpenAI",
    baseUrl: resolvedEndpoint,
    auth,

    getModels(): Model<any>[] {
      const depName = deploymentName || process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";
      return [
        {
          id: depName,
          name: `Azure ${depName}`,
          api: "azure-openai-responses",
          provider: "azure",
          baseUrl: resolvedEndpoint,
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 16384,
          input: ["text", "image"],
          cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
          supportsImages: true,
        },
      ];
    },

    stream(model, context, options) {
      return azureStream(
        resolvedEndpoint,
        model.id,
        resolvedApiVersion,
        context,
        options,
      );
    },
  };
}

function azureStream(
  endpoint: string,
  deploymentName: string,
  apiVersion: string,
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
      model: deploymentName,
    }),
  );

  (async () => {
    try {
      const { default: OpenAI } = await import("openai");

      const apiKey = process.env.AZURE_OPENAI_API_KEY || "missing";
      const client = new OpenAI({
        apiKey,
        baseURL: `${endpoint.replace(/\/$/, "")}/openai/deployments/${deploymentName}`,
        defaultQuery: { "api-version": apiVersion },
        defaultHeaders: { "api-key": apiKey },
      });

      const messages = context.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content
          .filter((c) => c.type === "text")
          .map((c) => (c as any).text)
          .join("\n") || "",
      }));

      const azureTools = options?.tools && options.tools.length > 0
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
          model: deploymentName,
          messages: messages as any,
          stream: true,
          ...(azureTools ? { tools: azureTools } : {}),
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
