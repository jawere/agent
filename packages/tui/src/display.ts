// @jawere/tui — Terminal display helpers for the agent

// ── Gruvbox dark palette ──────────────────────────────────────────
//  https://github.com/morhetz/gruvbox

const G_BG     = "\x1b[48;2;40;40;40m";   // #282828 — bg (hard)
const G_BG0    = "\x1b[48;2;29;32;33m";   // #1d2021 — bg0 (hard)
const G_GREEN  = "\x1b[38;2;184;187;38m"; // #b8bb26 — primary accent (tools, paths)
const G_GREEN2 = "\x1b[38;2;142;192;124m";// #8ec07c — secondary green (aqua)
const G_YELLOW = "\x1b[38;2;250;189;47m"; // #fabd2f
const G_ORANGE = "\x1b[38;2;254;128;25m"; // #fe8019
const G_RED    = "\x1b[38;2;251;73;52m";  // #fb4934
const G_BLUE   = "\x1b[38;2;131;165;152m";// #83a598
const G_GRAY   = "\x1b[38;2;146;131;116m";// #928374 — muted text
const G_DIM    = "\x1b[38;2;102;92;84m";  // #665c54 — details
const G_FG     = "\x1b[38;2;235;219;178m";// #ebdbb2 — body text
const G_FG0    = "\x1b[38;2;251;241;199m";// #fbf1c7 — bright text

const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";

// ── Tool classification ───────────────────────────────────────────

const FILE_TOOLS    = new Set(["read", "write", "edit"]);
const INSPECT_TOOLS = new Set(["stat", "ls", "diff", "find"]);
const SEARCH_TOOLS  = new Set(["web_search", "docs", "grep"]);
const SHELL_TOOLS   = new Set(["bash"]);

/** Color-code tool names by category. */
function toolColor(name: string): string {
  if (FILE_TOOLS.has(name))    return G_GREEN;
  if (INSPECT_TOOLS.has(name)) return G_BLUE;
  if (SEARCH_TOOLS.has(name))  return G_GREEN2;
  if (SHELL_TOOLS.has(name))   return G_GRAY;
  return G_GREEN;
}

// ── Tool line formatting ───────────────────────────────────────────

export interface ToolLineOptions {
  /** Maximum line width (defaults to terminal width, capped at 120) */
  maxWidth?: number;
}

/**
 * Format a tool execution start line.
 * Style:  name: path/arg  — color-coded by tool category.
 *
 * Examples:
 *   read: packages/ai/src/providers/bedrock.ts [L340-509]
 *   write: packages/tui/src/display.ts
 *   bash: npm run build
 *   grep: function AgentTool
 *   web_search: typescript 5.6
 */
export function formatToolStart(
  name: string,
  args: Record<string, unknown>,
  options: ToolLineOptions = {},
): string {
  const c = toolColor(name);
  const maxLen = options.maxWidth ?? Math.min((process.stdout.columns || 80) - 2, 120);

  // Build detail after "name: "
  let detail = "";

  // Path-based tools
  if (args.path && typeof args.path === "string") {
    detail = String(args.path);

    if (name === "read") {
      const parts: string[] = [];
      const offset: number | undefined = typeof args.offset === "number" ? args.offset : undefined;
      const limit: number | undefined = typeof args.limit === "number" ? args.limit : undefined;
      if (offset !== undefined) parts.push(`L${offset}`);
      if (limit !== undefined) {
        if (parts.length > 0 && offset !== undefined) {
          parts.push(`-${offset + limit - 1}`);
        } else {
          parts.push(`L1-${limit}`);
        }
      }
      if (parts.length > 0) detail += ` ${G_DIM}[${parts.join("")}]${RESET}`;
    }
  } else if (args.command && typeof args.command === "string") {
    detail = String(args.command).slice(0, 80);
  } else if (args.pattern && typeof args.pattern === "string") {
    detail = String(args.pattern).slice(0, 60);
  } else if (args.query && typeof args.query === "string") {
    detail = String(args.query).slice(0, 60);
  }

  const colon = `${DIM}:${RESET} `;
  let line = detail
    ? `${c}${name}${RESET}${colon}${G_FG}${detail}${RESET}`
    : `${c}${name}${RESET}`;

  if (line.length > maxLen) {
    line = line.slice(0, maxLen - 3) + "...";
  }

  return line;
}

/**
 * Format a tool execution completion line.
 * Returns just the tool name with checkmark/cross.
 */
export function formatToolEnd(
  name: string,
  isError: boolean,
): string {
  const color = toolColor(name);
  const marker = isError ? `${G_RED}✗${RESET}` : `${G_GREEN}✓${RESET}`;
  return `${color}${name}${RESET} ${marker}`;
}

// ── Display singleton ──────────────────────────────────────────────

export interface DisplayState {
  /** Accumulated streamed text for the current turn */
  streamedText: string[];
  /** Whether we detected tool calls in the current turn */
  hasToolCalls: boolean;
  /** Most recent tool execution names (for dedup in display) */
  lastToolName: string;
}

export function createDisplayState(): DisplayState {
  return { streamedText: [], hasToolCalls: false, lastToolName: "" };
}

/**
 * Write a completed tool line atomically (name, detail, checkmark on one line).
 * Single-phase write avoids orphaned checkmarks from race conditions.
 */
export function writeToolLine(name: string, args: Record<string, unknown>, isError: boolean): void {
  const line = formatToolStart(name, args);
  const marker = isError ? ` ${G_RED}✗${RESET}` : ` ${G_GREEN}✓${RESET}`;
  process.stderr.write(`\r\x1b[K${line}${marker}\n`);
}

