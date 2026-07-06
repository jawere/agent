// @jawere/agent — Low-level agent loop

/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  EventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCallContent,
  type ToolDef,
  type ToolResultMessage,
} from "@jawere/ai";
import { estimateTokens, withRetry } from "@jawere/ai";
import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  StreamFn,
} from "./types.ts";

// ── EventStream factories ────────────────────────────────────────────

/**
 * Start an agent loop with new prompt messages.
 * Returns an EventStream that yields AgentEvents and resolves to AgentMessage[].
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();

  void runAgentLoop(
    prompts,
    context,
    config,
    async (event) => stream.push(event),
    signal,
    streamFn,
  ).then((messages) => stream.end(messages));

  return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries — context already has user message or tool results.
 *
 * The last message in context must convert to a user or toolResult message via convertToLlm.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }

  const lastRole = context.messages[context.messages.length - 1].role;
  if (lastRole === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const stream = createAgentStream();

  void runAgentLoopContinue(
    context,
    config,
    async (event) => stream.push(event),
    signal,
    streamFn,
  ).then((messages) => stream.end(messages));

  return stream;
}

// ── Low-level run functions ──────────────────────────────────────────

export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoopInternal(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }

  const lastRole = context.messages[context.messages.length - 1].role;
  if (lastRole === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoopInternal(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

// ── Internal implementation ──────────────────────────────────────────

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoopInternal(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  let pendingMessages: AgentMessage[] =
    (await config.getSteeringMessages?.()) || [];

  // Outer loop: continues when queued follow-up messages arrive after agent would stop
  while (true) {
    let hasMoreToolCalls = true;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (signal?.aborted) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // Process pending messages (inject before next assistant response)
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // Stream assistant response
      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        emit,
        streamFn,
      );
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Check for tool calls
      const toolCalls = message.content.filter(
        (c) => c.type === "toolCall",
      ) as AgentToolCall[];

      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        const executedToolBatch = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          emit,
        );
        toolResults.push(...executedToolBatch.messages);
        hasMoreToolCalls = !executedToolBatch.terminate;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      // Prepare next turn
      const nextTurnContext = { message, toolResults, context: currentContext, newMessages };
      const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
      if (nextTurnSnapshot) {
        currentContext = nextTurnSnapshot.context ?? currentContext;
        config = {
          ...config,
          model: nextTurnSnapshot.model ?? config.model,
          thinkingLevel:
            nextTurnSnapshot.thinkingLevel === undefined
              ? config.thinkingLevel
              : nextTurnSnapshot.thinkingLevel === "off"
                ? undefined
                : nextTurnSnapshot.thinkingLevel,
        };
      }

      // Should stop?
      if (
        await config.shouldStopAfterTurn?.({
          message,
          toolResults,
          context: currentContext,
          newMessages,
        })
      ) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // Agent would stop here. Check for follow-up messages.
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    // No more messages, exit
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

// ── Stream assistant response ────────────────────────────────────────

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<AssistantMessage> {
  // Apply context transform if configured (AgentMessage[] → AgentMessage[])
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // Convert to LLM-compatible messages (AgentMessage[] → Message[])
  const llmMessages = await config.convertToLlm(messages);

  // Build LLM context by prepending system prompt
  const llmContext: Context = [];
  if (context.systemPrompt) {
    llmContext.push({
      role: "user",
      content: [{ type: "text", text: context.systemPrompt }],
    });
  }
  for (const msg of llmMessages) {
    llmContext.push(msg);
  }

  const streamFunction = streamFn ?? defaultStreamFn;

  // Resolve API key if configured (important for expiring tokens)
  const resolvedApiKey =
    (config.getApiKey
      ? await config.getApiKey(config.model.provider)
      : undefined) || (config as any).apiKey;

  // Convert AgentTool[] to LLM-facing ToolDef[]
  const toolDefs: ToolDef[] | undefined = context.tools?.map((t) => {
    const params = (t.parameters as Record<string, unknown>) ?? {};
    return {
      name: t.name,
      description: t.description,
      parameters: Object.keys(params).length > 0 ? params : { type: "object", properties: {} },
    };
  });

  const streamOptions: SimpleStreamOptions = {
    ...config,
    apiKey: resolvedApiKey ?? config.apiKey,
    signal,
    tools: toolDefs,
  };

  const response = await streamFunction(config.model, llmContext, streamOptions);

  let partialContent: (TextContent | ToolCallContent)[] = [];
  let partialMessage: AgentMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "message_start":
        partialContent = [];
        partialMessage = {
          role: "assistant",
          content: [],
          model: config.model.id,
        };
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({
          type: "message_start",
          message: { ...partialMessage },
        });
        break;

      case "message_delta":
        if (addedPartial && partialMessage) {
          const lastText = partialContent[partialContent.length - 1];
          if (lastText && lastText.type === "text") {
            partialContent[partialContent.length - 1] = {
              ...lastText,
              text: lastText.text + event.delta,
            };
          } else {
            partialContent.push({ type: "text", text: event.delta });
          }
          partialMessage = {
            ...partialMessage,
            content: [...partialContent] as any,
          } as AgentMessage;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            message: { ...partialMessage } as AgentMessage,
            assistantMessageEvent: event,
          });
        }
        break;

      case "tool_call_start":
        if (addedPartial && partialMessage) {
          partialContent.push({
            type: "toolCall",
            id: event.id,
            name: event.name,
            arguments: "",
          });
          partialMessage = {
            ...partialMessage,
            content: [...partialContent] as any,
          } as AgentMessage;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            message: { ...partialMessage } as AgentMessage,
            assistantMessageEvent: event,
          });
        }
        break;

      case "tool_call_delta":
        if (addedPartial && partialMessage) {
          partialContent = partialContent.map((c) => {
            if (c.type === "toolCall" && c.id === event.id) {
              return { ...c, arguments: c.arguments + event.delta };
            }
            return c;
          });
          partialMessage = {
            ...partialMessage,
            content: [...partialContent] as any,
          } as AgentMessage;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            message: { ...partialMessage } as AgentMessage,
            assistantMessageEvent: event,
          });
        }
        break;

      case "tool_call_end":
        // Arguments already accumulated — no structural change needed
        break;

      case "message_end": {
        const finalMessage: AssistantMessage = {
          role: "assistant",
          content: [...partialContent],
          usage: event.usage,
          stopReason: event.stopReason,
          errorMessage: event.errorMessage,
          model: config.model.id,
        };

        if (addedPartial && partialMessage) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }

        if (!addedPartial) {
          await emit({
            type: "message_start",
            message: { ...finalMessage },
          });
        }
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }

      case "error": {
        const errorMessage: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `Error: ${event.message}` }],
          stopReason: "error",
          errorMessage: event.message,
          model: config.model.id,
        };

        if (addedPartial && partialMessage) {
          context.messages[context.messages.length - 1] = errorMessage;
        } else {
          context.messages.push(errorMessage);
        }

        if (!addedPartial) {
          await emit({
            type: "message_start",
            message: { ...errorMessage },
          });
        }
        await emit({ type: "message_end", message: errorMessage });
        return errorMessage;
      }
    }
  }

  // Stream ended without message_end — still return what we have
  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: [...partialContent],
    model: config.model.id,
  };

  if (addedPartial && partialMessage) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({
      type: "message_start",
      message: { ...finalMessage },
    });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

// ── Tool execution ───────────────────────────────────────────────────

type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  terminate: boolean;
};

async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter(
    (c) => c.type === "toolCall",
  ) as AgentToolCall[];

  if (toolCalls.length === 0) {
    return { messages: [], terminate: false };
  }

  const hasSequentialToolCall = toolCalls.some(
    (tc) =>
      currentContext.tools?.find((t) => t.name === tc.name)?.executionMode ===
      "sequential",
  );

  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      config,
      signal,
      emit,
    );
  }

  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    config,
    signal,
    emit,
  );
}

type FinalizedToolCallOutcome = {
  toolCall: AgentToolCall;
  result: AgentToolResult;
  isError: boolean;
};

type FinalizedToolCallEntry =
  | FinalizedToolCallOutcome
  | (() => Promise<FinalizedToolCallOutcome>);

// ── Sequential execution ─────────────────────────────────────────────

async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    if (signal?.aborted) break;

    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
    );

    let finalized: FinalizedToolCallOutcome;
    if (preparation.kind === "immediate") {
      finalized = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
    } else {
      const executed = await executePreparedToolCall(
        preparation,
        signal,
        emit,
      );
      finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
    }

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(finalizedCalls),
  };
}

// ── Parallel execution ───────────────────────────────────────────────

async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const entries: FinalizedToolCallEntry[] = [];

  for (const toolCall of toolCalls) {
    if (signal?.aborted) break;

    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
    );

    if (preparation.kind === "immediate") {
      const finalized: FinalizedToolCallOutcome = {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
      };
      await emitToolExecutionEnd(finalized, emit);
      entries.push(finalized);
      continue;
    }

    entries.push(async () => {
      const executed = await executePreparedToolCall(
        preparation,
        signal,
        emit,
      );
      const finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
  }

  const orderedFinalizedCalls = await Promise.all(
    entries.map((entry) =>
      typeof entry === "function" ? entry() : Promise.resolve(entry),
    ),
  );

  const messages: ToolResultMessage[] = [];
  for (const finalized of orderedFinalizedCalls) {
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
  };
}

function shouldTerminateToolBatch(
  finalizedCalls: FinalizedToolCallOutcome[],
): boolean {
  return (
    finalizedCalls.length > 0 &&
    finalizedCalls.every((finalized) => finalized.result.terminate === true)
  );
}

// ── Tool call preparation ────────────────────────────────────────────

type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool;
  args: unknown;
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  result: AgentToolResult;
  isError: boolean;
};

function prepareToolCallArguments(
  tool: AgentTool,
  toolCall: AgentToolCall,
): { arguments: string; args: unknown } {
  let args: unknown;
  try {
    args = JSON.parse(toolCall.arguments);
  } catch {
    throw new Error(
      `Invalid JSON arguments for tool: ${toolCall.name}`,
    );
  }

  if (tool.prepareArguments) {
    args = tool.prepareArguments(args);
  }

  return {
    arguments: JSON.stringify(args),
    args,
  };
}

async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }

  try {
    const { args } = prepareToolCallArguments(tool, toolCall);

    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args,
          context: currentContext,
        },
        signal,
      );

      if (signal?.aborted) {
        return {
          kind: "immediate",
          result: createErrorToolResult("Operation aborted"),
          isError: true,
        };
      }

      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(
            beforeResult.reason || "Tool execution was blocked",
          ),
          isError: true,
        };
      }
    }

    if (signal?.aborted) {
      return {
        kind: "immediate",
        result: createErrorToolResult("Operation aborted"),
        isError: true,
      };
    }

    return {
      kind: "prepared",
      toolCall,
      tool,
      args,
    };
  } catch (error) {
    return {
      kind: "immediate",
      result: createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  }
}

// ── Tool call execution ──────────────────────────────────────────────

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<{ result: AgentToolResult; isError: boolean }> {
  const updateEvents: Promise<void>[] = [];
  let acceptingUpdates = true;

  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args as never,
      signal,
      (partialResult) => {
        if (!acceptingUpdates) return;
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    );
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    acceptingUpdates = false;
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  } finally {
    acceptingUpdates = false;
  }
}

// ── Tool call finalization ───────────────────────────────────────────

async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: { result: AgentToolResult; isError: boolean },
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context: currentContext,
        },
        signal,
      );

      if (afterResult) {
        result = {
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      );
      isError = true;
    }
  }

  return {
    toolCall: prepared.toolCall,
    result,
    isError,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function createErrorToolResult(message: string): AgentToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

async function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
  });
}

function createToolResultMessage(
  finalized: FinalizedToolCallOutcome,
): ToolResultMessage {
  return {
    role: "toolResult",
    content: [
      {
        type: "toolResult",
        toolCallId: finalized.toolCall.id,
        content: finalized.result.content,
        isError: finalized.isError,
      },
    ],
  };
}

async function emitToolResultMessage(
  toolResultMessage: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
}

// ── Default stream function (placeholder) ────────────────────────────

function defaultStreamFn(
  _model: Model,
  _context: Context,
  _options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  throw new Error(
    "No stream function provided. Pass a streamFn to the agent loop, or set one on the Agent.",
  );
}
