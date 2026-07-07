// @jawere/coding-agent — Public API

export { SYSTEM_PROMPT, buildSystemPrompt } from "./system-prompt.js";
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
export { runScanner, cacheIsStale, loadChecksums, loadFileList } from "./scanner.js";
export {
  indexTestFiles,
  findTestsForSource,
  buildTestFilter,
  packageTestCommand,
  getChangedPackages,
  type TestIndexEntry,
  type DescribeBlock,
} from "./test-indexer.js";
export {
  loadProjectContext,
  saveProjectContext,
  createEmptyContext,
  getChangedFiles,
  recordFileRead,
  recordFileModified,
  isFileStale,
  type ProjectContext,
} from "./state-persistence.js";

// Pi RPC agent (replaces @jawere/agent for the agent loop)
export { PiRpcAgent, type ExtensionUIHandler, type ExtensionUIRequest, type ExtensionUIResponse, type AgentEvent, type AgentEventListener, type PiSlashCommand } from "./pi-rpc-agent.js";
export { createDisplaySubscriber, type DisplayState } from "./agent-runner.js";
