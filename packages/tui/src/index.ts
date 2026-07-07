// @jawere/tui — Public API

export { createSpinner } from "./spinner.ts";
export type { Spinner } from "./spinner.ts";
export { createPrompt } from "./prompt.ts";
export type { PromptOptions } from "./prompt.ts";
export {
  formatToolStart,
  formatToolEnd,
  writeToolLine,
  writeAssistantResponse,
  resetResponseNewline,
  stripThinking,
  createDisplayState,
  type DisplayState,
} from "./display.ts";
export {
  loadFileList,
  matchFiles,
  type TagState,
} from "./tag-autocomplete.ts";
export {
  matchesKey,
  parseKey,
  Key,
  type KeyId,
  setKittyProtocolActive,
  isKittyProtocolActive,
  decodeKittyPrintable,
  decodePrintableKey,
} from "./keys.ts";
export {
  fuzzyMatch,
  fuzzyFilter,
  type FuzzyMatch,
} from "./fuzzy.ts";
export {
  visibleWidth,
  truncateToWidth,
  wrapTextWithAnsi,
} from "./utils.ts";
export {
  findWordBackward,
  findWordForward,
} from "./word-navigation.ts";
export { KillRing } from "./kill-ring.ts";
export {
  TUI_KEYBINDINGS,
  KeybindingsManager,
  getKeybindings,
  setKeybindings,
  type Keybinding,
  type KeybindingDefinitions,
  type KeybindingsConfig,
} from "./keybindings.ts";
