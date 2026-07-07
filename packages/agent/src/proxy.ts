// @jawere/agent — Stream proxy for server-based LLM routing

/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  EventStream,
  type Model,
  type SimpleStreamOptions,
} from "@jawere/ai";

// ── Proxy event stream ───────────────────────────────────────────────

class ProxyMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === "message_end" || event.type === "error",
      (event) => {
        if (event.type === "message_end") {
          return {
            role: "assistant" as const,
            content: [],
            stopReason: event.stopReason,
            errorMessage: event.errorMessage,
            model: (event as any).model,
          };
        }
        if (event.type === "error") {
          return {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `Error: ${event.message}` }],
            stopReason: "error" as const,
            errorMessage: event.message,
          };
        }
        throw new Error("Unexpected event type");
      },
    );
  }
}

// ── Proxy event types ────────────────────────────────────────────────

/** Server-sent proxy events (partial stripped to reduce bandwidth). */
export type ProxyAssistantMessageEvent =
  | { type: "message_start"; messageId: string }
  | { type: "message_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_end"; id: string; arguments: string }
  | {
      type: "done";
      stopReason: string;
      usage?: AssistantMessage["usage"];
      model?: string;
    }
  | {
      type: "error";
      message: string;
    };

type ProxySerializableStreamOptions = Pick<
  SimpleStreamOptions,
  | "thinkingLevel"
  | "thinkingBudget"
  | "transport"
  | "cacheRetention"
  | "signal"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
  /** Local abort signal for the proxy request */
  signal?: AbortSignal;
  /** Auth token for the proxy server */
  authToken: string;
  /** Proxy server URL (e.g., "https://genai.example.com") */
  proxyUrl: string;
}

// ── Stream proxy ─────────────────────────────────────────────────────

function buildProxyRequestOptions(
  options: ProxyStreamOptions,
): ProxySerializableStreamOptions {
  return {
    thinkingLevel: options.thinkingLevel,
    thinkingBudget: options.thinkingBudget,
    transport: options.transport,
    cacheRetention: options.cacheRetention,
  };
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 *
 * Use this as the streamFn option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 */
export function streamProxy(
  model: Model,
  context: Context,
  options: ProxyStreamOptions,
): ProxyMessageEventStream {
  const stream = new ProxyMessageEventStream();

  (async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      model: model.id,
      stopReason: "stop",
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const abortHandler = () => {
      if (reader) {
        reader.cancel("Request aborted by user").catch(() => {});
      }
    };

    if (options.signal) {
      options.signal.addEventListener("abort", abortHandler);
    }

    try {
      const response = await fetch(`${options.proxyUrl}/api/stream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          context,
          options: buildProxyRequestOptions(options),
        }),
        signal: options.signal,
      });

      if (!response.ok) {
        let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
        try {
          const errorData = (await response.json()) as { error?: string };
          if (errorData.error) {
            errorMessage = `Proxy error: ${errorData.error}`;
          }
        } catch {
          // Couldn't parse error response
        }
        throw new Error(errorMessage);
      }

      reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentToolCall: {
        id: string;
        name: string;
        arguments: string;
      } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (options.signal?.aborted) {
          throw new Error("Request aborted by user");
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (!data) continue;

            try {
              const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;

              switch (proxyEvent.type) {
                case "message_start":
                  stream.push({
                    type: "message_start",
                    messageId: proxyEvent.messageId,
                  });
                  break;

                case "message_delta":
                  stream.push({
                    type: "message_delta",
                    delta: proxyEvent.delta,
                    messageId: "",
                  });
                  break;

                case "tool_call_start":
                  currentToolCall = {
                    id: proxyEvent.id,
                    name: proxyEvent.name,
                    arguments: "",
                  };
                  stream.push({
                    type: "tool_call_start",
                    id: proxyEvent.id,
                    name: proxyEvent.name,
                    messageId: "",
                  });
                  break;

                case "tool_call_delta":
                  if (currentToolCall && currentToolCall.id === proxyEvent.id) {
                    currentToolCall.arguments += proxyEvent.delta;
                  }
                  stream.push({
                    type: "tool_call_delta",
                    id: proxyEvent.id,
                    delta: proxyEvent.delta,
                  } as AssistantMessageEvent);
                  break;

                case "tool_call_end":
                  stream.push({
                    type: "tool_call_end",
                    id: proxyEvent.id,
                    arguments: proxyEvent.arguments,
                  } as AssistantMessageEvent);
                  break;

                case "done": {
                  partial.stopReason = proxyEvent.stopReason;
                  partial.usage = proxyEvent.usage;
                  stream.push({
                    type: "message_end",
                    usage: proxyEvent.usage,
                    stopReason: proxyEvent.stopReason,
                    model: proxyEvent.model,
                  } as AssistantMessageEvent);
                  break;
                }

                case "error": {
                  stream.push({
                    type: "error",
                    message: proxyEvent.message,
                  });
                  break;
                }
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      }

      if (options.signal?.aborted) {
        throw new Error("Request aborted by user");
      }

      stream.end();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      stream.push({
        type: "error",
        message: errorMessage,
      });
      stream.end();
    } finally {
      if (options.signal) {
        options.signal.removeEventListener("abort", abortHandler);
      }
    }
  })();

  return stream;
}
