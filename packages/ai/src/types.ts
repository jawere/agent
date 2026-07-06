// @jawere/ai — Core types for AI interactions

// ── Message types ──────────────────────────────────────────────────

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: { type: "base64"; mediaType: string; data: string } | { type: "url"; url: string };
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultContent {
  type: "toolResult";
  toolCallId: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
}

export type ContentBlock = TextContent | ImageContent | ToolCallContent | ToolResultContent;

export interface UserMessage {
  role: "user";
  content: (TextContent | ImageContent)[];
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ToolCallContent)[];
  usage?: Usage;
  stopReason?: string;
  errorMessage?: string;
  model?: string;
}

export interface ToolResultMessage {
  role: "toolResult";
  content: ToolResultContent[];
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export type Context = Message[];

// ── Tool definitions for LLM providers ────────────────────────────

/** LLM-facing tool definition — passed via SimpleStreamOptions.tools */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── Model types ────────────────────────────────────────────────────

export type KnownApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "azure-openai-responses"
  | "bedrock-converse-stream"
  | "mistral-conversations"
  | "github-copilot"
  | "openrouter";

export type Api = KnownApi | (string & {});

export type KnownProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "google-vertex"
  | "azure"
  | "amazon-bedrock"
  | "mistral"
  | "deepseek"
  | "github-copilot"
  | "openrouter"
  | "groq"
  | "xai"
  | "fireworks"
  | "together"
  | "cloudflare"
  | "custom";

export type ProviderId = KnownProvider | string;

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
export type ModelThinkingLevel = "off" | ThinkingLevel;

export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
  xhigh?: number;
}

export interface CostInfo {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: CostInfo & { total: number };
}

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: ProviderId;
  baseUrl: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  cost: CostInfo;
  thinkingBudgets?: ThinkingBudgets;
  supportsPromptCaching?: boolean;
  supportsImages?: boolean;
}

// ── Stream types ───────────────────────────────────────────────────

export type AssistantMessageEvent =
  | { type: "message_start"; messageId: string; stopReason?: undefined; errorMessage?: undefined }
  | { type: "message_delta"; delta: string; messageId: string; stopReason?: undefined; errorMessage?: undefined }
  | { type: "tool_call_start"; id: string; name: string; messageId: string; stopReason?: undefined; errorMessage?: undefined }
  | { type: "tool_call_delta"; id: string; delta: string; stopReason?: undefined; errorMessage?: undefined }
  | { type: "tool_call_end"; id: string; arguments: string; stopReason?: undefined; errorMessage?: undefined }
  | { type: "message_end"; usage?: Usage; stopReason?: string; errorMessage?: string; model?: string }
  | { type: "error"; message: string; errorMessage?: string; stopReason?: string };

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  finalResult: Promise<AssistantMessage>;
}

// ── Stream options ─────────────────────────────────────────────────

export type Transport = "sse" | "websocket" | "auto";

export interface SimpleStreamOptions {
  thinkingLevel?: ModelThinkingLevel;
  thinkingBudget?: number;
  transport?: Transport;
  signal?: AbortSignal;
  abortController?: AbortController;
  cacheRetention?: "none" | "short" | "long";
  /** Per-request API key override */
  apiKey?: string;
  /** Session identifier forwarded to cache-aware backends */
  sessionId?: string;
  /** Optional per-level thinking token budgets */
  thinkingBudgets?: ThinkingBudgets;
  /** Optional cap for provider-requested retry delays */
  maxRetryDelayMs?: number;
  /** Tool definitions passed to the provider (converted to API-specific format) */
  tools?: ToolDef[];
  /** Called when raw payload is sent to the provider */
  onPayload?: (payload: unknown) => void;
  /** Called when raw response is received from the provider */
  onResponse?: (response: unknown) => void;
}

// ── Provider types ─────────────────────────────────────────────────

export type ProviderHeaders = Record<string, string | (() => string | Promise<string>)>;

export interface ApiKeyAuth {
  type: "apiKey";
  resolve(): string | undefined | Promise<string | undefined>;
  /** Env var or command that supplies the key */
  source?: string;
}

export interface OAuthAuth {
  type: "oauth";
  provider: string;
  scopes?: string[];
}

export type ProviderAuth = ApiKeyAuth | OAuthAuth;

export interface Provider<TApi extends Api = Api> {
  readonly id: ProviderId;
  readonly name: string;
  readonly baseUrl?: string;
  readonly headers?: ProviderHeaders;
  readonly auth: ProviderAuth;
  getModels(): readonly Model<TApi>[];
  refreshModels?(): Promise<void>;
  stream(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

// ── Model registry ─────────────────────────────────────────────────

export interface Models {
  getProviders(): readonly Provider[];
  getProvider(id: ProviderId): Provider | undefined;
  getModel(id: string): Model | undefined;
  listModels(): Model[];
  refreshAll(): Promise<void>;
}
