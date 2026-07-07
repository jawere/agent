// @jawere/agent — Agent types for the agent loop

import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolResultMessage,
  Usage,
} from "@jawere/ai";

export type { Model };

/**
 * Stream function used by the agent loop.
 *
 * Contract:
 * - Must not throw or return a rejected promise for request/model/runtime failures.
 * - Must return an AssistantMessageEventStream.
 * - Failures must be encoded in the returned stream via protocol events and a
 *   final AssistantMessage with stopReason "error" or "aborted" and errorMessage.
 */
export type StreamFn = (
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

// ── Execution & queue modes ─────────────────────────────────────────

/**
 * How tool calls from a single assistant message are executed.
 * - "sequential": each tool call is prepared, executed, and finalized before the next.
 * - "parallel": tool calls are prepared sequentially, then executed concurrently.
 *   `tool_execution_end` is emitted in tool completion order, tool-result messages
 *   are emitted in assistant source order.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * How many queued user messages are injected at drain points.
 * - "all": drain every queued message at that point.
 * - "one-at-a-time": drain only the oldest queued message.
 */
export type QueueMode = "all" | "one-at-a-time";

// ── Tool types ──────────────────────────────────────────────────────

/** A single tool call content block from an assistant message. */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/** Final or partial result produced by a tool. */
export interface AgentToolResult<T = any> {
  /** Text or image content returned to the model. */
  content: (TextContent | ImageContent)[];
  /** Arbitrary structured details for logs or UI rendering. */
  details: T;
  /**
   * Hint that the agent should stop after the current tool batch.
   * Early termination only happens when every finalized tool result in the batch sets this to true.
   */
  terminate?: boolean;
}

/**
 * Callback used by tools to stream partial execution updates.
 * Scoped to the current execute() invocation. Calls after the tool promise settles are ignored.
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Tool definition used by the agent runtime. */
export interface AgentTool<TParameters = unknown, TDetails = any> {
  name: string;
  description: string;
  parameters: TParameters;
  /** Human-readable label for UI display. */
  label?: string;
  /** Optional compatibility shim for raw tool-call arguments before validation. */
  prepareArguments?: (args: unknown) => unknown;
  /** Execute the tool call. Throw on failure instead of encoding errors in `content`. */
  execute: (
    toolCallId: string,
    args: TParameters,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  /** Per-tool execution mode override. */
  executionMode?: ToolExecutionMode;
  /** Whether this tool's execution is hidden from the user. */
  silent?: boolean;
  /** Whether this tool is file-oriented (gets special styling). */
  fileOriented?: boolean;
  /** Whether this tool is read-only. */
  readOnly?: boolean;
}

// ── Tool hook types ─────────────────────────────────────────────────

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  context: AgentContext;
}

export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: AgentToolCall;
  args: unknown;
  result: AgentToolResult;
  isError: boolean;
  context: AgentContext;
}

export interface ShouldStopAfterTurnContext {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}

export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

/** Replacement runtime state for the agent loop before the next provider request. */
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
  model?: Model;
  thinkingLevel?: ThinkingLevel;
}

// ── Thinking level ──────────────────────────────────────────────────

/** Thinking/reasoning level for models that support it. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

// ── Extensible custom messages ──────────────────────────────────────

/**
 * Extensible interface for custom app messages.
 * Apps can extend via declaration merging:
 *
 * @example
 * declare module "@jawere/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 */
export interface CustomAgentMessages {
  // Empty by default — apps extend via declaration merging
}