/**
 * Render markdown-ish assistant response to stdout with Gruvbox theme colors.
 * Supports headings (#), bold (**), italic (*), inline code (`),
 * code blocks (```), bullet lists (-), horizontal rules (---), and links.
 */
/** Track whether we've already written the leading newline for this turn. */
let _responseNewlineWritten = false;

/** Reset the newline tracker (call at start of each turn). */
export function resetResponseNewline(): void {
  _responseNewlineWritten = false;
}

export function writeAssistantResponse(text: string): void {
  if (!text.trim()) return;

  // Only emit one leading newline per turn, on stderr to stay below the spinner
  if (!_responseNewlineWritten) {
    process.stderr.write("\n");
    _responseNewlineWritten = true;
  }

  const rendered = renderMarkdown(text);
  process.stdout.write(rendered);
  process.stdout.write("\n");
}

// ── Markdown renderer ─────────────────────────────────────────────

/**
 * Render a markdown string to terminal with Gruvbox-appropriate ANSI styling.
 * This is a simple line-by-line renderer — no AST, robust enough for LLM output.
 */
function renderMarkdown(text: string): string {
  // Detect fenced code blocks first
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Fenced code block start/end
    const fenceMatch = line.trim().match(/^(`{3,})(\S*)$/);
    if (fenceMatch && !inCodeBlock) {
      inCodeBlock = true;
      codeBlockLang = fenceMatch[2];
      out.push(G_DIM + "┌─" + G_GRAY + (codeBlockLang ? ` ${codeBlockLang} ` : "") + G_DIM + "─".repeat(Math.max(0, 40 - (codeBlockLang ? codeBlockLang.length + 2 : 0))) + RESET);
      continue;
    }
    if (fenceMatch && inCodeBlock) {
      inCodeBlock = false;
      out.push(G_DIM + "└" + "─".repeat(40) + RESET);
      continue;
    }

    if (inCodeBlock) {
      out.push(G_GRAY + " │ " + G_FG0 + line + RESET);
      continue;
    }

    // Horizontal rule
    if (/^(?:---|___|\*\*\*)\s*$/.test(line.trim())) {
      out.push(G_DIM + "─".repeat(Math.min(process.stdout.columns || 60, 60)) + RESET);
      continue;
    }

    // Headings
    if (line.startsWith("### ")) {
      out.push(BOLD + G_YELLOW + line.slice(4).trim() + RESET);
      continue;
    }
    if (line.startsWith("## ")) {
      out.push(BOLD + G_ORANGE + line.slice(3).trim() + RESET);
      continue;
    }
    if (line.startsWith("# ")) {
      out.push(BOLD + G_RED + line.slice(2).trim() + RESET);
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const content = line.slice(2);
      out.push(G_DIM + "▎" + RESET + " " + G_GRAY + renderInline(content) + RESET);
      continue;
    }

    // Bullet list
    if (/^\s*[-*+]\s+/.test(line)) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      const content = line.replace(/^\s*[-*+]\s+/, "");
      const prefix = " ".repeat(indent) + G_GREEN2 + "•" + RESET + " ";
      out.push(prefix + renderInline(content));
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      const num = line.match(/^\s*(\d+)\./)?.[1] ?? "";
      const content = line.replace(/^\s*\d+\.\s+/, "");
      const prefix = " ".repeat(indent) + G_GREEN2 + num + "." + RESET + " ";
      out.push(prefix + renderInline(content));
      continue;
    }

    // Regular line with inline formatting
    out.push(renderInline(line));
  }

  return out.join("\n");
}

/**
 * Render inline markdown within a single line.
 * Handles: **bold**, *italic*, `code`, [links](url), ~~strikethrough~~
 */
function renderInline(line: string): string {
  let result = line;

  // Bold+italic ***
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, BOLD + G_FG0 + "$1" + RESET);
  // Bold **
  result = result.replace(/\*\*(.+?)\*\*/g, BOLD + G_FG0 + "$1" + RESET);
  // Italic * (but not bullet markers)
  result = result.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, G_FG0 + "$1" + RESET);
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, G_FG0 + "$1" + RESET);
  // Inline code `
  result = result.replace(/`([^`]+)`/g, G_GREEN + "$1" + RESET);
  // Strikethrough ~~
  result = result.replace(/~~(.+?)~~/g, G_DIM + "$1" + RESET);
  // Links [text](url) — show text, dim url
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, G_BLUE + "$1" + RESET + " " + G_DIM + "($2)" + RESET);

  return result;
}

/**
 * Strip ANSI escape sequences from a string (for width calculation).
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Strip thinking blocks from LLM output.
 * Handles: <think>...</think>, <thinking>...</thinking>,
 * and DeepSeek-style <｜end▁of▁thinking｜>... response blocks.
 */
export function stripThinking(content: string): string {
  let result = content;

  // Strip reasoning/thinking blocks
  result = result.replace(/<\/?think>/gi, "");
  result = result.replace(/<\/?thinking>/gi, "");
  result = result.replace(/<\|think\|>[\s\S]*?<\|response\|>/gi, "");
  result = result.replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, "");

  // Strip XML-wrapped tool call tags that leak through streaming text:
  // <file>read</file>, <path>...</path>, <output>...</output>,
  // <result>...</result>, <invoke name="...">...</invoke>
  result = result.replace(/<\/?(?:file|path|output|result|invoke|parameter|tool_call)[^>]*>/gi, "");

  // Strip self-closing variants like <file name="x" />
  result = result.replace(/<(?:file|path|output|result|invoke|parameter|tool_call)\b[^>]*\/>/gi, "");

  // Collapse triple+ newlines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}
