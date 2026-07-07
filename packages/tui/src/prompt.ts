// @jawere/tui — Terminal prompt
// Uses Node.js readline for line editing. No external TUI library dependency.

import * as readline from "readline";

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

// ── Public API ───────────────────────────────────────────────────

export interface PromptOptions {
  /** File list for @-tag autocomplete. Called each time @ is typed. */
  getFiles?: () => string[];
  /** Slash commands for / autocomplete */
  commands?: string[];
}

export function createPrompt(_opts?: PromptOptions): {
  prompt: () => Promise<string>;
  enableBracketedPaste: () => void;
  disableBracketedPaste: () => void;
} {
  const isTTY =
    process.stdin.isTTY && typeof process.stdin.setRawMode === "function";

  return {
    prompt: isTTY ? simplePrompt : simplePrompt,

    enableBracketedPaste: () => {
      if (isTTY) {
        process.stdout.write("\x1b[?2004h");
      }
    },
    disableBracketedPaste: () => {
      if (isTTY) {
        process.stdout.write("\x1b[?2004l");
      }
    },
  };
}
