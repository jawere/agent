// @jawere/tui — Multiline terminal prompt with paste support and @-tag autocomplete

import * as readline from "readline";
import {
  createTagState,
  matchFiles,
  renderDropdown,
  type TagState,
} from "./tag-autocomplete.ts";

// Colors
const G_GRAY = "\x1b[38;2;146;131;116m";
const G_GREEN = "\x1b[38;2;184;187;38m";
const G_DIM   = "\x1b[38;2;102;92;84m";
const R = "\x1b[0m";
const PROMPT_STR = `${G_GRAY}>${R} `;
const CONT = "  ";

// ── Long paste threshold ────────────────────────────────────────────

const PASTE_LINE_LIMIT = 20;
const PASTE_CHAR_LIMIT = 500;

function simplePrompt(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question("> ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── Key constants ────────────────────────────────────────────────────

/** CSI: Escape [ */
const CSI = "\x1b[";
/** SS3: Escape O */
const SS3 = "\x1bO";

// ── Multiline prompt ─────────────────────────────────────────────────

function multilinePrompt(getFiles?: () => string[]): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [""];
    let row = 0;
    let col = 0;

    // Paste state
    let pasteMode = false;
    let pasteBuf = "";
    const storedPastes: string[] = [];
    let pasteCounter = 0;

    // Escape sequence accumulator: raw mode delivers bytes in chunks
    let escAccum = "";
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    // @-tag autocomplete state
    const tag: TagState = createTagState(getFiles?.() ?? []);

    process.stdout.write("\n");
    process.stdout.write(PROMPT_STR);

    const rawOn = () => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(true);
      }
    };
    const rawOff = () => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(false);
      }
    };

    rawOn();

    // ── Tracking for clean redraw ──────────────────────────────────
    let prevRenderedLines = 1;

    const redraw = () => {
      // Move cursor up to start of our rendered area
      const linesUp = prevRenderedLines - 1 + row;
      if (linesUp > 0) process.stdout.write(`\x1b[${linesUp}A`);
      process.stdout.write("\r");

      // Build all lines
      const rendered: string[] = [];
      rendered.push(PROMPT_STR + lines[0]);
      for (let i = 1; i < lines.length; i++) {
        rendered.push(CONT + lines[i]);
      }

      let dropdownLines: string[] = [];
      if (tag.active && tag.matches.length > 0) {
        const dd = renderDropdown(tag.matches, tag.selectedIndex, process.stdout.columns || 80);
        if (dd) {
          dropdownLines = dd.split("\n").filter((l) => l.length > 0);
          tag.dropdownLines = dropdownLines.length;
        }
      } else {
        tag.dropdownLines = 0;
      }

      const allLines = [...rendered, ...dropdownLines];

      // Write all lines, clearing each to EOL with \x1b[K
      for (let i = 0; i < allLines.length; i++) {
        process.stdout.write(allLines[i] + "\x1b[K");
        if (i < allLines.length - 1) process.stdout.write("\r\n");
      }

      // If fewer lines than last time, clear the excess
      if (allLines.length < prevRenderedLines) {
        for (let i = allLines.length; i < prevRenderedLines; i++) {
          process.stdout.write("\r\n\x1b[K");
        }
        process.stdout.write(`\x1b[${prevRenderedLines - allLines.length}A`);
      }

      prevRenderedLines = allLines.length;

      // Position cursor
      const fromBottom = allLines.length - 1 - row;
      if (fromBottom > 0) process.stdout.write(`\x1b[${fromBottom}A`);
      process.stdout.write("\r");
      const prefixLen = row === 0 ? PROMPT_STR.length : CONT.length;
      if (col > 0) process.stdout.write(`\x1b[${prefixLen + col}C`);
    };

    // ── Tag helpers ────────────────────────────────────────────────
    const updateTagMatches = () => {
      if (!tag.active) return;
      tag.matches = matchFiles(tag.query, tag.files);
      tag.selectedIndex = tag.matches.length === 1 ? 0 : -1;
    };

    const deactivateTag = () => {
      tag.active = false;
      tag.query = "";
      tag.matches = [];
      tag.selectedIndex = -1;
    };

    const applyCompletion = (completion: string) => {
      const line = lines[tag.atRow];
      const before = line.slice(0, tag.atCol);
      const after = line.slice(tag.atCol + 1 + tag.query.length);
      lines[tag.atRow] = before + "@" + completion + after;
      col = tag.atCol + 1 + completion.length;
      row = tag.atRow;
      deactivateTag();
      redraw();
    };

    // ── Escape sequence helpers ────────────────────────────────────
    const flushEsc = () => {
      // If we accumulated \x1b + \r or \x1b + \n, it's legacy Shift+Enter
      if (escAccum === "\x1b\r" || escAccum === "\x1b\n") {
        escAccum = "";
        insertNewline();
        return;
      }
      // Otherwise discard — it's an unrecognized escape
      escAccum = "";
    };

    const clearEscTimer = () => {
      if (escTimer) { clearTimeout(escTimer); escTimer = null; }
    };

    // Check if a string starts an incomplete CSI/SS3 escape
    const isIncompleteEscape = (s: string): boolean => {
      if (s === "\x1b") return true;
      if (s === SS3) return true;
      // CSI + optional params, not yet terminated by letter/~ or u
      if (s.startsWith(CSI) && !/[A-Za-z~u]$/.test(s) && s.length < 15) return true;
      return false;
    };

    // Check if a complete string is Shift+Enter
    const isShiftEnter = (s: string): boolean => {
      // \n (Ctrl+J) is newline — not Enter
      if (s === "\n") return true;
      // Legacy: ESC + CR or ESC + LF
      if (s === "\x1b\r" || s === "\x1b\n") return true;
      // Kitty CSI-u: \x1b[13;N u where N >= 2 (mod 1 = plain, 2 = shift)
      if (/^\x1b\[13;[2-9]\d*u$/.test(s)) return true;
      if (/^\x1b\[13;[2-9]\d*:\d+u$/.test(s)) return true;
      // CSI ~ format: \x1b[13;N~ where N >= 2
      if (/^\x1b\[13;[2-9]\d*~$/.test(s)) return true;
      // modifyOtherKeys: \x1b[27;N;13~ where N >= 2
      if (/^\x1b\[27;[2-9]\d*;13~$/.test(s)) return true;
      return false;
    };

    // ── Line operations ────────────────────────────────────────────
    const insertNewline = () => {
      const before = lines[row].slice(0, col);
      const after = lines[row].slice(col);
      if (tag.active && tag.atRow === row && tag.atCol >= col) {
        tag.atRow = row + 1;
        tag.atCol = tag.atCol - col;
      }
      lines[row] = before;
      lines.splice(row + 1, 0, after);
      row++;
      col = 0;
      redraw();
    };

    const submit = () => {
      // Clean up dropdown
      deactivateTag();
      if (tag.dropdownLines > 0) {
        for (let i = 0; i < tag.dropdownLines; i++) process.stdout.write("\r\n\x1b[K");
        process.stdout.write(`\x1b[${tag.dropdownLines}A`);
        tag.dropdownLines = 0;
      }
      prevRenderedLines = 1;
      process.stdin.removeListener("data", onData);
      rawOff();
      process.stdout.write("\r\n");
      const raw = lines.join("\n");
      const expanded = expandPastes(raw);
      resolve(expanded);
    };

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      rawOff();
    };

    const expandPastes = (text: string): string => {
      let result = text;
      for (let i = 0; i < storedPastes.length; i++) {
        const placeholder = `[paste #${i + 1}]`;
        result = result.split(placeholder).join(storedPastes[i]);
      }
      return result;
    };

    const processPaste = (content: string) => {
      const lineCount = content.split("\n").length;
      const charCount = content.length;

      if (lineCount > PASTE_LINE_LIMIT || charCount > PASTE_CHAR_LIMIT) {
        pasteCounter++;
        storedPastes.push(content);
        const placeholder = `[paste #${pasteCounter}]`;
        const before = lines[row].slice(0, col);
        const after = lines[row].slice(col);
        lines[row] = before + placeholder + after;
        col += placeholder.length;
        process.stdout.write(placeholder);
        if (after.length > 0) redraw();
      } else {
        const before = lines[row].slice(0, col);
        const after = lines[row].slice(col);
        const pasteLines = content.split("\n");

        if (pasteLines.length === 1) {
          lines[row] = before + pasteLines[0] + after;
          col += pasteLines[0].length;
          process.stdout.write(pasteLines[0]);
          if (after.length > 0) redraw();
        } else {
          lines[row] = before + pasteLines[0];
          for (let i = 1; i < pasteLines.length; i++) {
            lines.splice(row + i, 0, pasteLines[i]);
          }
          lines[row + pasteLines.length - 1] += after;
          row += pasteLines.length - 1;
          col = pasteLines[pasteLines.length - 1].length;
          redraw();
        }
      }
    };

    // ── Main input handler ─────────────────────────────────────────
    const onData = (buf: Buffer) => {
      let s = buf.toString();

      // ── Assemble partial escape sequences ────────────────────────
      if (escAccum) {
        clearEscTimer();
        s = escAccum + s;
        escAccum = "";
      }

      // ── Bracketed paste ──────────────────────────────────────────
      if (!pasteMode && s.startsWith("\x1b[200~")) {
        pasteMode = true;
        pasteBuf = s.slice(6);
        const endIdx = pasteBuf.indexOf("\x1b[201~");
        if (endIdx !== -1) {
          const content = pasteBuf.slice(0, endIdx);
          const rest = pasteBuf.slice(endIdx + 6);
          pasteBuf = "";
          pasteMode = false;
          processPaste(content);
          if (rest) onData(Buffer.from(rest));
        }
        return;
      }

      if (pasteMode) {
        pasteBuf += s;
        const endIdx = pasteBuf.indexOf("\x1b[201~");
        if (endIdx !== -1) {
          const content = pasteBuf.slice(0, endIdx);
          const rest = pasteBuf.slice(endIdx + 6);
          pasteBuf = "";
          pasteMode = false;
          processPaste(content);
          if (rest) onData(Buffer.from(rest));
        }
        return;
      }

      // ── Escape sequence routing ──────────────────────────────────
      // Kitty protocol plain Enter: \x1b[13u or \x1b[13;1u or \x1b[13;1:M u
      if (/^\x1b\[13[;:]/.test(s) || s === "\x1b[13u") {
        // Plain Enter via Kitty protocol — same as \r
        if (col > 0 && lines[row][col - 1] === "\\") {
          lines[row] = lines[row].slice(0, col - 1) + lines[row].slice(col);
          col--;
          insertNewline();
          return;
        }
        submit();
        return;
      }

      // If this starts with ESC and is incomplete, buffer it
      if (isIncompleteEscape(s)) {
        escAccum = s;
        escTimer = setTimeout(() => flushEsc(), 30);
        return;
      }

      // Shift+Enter (complete sequence)
      if (isShiftEnter(s)) {
        insertNewline();
        return;
      }

      // ── Enter (submit): \r (raw) or \x1bOM (numpad Enter via SS3) ─
      if (s === "\r" || s === "\x1bOM") {
        // Fallback for terminals without Shift+Enter support:
        // If char before cursor is \, delete it and insert newline instead.
        if (col > 0 && lines[row][col - 1] === "\\") {
          lines[row] = lines[row].slice(0, col - 1) + lines[row].slice(col);
          col--;
          insertNewline();
          return;
        }
        submit();
        return;
      }

      // ── Ctrl+C ───────────────────────────────────────────────────
      if (s === "\x03") {
        deactivateTag();
        if (tag.dropdownLines > 0) {
          for (let i = 0; i < tag.dropdownLines; i++) process.stdout.write("\r\n\x1b[K");
          process.stdout.write(`\x1b[${tag.dropdownLines}A`);
          tag.dropdownLines = 0;
        }
        prevRenderedLines = 1;
        cleanup();
        process.stdout.write("^C\r\n");
        resolve("");
        return;
      }

      // ── Ctrl+D on empty line ─────────────────────────────────────
      if (s === "\x04" && lines.length === 1 && lines[0].length === 0) {
        deactivateTag();
        cleanup();
        process.stdout.write("\r\n");
        resolve("/exit");
        return;
      }

      // ── Backspace ────────────────────────────────────────────────
      if (s === "\x7f" || s === "\b") {
        if (col === 0 && row > 0) {
          if (tag.active && tag.atRow === row) {
            tag.atRow = row - 1;
            tag.atCol = lines[row - 1].length + tag.atCol;
          }
          const prevLen = lines[row - 1].length;
          lines[row - 1] += lines[row];
          lines.splice(row, 1);
          row--;
          col = prevLen;
          redraw();
        } else if (col === lines[row].length && row < lines.length - 1) {
          if (tag.active && tag.atRow === row + 1) {
            tag.atRow = row;
            tag.atCol = lines[row].length + tag.atCol;
          }
          lines[row] += lines[row + 1];
          lines.splice(row + 1, 1);
          redraw();
        } else if (col > 0) {
          const line = lines[row];
          if (tag.active && row === tag.atRow && col <= tag.atCol + 1) {
            deactivateTag();
          }
          lines[row] = line.slice(0, col - 1) + line.slice(col);
          col--;
          if (tag.active && row === tag.atRow && col > tag.atCol) {
            tag.query = lines[row].slice(tag.atCol + 1, col);
            updateTagMatches();
          }
          process.stdout.write("\b \b");
          if (col < lines[row].length || (tag.active && tag.matches.length > 0)) redraw();
        }
        return;
      }

      // ── Tab ──────────────────────────────────────────────────────
      if (s === "\t") {
        if (tag.active && tag.matches.length > 0) {
          if (tag.matches.length === 1) {
            applyCompletion(tag.matches[0]);
          } else {
            tag.selectedIndex = (tag.selectedIndex + 1) % tag.matches.length;
            redraw();
          }
          return;
        }
        // Not in tag mode — insert 2 spaces
        const before = lines[row];
        lines[row] = before.slice(0, col) + "  " + before.slice(col);
        col += 2;
        process.stdout.write("  ");
        return;
      }

      // ── Known escape sequences (arrows, home, end, delete) ───────
      if (s.startsWith("\x1b") || s.startsWith(SS3)) {
        // Arrow keys: CSI n A/B/C/D  or  SS3 A/B/C/D
        const arrowMatch = s.match(/^(?:\x1b\[|O)([ABCD])$/);
        if (arrowMatch) {
          const dir = arrowMatch[1];
          if (dir === "D" && col > 0) {
            col = Math.max(0, col - 1);
            process.stdout.write("\x1b[1D");
          } else if (dir === "C" && col < lines[row].length) {
            col = Math.min(lines[row].length, col + 1);
            process.stdout.write("\x1b[1C");
          } else if (dir === "A" && row > 0) {
            row = Math.max(0, row - 1);
            col = Math.min(col, lines[row].length);
            redraw();
          } else if (dir === "B" && row < lines.length - 1) {
            row = Math.min(lines.length - 1, row + 1);
            col = Math.min(col, lines[row].length);
            redraw();
          }
          return;
        }

        // Home: CSI H, CSI 1~, SS3 H
        if (s === "\x1b[H" || s === "\x1b[1~" || s === "\x1bOH") {
          col = 0;
          redraw();
          return;
        }

        // End: CSI F, CSI 4~, SS3 F
        if (s === "\x1b[F" || s === "\x1b[4~" || s === "\x1bOF") {
          col = lines[row].length;
          redraw();
          return;
        }

        // Delete: CSI 3~
        if (s === "\x1b[3~") {
          if (col < lines[row].length) {
            lines[row] = lines[row].slice(0, col) + lines[row].slice(col + 1);
            redraw();
          } else if (row < lines.length - 1) {
            lines[row] += lines[row + 1];
            lines.splice(row + 1, 1);
            redraw();
          }
          return;
        }

        // CSI u printable (Kitty protocol): decode single char
        // e.g. \x1b[97u → 'a'
        const kittyMatch = s.match(/^\x1b\[(\d+)(?::\d*)?(?:;\d+)?(?::\d+)?u$/);
        if (kittyMatch) {
          const cp = parseInt(kittyMatch[1], 10);
          if (cp >= 32 && cp <= 0x10ffff) {
            try {
              s = String.fromCodePoint(cp);
            } catch { return; }
          } else {
            return; // non-printable CSI-u, ignore
          }
        } else {
          return; // unrecognized escape, ignore
        }
      }

      // ── Reject other control characters ──────────────────────────
      if (s.length === 1) {
        const code = s.charCodeAt(0);
        if (code < 32 && code !== 9 /* tab already handled */) return;
      }

      // ── Regular character ────────────────────────────────────────
      const before = lines[row];
      lines[row] = before.slice(0, col) + s + before.slice(col);
      col += s.length;

      // @-tag detection
      if (s === "@" && !tag.active) {
        const charBefore = col > 1 ? lines[row][col - 2] : " ";
        if (charBefore === " " || col === 1) {
          tag.active = true;
          tag.atCol = col - 1;
          tag.atRow = row;
          tag.query = "";
          tag.files = getFiles?.() ?? [];
          tag.matches = tag.files.slice(0, 20);
          tag.selectedIndex = -1;
        }
      } else if (tag.active) {
        if (s === " ") {
          deactivateTag();
        } else {
          tag.query = lines[row].slice(tag.atCol + 1, col);
          updateTagMatches();
        }
      }

      if (col < lines[row].length || (tag.active && tag.matches.length > 0)) {
        redraw();
      } else {
        process.stdout.write(s);
      }
    };

    process.stdin.on("data", onData);
  });
}

export interface PromptOptions {
  /** Provide file list for @-tag autocomplete. Called each time @ is typed. */
  getFiles?: () => string[];
}

export function createPrompt(opts?: PromptOptions): {
  prompt: () => Promise<string>;
  enableBracketedPaste: () => void;
  disableBracketedPaste: () => void;
} {
  const isTTY =
    process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  const getFiles = opts?.getFiles;

  return {
    prompt: isTTY ? () => multilinePrompt(getFiles) : simplePrompt,
    enableBracketedPaste: () => {
      if (isTTY) process.stdout.write("\x1b[?2004h");
    },
    disableBracketedPaste: () => {
      if (isTTY) process.stdout.write("\x1b[?2004l");
    },
  };
}
