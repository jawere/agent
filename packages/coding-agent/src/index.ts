// @jawere/coding-agent — Public API

export { SYSTEM_PROMPT } from "./system-prompt.js";
export { loadConfig, hasApiKey, type Config } from "./config.js";
export {
  encrypt,
  decrypt,
  saveConfig,
  loadSavedConfig,
  saveKey,
  loadKey,
  hasKey,
  deleteKey,
  type SavedConfig,
} from "./crypto.js";
export {
  initDb,
  closeDb,
  createSession,
  listSessions,
  getSessionMessages,
  deleteSession,
  persistMessages,
  replaceSessionMessages,
  type SessionRow,
  type MessageRow,
} from "./db.js";
export { runScanner, cacheIsStale, loadChecksums, loadFileList } from "./scanner.js";
export { runAgent, type RunAgentOptions, type RunAgentResult } from "./agent-runner.js";
export { TOOL_DEFS, executeTool, type ToolCall, type ToolResult } from "./tools.js";
export { createAgentTools } from "./agent-tools.js";

// Session management (Step 4 — tree-based JSONL)
export * from "./session/index.js";
