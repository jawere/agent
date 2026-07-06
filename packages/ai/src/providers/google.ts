// @jawere/ai — Google Gemini provider (Generative AI API)
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

// ── Gemini API types ─────────────────────────────────────────────────

interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: { name: string; content: string } };
}

interface GeminiSSEChunk {
  candidates?: Array<{
    content?: { role: string; parts: GeminiPart[] };
    finishReason?: string;
    safetyRatings?: unknown[];
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

// ── Message conversion ───────────────────────────────────────────────

function convertContextToGemini(context: Context): {
  systemInstruction?: GeminiContent;
  contents: GeminiContent[];
} {
  const contents: GeminiContent[] = [];
  let systemInstruction: GeminiContent | undefined;

  for (let i = 0; i < context.length; i++) {
    const msg = context[i];

    if (msg.role === "user") {
      const parts: GeminiPart[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          if (block.source.type === "base64") {
            parts.push({
              inlineData: { mimeType: block.source.mediaType, data: block.source.data },
            });
          }
        }
      }

      // First user message with no images → system instruction
      if (i === 0 && contents.length === 0 && parts.every((p) => !p.inlineData)) {
        systemInstruction = { role: "user", parts };
        continue;
      }

      contents.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      const parts: GeminiPart[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "toolCall") {
          parts.push({
            functionCall: {
              name: block.name,
              args: safeJsonParse(block.arguments),
            },
          });
        }
      }
      contents.push({ role: "model", parts });
    } else if (msg.role === "toolResult") {
      for (const tr of msg.content) {
        const text = tr.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        contents.push({
          role: "function",
          parts: [{
            functionResponse: {
              name: tr.toolCallId,
              response: { name: tr.toolCallId, content: text },
            },
          }],
        });
      }
    }
  }

  return { systemInstruction, contents };
}

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ── Stream function ──────────────────────────────────────────────────

