// @jawere/tui — Public API
// Display helpers, prompt, spinner, tag autocomplete.
// Re-exports shared utilities from @jawere/pi-tui.

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

// ── Re-exports from @jawere/pi-tui (single source of truth) ────

export {
  matchesKey,
  parseKey,
  Key,
  type KeyId,
  setKittyProtocolActive,
  isKittyProtocolActive,
  decodeKittyPrintable,
  decodePrintableKey,
} from "@jawere/pi-tui";

export {
  fuzzyMatch,
  fuzzyFilter,
  type FuzzyMatch,
} from "@jawere/pi-tui";

export {
  visibleWidth,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@jawere/pi-tui";

export {
  findWordBackward,
  findWordForward,
} from "@jawere/pi-tui";

export { KillRing } from "@jawere/pi-tui";

export {
  TUI_KEYBINDINGS,
  KeybindingsManager,
  getKeybindings,
  setKeybindings,
  type Keybinding,
  type KeybindingDefinitions,
  type KeybindingsConfig,
} from "@jawere/pi-tui";
