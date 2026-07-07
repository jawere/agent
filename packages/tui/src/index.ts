// @jawere/tui — Public API

// Jawere's own TUI layer (user-facing)
export { createSpinner } from "./spinner.ts";
export type { Spinner } from "./spinner.ts";
export { createPrompt } from "./prompt.ts";
export type { PromptOptions } from "./prompt.ts";
export {
  formatToolStart,
  formatToolEnd,
  writeToolLine,
  writeAssistantResponse,
  stripThinking,
  createDisplayState,
  type DisplayState,
} from "./display.ts";
export {
  loadFileList,
  matchFiles,
  type TagState,
} from "./tag-autocomplete.ts";

// Pi's full-featured TUI (available for coding-agent's interactive mode)
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./pi/autocomplete.ts";
export { Box } from "./pi/components/box.ts";
export { CancellableLoader } from "./pi/components/cancellable-loader.ts";
export { Editor, type EditorOptions, type EditorTheme } from "./pi/components/editor.ts";
export { Image, type ImageOptions, type ImageTheme } from "./pi/components/image.ts";
export { Input } from "./pi/components/input.ts";
export { Loader, type LoaderIndicatorOptions } from "./pi/components/loader.ts";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./pi/components/markdown.ts";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./pi/components/select-list.ts";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./pi/components/settings-list.ts";
export { Spacer } from "./pi/components/spacer.ts";
export { Text } from "./pi/components/text.ts";
export { TruncatedText } from "./pi/components/truncated-text.ts";
export type { EditorComponent } from "./pi/editor-component.ts";
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./pi/fuzzy.ts";
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./pi/keybindings.ts";
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./pi/keys.ts";
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./pi/stdin-buffer.ts";
export { ProcessTerminal, type Terminal } from "./pi/terminal.ts";
export {
	parseOsc11BackgroundColor,
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
} from "./pi/terminal-colors.ts";
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
	type TerminalCapabilities,
} from "./pi/terminal-image.ts";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	isFocusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	type SizeValue,
	TUI,
} from "./pi/tui.ts";
export { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./pi/utils.ts";