export function geminiGenerativeAIStream(
  apiKey: string,
  model: Model<"google-generative-ai">,
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
      const { systemInstruction, contents } = convertContextToGemini(context);

      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          maxOutputTokens: model.maxTokens || 8192,
        },
      };

      if (systemInstruction) {
        body.systemInstruction = systemInstruction;
      }

      // Tools (Gemini function declarations)
      if (options.tools && options.tools.length > 0) {
        body.tools = [{
          functionDeclarations: options.tools.map((t: ToolDef) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters && Object.keys(t.parameters).length > 0
              ? t.parameters
              : { type: "object", properties: {} },
          })),
        }];
      }

      // Add tools config if needed (function calling is auto-detected by Gemini from system instruction)
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent?alt=sse&key=${apiKey}`;

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Gemini API error ${response.status}: ${errBody}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      const messageId = crypto.randomUUID();

      stream.push({ type: "message_start", messageId });

      let fullText = "";
      let currentToolCall: { name: string; args: string } | null = null;
      let toolCallCounter = 0;

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
          if (!dataStr) continue;

          try {
            const chunk: GeminiSSEChunk = JSON.parse(dataStr);

            if (chunk.candidates?.[0]?.content?.parts) {
              for (const part of chunk.candidates[0].content.parts) {
                if (part.text !== undefined) {
                  fullText += part.text;
                  stream.push({
                    type: "message_delta",
                    delta: part.text,
                    messageId,
                  });
                } else if (part.functionCall) {
                  const tcId = `call_${toolCallCounter++}`;
                  stream.push({
                    type: "tool_call_start",
                    id: tcId,
                    name: part.functionCall.name,
                    messageId,
                  });

                  const argsStr = JSON.stringify(part.functionCall.args);
                  stream.push({
                    type: "tool_call_delta",
                    id: tcId,
                    delta: argsStr,
                  });
                  stream.push({
                    type: "tool_call_end",
                    id: tcId,
                    arguments: argsStr,
                  });
                }
              }
            }

            if (chunk.candidates?.[0]?.finishReason) {
              const usage = chunk.usageMetadata
                ? {
                    input: chunk.usageMetadata.promptTokenCount,
                    output: chunk.usageMetadata.candidatesTokenCount,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: chunk.usageMetadata.totalTokenCount,
                    cost: calculateGeminiCost(model, chunk.usageMetadata),
                  }
                : undefined;

              stream.push({
                type: "message_end",
                stopReason: chunk.candidates[0].finishReason === "STOP" ? "end" : chunk.candidates[0].finishReason,
                usage,
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

function calculateGeminiCost(
  model: Model,
  usage: { promptTokenCount: number; candidatesTokenCount: number },
) {
  const input = usage.promptTokenCount * (model.cost.input / 1_000_000);
  const output = usage.candidatesTokenCount * (model.cost.output / 1_000_000);
  return { input, output, cacheRead: 0, cacheWrite: 0, total: input + output };
}

// ── Provider factory ─────────────────────────────────────────────────

export function googleGenerativeAIProvider(
  apiKey?: string,
  keyResolver?: KeyResolver,
): Provider<"google-generative-ai"> {
  const resolver = keyResolver ?? getDefaultKeyResolver();

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: async () => {
      if (apiKey) return apiKey;
      const resolved = await resolver.resolve("$GEMINI_API_KEY");
      return resolved.value;
    },
    source: "$GEMINI_API_KEY",
  };

  return {
    id: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    auth,

    getModels(): Model<"google-generative-ai">[] {
      return [
        {
          id: "gemini-2.5-pro",
          name: "Gemini 2.5 Pro",
          api: "google-generative-ai",
          provider: "google",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          reasoning: true,
          contextWindow: 1048576,
          maxTokens: 65536,
          input: ["text", "image"],
          cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
          supportsImages: true,
          thinkingBudgets: { low: 1024, medium: 4096, high: 16384, xhigh: 32768 },
        },
        {
          id: "gemini-2.5-flash",
          name: "Gemini 2.5 Flash",
          api: "google-generative-ai",
          provider: "google",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          reasoning: false,
          contextWindow: 1048576,
          maxTokens: 8192,
          input: ["text", "image"],
          cost: { input: 0.15, output: 0.60, cacheRead: 0, cacheWrite: 0 },
          supportsImages: true,
        },
      ];
    },

    stream(model, context, options) {
      return geminiGenerativeAIStream(
        apiKey || process.env.GEMINI_API_KEY || "",
        model as Model<"google-generative-ai">,
        context,
        options,
      );
    },
  };
}

// ── Vertex AI variant ────────────────────────────────────────────────

export function googleVertexProvider(
  projectId?: string,
  location?: string,
  keyResolver?: KeyResolver,
): Provider<"google-vertex"> {
  const resolver = keyResolver ?? getDefaultKeyResolver();
  const projId = projectId || process.env.GOOGLE_VERTEX_PROJECT || "";
  const loc = location || process.env.GOOGLE_VERTEX_LOCATION || "us-central1";

  const auth: ApiKeyAuth = {
    type: "apiKey",
    resolve: async () => {
      // Vertex uses OAuth — resolve from gcloud
      try {
        const resolved = await resolver.resolve("!gcloud auth print-access-token 2>/dev/null");
        return resolved.value;
      } catch {
        return process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
      }
    },
    source: "!gcloud auth print-access-token",
  };

  return {
    id: "google-vertex",
    name: "Google Vertex AI",
    baseUrl: `https://${loc}-aiplatform.googleapis.com/v1`,
    auth,

    getModels(): Model<"google-vertex">[] {
      const baseUrl = `https://${loc}-aiplatform.googleapis.com/v1`;
      return [
        {
          id: "gemini-2.5-pro",
          name: "Gemini 2.5 Pro (Vertex)",
          api: "google-vertex",
          provider: "google-vertex",
          baseUrl,
          reasoning: true,
          contextWindow: 1048576,
          maxTokens: 65536,
          input: ["text", "image"],
          cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
          supportsImages: true,
        },
      ];
    },

    stream(model, context, options) {
      return geminiGenerativeAIStream(
        "", // Vertex uses OAuth token in headers, not API key
        { ...model, api: "google-generative-ai" } as any,
        context,
        options,
      );
    },
  };
}