/**
 * AgentMessage: Union of LLM messages + custom messages.
 * This abstraction allows apps to add custom message types while maintaining
 * type safety and compatibility with the base LLM messages.
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

// ── Agent state ─────────────────────────────────────────────────────

/** Public agent state. `tools` and `messages` use accessor properties. */
export interface AgentState {
  /** System prompt sent with each model request. */
  systemPrompt: string;
  /** Active model used for future turns. */
  model: Model;
  /** Requested reasoning level for future turns. */
  thinkingLevel: ThinkingLevel;
  /** Available tools. Assigning copies the top-level array. */
  set tools(tools: AgentTool[]);
  get tools(): AgentTool[];
  /** Conversation transcript. Assigning copies the top-level array. */
  set messages(messages: AgentMessage[]);
  get messages(): AgentMessage[];
  /** True while the agent is processing a prompt or continuation. */
  readonly isStreaming: boolean;
  /** Partial assistant message for the current streamed response, if any. */
  readonly streamingMessage?: AgentMessage;
  /** Tool call ids currently executing. */
  readonly pendingToolCalls: ReadonlySet<string>;
  /** Error message from the most recent failed or aborted assistant turn, if any. */
  readonly errorMessage?: string;
}

// ── Agent context ───────────────────────────────────────────────────

export interface AgentContext {
  /** System prompt included with the request. */
  systemPrompt: string;
  /** Transcript visible to the model. */
  messages: AgentMessage[];
  /** Tools available for this run. */
  tools?: AgentTool[];
}

// ── Agent loop config ───────────────────────────────────────────────

export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model;

  /**
   * Converts AgentMessage[] to LLM-compatible Message[] before each LLM call.
   * Each AgentMessage must be converted to a UserMessage, AssistantMessage, or ToolResultMessage.
   * AgentMessages that cannot be converted should be filtered out.
   *
   * Contract: must not throw or reject. Return a safe fallback value instead.
   */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

  /**
   * Optional transform applied to the context before convertToLlm.
   * Use for context window management, pruning old messages, etc.
   *
   * Contract: must not throw or reject. Return original messages or safe fallback.
   */
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;

  /**
   * Resolves an API key dynamically for each LLM call.
   * Useful for short-lived OAuth tokens that may expire during long tool executions.
   *
   * Contract: must not throw or reject. Return undefined when no key is available.
   */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

  /**
   * Called after each turn fully completes and turn_end has been emitted.
   * Return true to emit agent_end and exit before polling queues.
   *
   * Contract: must not throw or reject.
   */
  shouldStopAfterTurn?: (
    context: ShouldStopAfterTurnContext,
  ) => boolean | Promise<boolean>;

  /**
   * Called after turn_end and before the loop decides to start another turn.
   * Return replacement context/model/thinking state for the next turn.
   */
  prepareNextTurn?: (
    context: PrepareNextTurnContext,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

  /**
   * Returns steering messages to inject into the conversation mid-run.
   * Called after the current turn finishes executing tool calls, unless shouldStopAfterTurn exits first.
   *
   * Contract: must not throw or reject. Return [] when no messages available.
   */
  getSteeringMessages?: () => Promise<AgentMessage[]>;

  /**
   * Returns follow-up messages to process after the agent would otherwise stop.
   * Called when the agent has no more tool calls and no steering messages.
   *
   * Contract: must not throw or reject. Return [] when no messages available.
   */
  getFollowUpMessages?: () => Promise<AgentMessage[]>;

  /** Tool execution mode. Default: "parallel". */
  toolExecution?: ToolExecutionMode;

  /**
   * Called before a tool is executed, after arguments have been validated.
   * Return { block: true } to prevent execution.
   */
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;

  /**
   * Called after a tool finishes executing, before tool_execution_end is emitted.
   * Return an AfterToolCallResult to override parts of the executed tool result.
   * Omitted fields keep their original values. No deep merge.
   */
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
}

// ── Agent events ────────────────────────────────────────────────────

/**
 * Events emitted by the Agent for UI updates.
 * agent_end is the last event for a run, but awaited subscribe() listeners
 * are still part of run settlement. The agent becomes idle only after they finish.
 */
export type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start"; sessionId?: string }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle — one assistant response + any tool calls/results
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle — emitted for user, assistant, and toolResult messages
  | { type: "message_start"; message: AgentMessage }
  // Only emitted for assistant messages during streaming
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution lifecycle
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

/** Callback for sinking agent events (typically UI). */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

// ── Subscriber type ─────────────────────────────────────────────────

export type AgentSubscriber = (event: AgentEvent, signal: AbortSignal) => void | Promise<void>;
