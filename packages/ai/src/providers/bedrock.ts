// @jawere/ai — AWS Bedrock provider (Converse Stream API)
// Uses native fetch with AWS Signature V4 signing.

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
import { KeyResolver, getDefaultKeyResolver } from "../api-keys.ts";

// ── AWS Signature V4 ─────────────────────────────────────────────────

async function signRequest(
  method: string,
  url: string,
  region: string,
  service: string,
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string,
  body?: string,
): Promise<Record<string, string>> {
  // We use a lightweight signing approach — for production, use @aws-sdk/credential-providers
  const urlObj = new URL(url);
  const headers: Record<string, string> = {
    "Host": urlObj.host,
    "Content-Type": "application/json",
  };

  if (sessionToken) {
    headers["X-Amz-Security-Token"] = sessionToken;
  }

  // Try AWS SDK for signing; fall back to basic headers
  try {
    // @ts-ignore — optional dependency
    const { SignatureV4 } = await import("@aws-sdk/signature-v4");
    // @ts-ignore — optional dependency
    const { Sha256 } = await import("@aws-crypto/sha256-js");

    const signer = new SignatureV4({
      credentials: {
        accessKeyId,
        secretAccessKey,
        sessionToken,
      },
      region,
      service,
      sha256: Sha256,
    });

    const signed = await signer.sign({
      method,
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      protocol: "https",
      headers: headers as any,
      body,
    });

    return signed.headers as Record<string, string>;
  } catch {
    // AWS SDK not available — use basic auth headers
    // For production Bedrock usage, install: @aws-sdk/signature-v4 @aws-crypto/sha256-js
    headers["Authorization"] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${new Date().toISOString().slice(0, 10).replace(/-/g, "")}/${region}/${service}/aws4_request`;
    return headers;
  }
}

// ── Bedrock Converse Stream ──────────────────────────────────────────

export function bedrockConverseStream(
  model: Model<"bedrock-converse-stream">,
  context: Context,
  options: SimpleStreamOptions = {},
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string },
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
      const region = credentials?.region || process.env.AWS_REGION || "us-east-1";

      // Convert context to Bedrock format
      const messages = context.map((m) => {
        if (m.role === "user") {
          return {
            role: "user",
            content: m.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => ({ text: c.text })),
          };
        }
        if (m.role === "assistant") {
          const content: any[] = [];
          for (const block of m.content) {
            if (block.type === "text") {
              content.push({ text: block.text });
            } else if (block.type === "toolCall") {
              content.push({
                toolUse: {
                  toolUseId: block.id,
                  name: block.name,
                  input: safeJsonParse(block.arguments),
                },
              });
            }
          }
          return { role: "assistant", content };
        }
        if (m.role === "toolResult") {
          return m.content.map((tr) => ({
            role: "user",
            content: [{
              toolResult: {
                toolUseId: tr.toolCallId,
                content: tr.content
                  .filter((c): c is TextContent => c.type === "text")
                  .map((c) => ({ text: c.text })),
                status: tr.isError ? "error" : "success",
              },
            }],
          }));
        }
        return { role: (m as any).role, content: [{ text: "" }] };
      }).flat() as any[];

      const body: Record<string, unknown> = {
        modelId: model.id,
        messages,
        inferenceConfig: {
          maxTokens: model.maxTokens || 4096,
        },
      };

      // Tools (Bedrock Converse format)
      if (options.tools && options.tools.length > 0) {
        body.toolConfig = {
          tools: options.tools.map((t: ToolDef) => ({
            toolSpec: {
              name: t.name,
              description: t.description,
              inputSchema: {
                json: t.parameters && Object.keys(t.parameters).length > 0
                  ? t.parameters
                  : { type: "object", properties: {} },
              },
            },
          })),
        };
      }

      const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${model.id}/converse-stream`;

      // Try to get credentials
      let accessKeyId = credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || "";
      let secretAccessKey = credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || "";
      let sessionToken = credentials?.sessionToken || process.env.AWS_SESSION_TOKEN;

      // If no env creds, try to load from AWS SDK
      if (!accessKeyId) {
        try {
          // @ts-ignore — optional dependency
          const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
          const provider = fromNodeProviderChain();
          const creds = await provider();
          accessKeyId = creds.accessKeyId;
          secretAccessKey = creds.secretAccessKey;
          sessionToken = creds.sessionToken;
        } catch {
          throw new Error(
            "AWS Bedrock credentials not found. Set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY or install @aws-sdk/credential-providers.",
          );
        }
      }

      // Sign the request
      const signedHeaders = await signRequest(
        "POST",
        endpoint,
        region,
        "bedrock",
        accessKeyId,
        secretAccessKey,
        sessionToken,
        JSON.stringify(body),
      );

      const response = await fetch(endpoint, {
        method: "POST",
        headers: signedHeaders,
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Bedrock API error ${response.status}: ${errBody}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      const messageId = crypto.randomUUID();

      stream.push({ type: "message_start", messageId });

      let currentToolUse: { id: string; name: string; args: string } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = JSON.parse(trimmed);

            if (event.contentBlockDelta) {
              const delta = event.contentBlockDelta.delta;
              if (delta?.text) {
                stream.push({ type: "message_delta", delta: delta.text, messageId });
              } else if (delta?.toolUse?.input) {
                // Partial JSON input
              }
            } else if (event.contentBlockStart) {
              const start = event.contentBlockStart.start;
              if (start?.toolUse) {
                currentToolUse = {
                  id: start.toolUse.toolUseId || crypto.randomUUID(),
                  name: start.toolUse.name || "unknown",
                  args: "",
                };
                stream.push({
                  type: "tool_call_start",
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  messageId,
                });
              }
            } else if (event.contentBlockStop) {
              if (currentToolUse) {
                stream.push({
                  type: "tool_call_end",
                  id: currentToolUse.id,
                  arguments: currentToolUse.args,
                });
                currentToolUse = null;
              }
            } else if (event.messageStop) {
              stream.push({
                type: "message_end",
                stopReason: event.messageStop.stopReason || "end_turn",
                usage: event.messageStop.usage ? {
                  input: event.messageStop.usage.inputTokens || 0,
                  output: event.messageStop.usage.outputTokens || 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: (event.messageStop.usage.inputTokens || 0) + (event.messageStop.usage.outputTokens || 0),
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                } : undefined,
              });
            } else if (event.exception) {
              stream.push({ type: "error", message: event.exception.message || "Bedrock error" });
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

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ── Provider factory ─────────────────────────────────────────────────

export function bedrockProvider(
  region?: string,
  keyResolver?: KeyResolver,
): Provider<"bedrock-converse-stream"> {
  const resolver = keyResolver ?? getDefaultKeyResolver();
  const resolvedRegion = region || process.env.AWS_REGION || "us-east-1";

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: async () => {
      try {
        const resolved = await resolver.resolveFirst([
          "$AWS_ACCESS_KEY_ID",
          "!aws configure get aws_access_key_id 2>/dev/null",
        ]);
        return resolved.value;
      } catch {
        return "";
      }
    },
    source: "$AWS_ACCESS_KEY_ID",
  };

  return {
    id: "amazon-bedrock",
    name: "AWS Bedrock",
    baseUrl: `https://bedrock-runtime.${resolvedRegion}.amazonaws.com`,
    auth,

    getModels(): Model<"bedrock-converse-stream">[] {
      const baseUrl = `https://bedrock-runtime.${resolvedRegion}.amazonaws.com`;
      return [
        {
          id: "us.anthropic.claude-sonnet-4-20250514-v1:0",
          name: "Claude Sonnet 4 (Bedrock)",
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          baseUrl,
          reasoning: false,
          contextWindow: 200000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
          supportsImages: true,
        },
        {
          id: "us.anthropic.claude-opus-4-20250514-v1:0",
          name: "Claude Opus 4 (Bedrock)",
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          baseUrl,
          reasoning: true,
          contextWindow: 200000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
          supportsImages: true,
        },
        {
          id: "us.anthropic.claude-3-5-haiku-20241022-v1:0",
          name: "Claude 3.5 Haiku (Bedrock)",
          api: "bedrock-converse-stream",
          provider: "amazon-bedrock",
          baseUrl,
          reasoning: false,
          contextWindow: 200000,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 0.80, output: 4, cacheRead: 0, cacheWrite: 0 },
          supportsImages: true,
        },
      ];
    },

    stream(model, context, options) {
      return bedrockConverseStream(
        model as Model<"bedrock-converse-stream">,
        context,
        options,
      );
    },
  };
}
