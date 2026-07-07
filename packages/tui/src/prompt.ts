// @jawere/tui — Multiline terminal prompt powered by pi-tui Editor
// Supports @-tag file autocomplete and / command autocomplete

import * as readline from "readline";
import {
  ProcessTerminal,
  Editor,
  type EditorTheme,
  TUI,
  matchesKey,
  Key,
} from "@jawere/pi-tui";

// Gruvbox dark palette
const G_GRAY  = "\x1b[38;2;146;131;116m";
const G_GREEN = "\x1b[38;2;184;187;38m";
const G_DIM   = "\x1b[38;2;102;92;84m";
const G_FG    = "\x1b[38;2;235;219;178m";
const R       = "\x1b[0m";

function borderStyle(text: string): string {
  return `${G_GRAY}${text}${R}`;
}

const editorTheme: EditorTheme = {
  borderColor: borderStyle,
  selectList: {
    selectedPrefix: (t: string) => `${G_GREEN}${t}${R}`,
    selectedText: (t: string) => t,
    description: (t: string) => `${G_DIM}${t}${R}`,
    scrollInfo: (t: string) => `${G_DIM}${t}${R}`,
    noMatch: (t: string) => `${G_DIM}${t}${R}`,
  },
  // Use dimmed reverse video + bold instead of full reverse video for a subtler cursor
  cursorStyle: () => ["\x1b[2;7m", "\x1b[0m"],
};

function simplePrompt(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("> ", (answer: string) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── Slash commands for autocomplete ──────────────────────────────

const SLASH_COMMANDS: string[] = [
  "/help",
  "/key",
  "/key add",
  "/key delete",
  "/key list",
  "/model",
  "/model list",
  "/model list all",
  "/model switch ",
  "/provider",
  "/provider list",
  "/provider switch ",
  "/setup",
  "/clear",
  "/config",
  "/exit",
  "/quit",
];

// ── TUI-powered multiline prompt ──────────────────────────────────

function multilinePrompt(opts?: PromptOptions): Promise<string> {
  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal);
    const editor = new Editor(tui, editorTheme, { paddingX: 1 });

    let submitted = false;

    const finish = (value: string) => {
      if (submitted) return;
      submitted = true;
      tui.stop();
      resolve(value.trim() || "");
    };

    editor.onSubmit = (value: string) => {
      const trimmed = value.trim();
      if (trimmed.startsWith("@")) {
        // @file tagging — resolve files from tree-shallow.yaml
        const query = trimmed.slice(1);
        const files = opts?.getFiles?.() ?? [];
        const matches = matchTagFiles(query, files);
        if (matches.length === 1) {
          // Include file content hint
          finish(`@${matches[0]} ${query}`);
        } else if (matches.length > 0) {
          // Show matches inline
          finish(`@${matches[0]} ${query}`);
        } else {
          finish(trimmed);
        }
      } else {
        finish(trimmed);
      }
    };

    // Handle Ctrl+C and Ctrl+D
    const removeListener = tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        finish("");
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        if (editor.getText().trim() === "") {
          finish("/exit");
          return { consume: true };
        }
      }
      return undefined;
    });

    editor.disableSubmit = false;

    tui.addChild(editor);
    tui.setFocus(editor);
    tui.start();
  });
}

// ── @ tag file matching ─────────────────────────────────────────

function matchTagFiles(query: string, files: string[]): string[] {
  if (!query) return files.slice(0, 10);
  const q = query.toLowerCase();
  const results: string[] = [];

  for (const file of files) {
    const lower = file.toLowerCase();
    const base = lower.split("/").pop() || lower;
    // Prefix match on basename
    if (base.startsWith(q)) {
      results.push(file);
    }
    // Contains match
    else if (lower.includes(q)) {
      results.push(file);
    }
  }

  return results.slice(0, 10);
}

// ── Public API ───────────────────────────────────────────────────

export interface PromptOptions {
  /** File list for @-tag autocomplete. Called each time @ is typed. */
  getFiles?: () => string[];
  /** Slash commands for / autocomplete */
  commands?: string[];
}

export function createPrompt(opts?: PromptOptions): {
  prompt: () => Promise<string>;
  enableBracketedPaste: () => void;
  disableBracketedPaste: () => void;
} {
  const isTTY =
    process.stdin.isTTY && typeof process.stdin.setRawMode === "function";

  return {
    prompt: isTTY
      ? () => multilinePrompt(opts)
      : simplePrompt,

    enableBracketedPaste: () => {},
    disableBracketedPaste: () => {},
  };
}
