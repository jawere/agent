// @jawere/ai — Convenience wrappers: streamSimple() and completeSimple()

import type {
  Model,
  Context,
  Message,
  AssistantMessage,
  AssistantMessageEventStream,
  SimpleStreamOptions,
  TextContent,
  ToolCallContent,
} from "./types.ts";
import { EventStream } from "./event-stream.ts";
import type { Provider } from "./types.ts";

/**
 * Stream a completion using any provider/model.
 * This is the simplest entry point — pass a provider, model, and context.
 */
export function streamSimple(
  provider: Provider,
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return provider.stream(model, context, options);
}

/**
 * Non-streaming completion — accumulates the full response.
 * Returns the complete AssistantMessage.
 */
export async function completeSimple(
  provider: Provider,
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const stream = provider.stream(model, context, options);

  let messageContent: (TextContent | ToolCallContent)[] = [];
  let currentToolCall: ToolCallContent | null = null;
  let usage = undefined;
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let modelId = model.id;

  for await (const event of stream) {
    switch (event.type) {
      case "message_delta":
        const lastText = messageContent[messageContent.length - 1];
        if (lastText && lastText.type === "text") {
          lastText.text += event.delta;
        } else {
          messageContent.push({ type: "text", text: event.delta });
        }
        break;

      case "tool_call_start":
        currentToolCall = {
          type: "toolCall",
          id: event.id,
          name: event.name,
          arguments: "",
        };
        break;

      case "tool_call_delta":
        if (currentToolCall && currentToolCall.id === event.id) {
          currentToolCall.arguments += event.delta;
        }
        break;

      case "tool_call_end":
        if (currentToolCall && currentToolCall.id === event.id) {
          messageContent.push(currentToolCall);
          currentToolCall = null;
        }
        break;

      case "message_end":
        usage = event.usage;
        stopReason = event.stopReason;
        errorMessage = event.errorMessage;
        break;

      case "error":
        errorMessage = event.message;
        stopReason = "error";
        break;
    }
  }

  return {
    role: "assistant",
    content: messageContent,
    usage,
    stopReason,
    errorMessage,
    model: modelId,
  };
}

/**
 * Single-turn: send one user message and get back the assistant response.
 * Creates a temporary context with just the user message.
 */
export async function oneShot(
  provider: Provider,
  model: Model,
  userMessage: string,
  systemPrompt?: string,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const context: Context = [];

  if (systemPrompt) {
    context.push({
      role: "user",
      content: [{ type: "text", text: systemPrompt }],
    });
  }

  context.push({
    role: "user",
    content: [{ type: "text", text: userMessage }],
  });

  return completeSimple(provider, model, context, options);
}

/**
 * Multi-turn conversation helper.
 * Pass in a provider, model, and message history, get the next response.
 */
export async function chat(
  provider: Provider,
  model: Model,
  messages: Message[],
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  return completeSimple(provider, model, messages, options);
}
