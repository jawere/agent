// @jawere/agent — Public API

// Core Agent
export { Agent } from "./agent.ts";
export type { AgentOptions } from "./agent.ts";

// Loop functions
export {
  agentLoop,
  agentLoopContinue,
  runAgentLoop,
  runAgentLoopContinue,
} from "./agent-loop.ts";

// Proxy utilities
export { streamProxy } from "./proxy.ts";
export type {
  ProxyAssistantMessageEvent,
  ProxyStreamOptions,
} from "./proxy.ts";

// Types
export * from "./types.ts";
