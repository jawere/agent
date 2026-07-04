// src/prompt.ts — Multiline prompt with Shift+Enter & paste support
// Extracted from index.ts to isolate complex terminal handling for testability.

import * as readline from 'readline';

// Gruvbox colors
const G_GRAY = '\x1b[38;2;146;131;116m';
const R = '\x1b[0m';

const PROMPT = `${G_GRAY}>${R} `;
const CONT = '  ';

// ── Long paste threshold ────────────────────────────────────────────
// Pastes exceeding this many lines or characters are stored and
// replaced with a [paste #N] placeholder to keep the prompt responsive.
const PASTE_LINE_LIMIT = 20;
const PASTE_CHAR_LIMIT = 500;

/**
 * Simple fallback prompt for piped/non-TTY input.
 */
function simplePrompt(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('> ', (answer) => { rl.close(); resolve(answer); });
  });
}

/**
 * Full-featured multiline prompt with:
 *   - Shift+Enter for newlines (kitty: CSI 13;2u / xterm: CSI 13;2~)
 *   - Bracketed paste mode (multi-line paste support)
 *   - Long pastes stored as [paste #N] placeholders to avoid UI churn
 *   - Arrow keys, Home, End, Delete, Backspace
 *   - Ctrl+C to cancel, Ctrl+D to exit on empty line
 *
 * This is raw-mode terminal handling — fragile but necessary for a good UX.
 * Isolating it here makes it easier to test, debug, and replace.
 */
function multilinePrompt(): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [''];
    let row = 0;
    let col = 0;

    // ── Paste state ──────────────────────────────────────────────
    let pasteMode = false;
    let pasteBuf = '';
    // Map of placeholder -> actual content for long pastes
    const storedPastes: string[] = [];
    let pasteCounter = 0;

    process.stdout.write('\n');
    process.stdout.write(PROMPT);

    const rawOn = () => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(true);
      }
    };
    const rawOff = () => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
      }
    };

    rawOn();

    // ── Redraw helper ────────────────────────────────────────────
    // Repaints the entire prompt and all continuation lines, then
    // repositions the cursor at (row, col).
    const redraw = () => {
      // Move cursor up to the first prompt line
      process.stdout.write(`\x1b[${row}A\r`);
      // Clear from cursor to end of screen
      process.stdout.write('\x1b[0J');
      // Print first line with prompt prefix
      process.stdout.write(PROMPT + lines[0]);
      // Print continuation lines
      for (let i = 1; i < lines.length; i++) {
        process.stdout.write('\r\n' + CONT + lines[i]);
      }
      // Reposition cursor
      const moveUp = lines.length - 1 - row;
      if (moveUp > 0) process.stdout.write(`\x1b[${moveUp}A`);
      process.stdout.write('\r');
      const prefixLen = row === 0 ? PROMPT.length : CONT.length;
      if (col > 0) process.stdout.write(`\x1b[${prefixLen + col}C`);
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      rawOff();
    };

    // ── Expand paste placeholders ────────────────────────────────
    // Replace [paste #N] markers with actual stored paste content.
    const expandPastes = (text: string): string => {
      let result = text;
      for (let i = 0; i < storedPastes.length; i++) {
        const placeholder = `[paste #${i + 1}]`;
        // Use split/join for simple replacement (handles multiple occurrences)
        result = result.split(placeholder).join(storedPastes[i]);
      }
      return result;
    };

    // ── Process a completed paste ────────────────────────────────
    const processPaste = (content: string) => {
      const lineCount = content.split('\n').length;
      const charCount = content.length;

      // Decide: render inline or store as placeholder?
      if (lineCount > PASTE_LINE_LIMIT || charCount > PASTE_CHAR_LIMIT) {
        // ── Long paste → placeholder ──
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
        // ── Short paste → render inline ──
        const before = lines[row].slice(0, col);
        const after = lines[row].slice(col);
        const pasteLines = content.split('\n');

        if (pasteLines.length === 1) {
          // Single-line paste
          lines[row] = before + pasteLines[0] + after;
          col += pasteLines[0].length;
          process.stdout.write(pasteLines[0]);
          if (after.length > 0) redraw();
        } else {
          // Multi-line paste
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

    // ── Data handler ─────────────────────────────────────────────
    const onData = (buf: Buffer) => {
      const s = buf.toString();

      // ── Bracketed paste start ─────────────────────────────────
      if (!pasteMode && s.startsWith('\x1b[200~')) {
        pasteMode = true;
        // Everything after the 6-char start marker goes into pasteBuf
        pasteBuf = s.slice(6);

        // Check if the entire paste (including end marker) is in this chunk.
        // This is the critical fix: we must search pasteBuf, not just s.
        const endIdx = pasteBuf.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          const content = pasteBuf.slice(0, endIdx);
          const rest = pasteBuf.slice(endIdx + 6);
          pasteBuf = '';
          pasteMode = false;
          processPaste(content);
          if (rest) onData(Buffer.from(rest));
        }
        return;
      }

      // ── Accumulating paste data ───────────────────────────────
      if (pasteMode) {
        pasteBuf += s;

        // Search pasteBuf for the end marker (not just s — this is the fix)
        const endIdx = pasteBuf.indexOf('\x1b[201~');
        if (endIdx !== -1) {
          const content = pasteBuf.slice(0, endIdx);
          const rest = pasteBuf.slice(endIdx + 6);
          pasteBuf = '';
          pasteMode = false;
          processPaste(content);
          if (rest) onData(Buffer.from(rest));
        }
        // If end marker not found, keep accumulating — no action needed
        return;
      }

      // ── Shift+Enter (newline) ────────────────────────────
      // Terminals use many different escape sequences for modified Enter.
      // Match any CSI sequence where keycode=13 with modifiers present:
      //   kitty/CSI u:  \x1b[13;MODu   (MOD=1 Shift, 2 Alt, 3 Shift+Alt, …)
      //   xterm lvl 1:  \x1b[13;MOD~
      //   xterm lvl 2:  \x1b[27;MOD;13~
      // We treat ANY modified Enter (not plain \r/\n) as a newline.
      if (/^\x1b\[(?:13;\d+[~u]|27;\d+;13~)$/.test(s)) {
        const before = lines[row].slice(0, col);
        const after = lines[row].slice(col);
        lines[row] = before;
        lines.splice(row + 1, 0, after);
        row++;
        col = 0;
        // Full redraw so the moved text actually appears on the new line
        redraw();
        return;
      }

      // ── Enter ─────────────────────────────────────────────────
      if (s === '\r' || s === '\n') {
        cleanup();
        process.stdout.write('\r\n');
        const raw = lines.join('\n');
        const expanded = expandPastes(raw);
        resolve(expanded);
        return;
      }

      // ── Ctrl+C ────────────────────────────────────────────────
      if (s === '\x03') {
        cleanup();
        process.stdout.write('^C\r\n');
        resolve('');
        return;
      }

      // ── Ctrl+D on empty line ──────────────────────────────────
      if (s === '\x04' && lines.length === 1 && lines[0].length === 0) {
        cleanup();
        process.stdout.write('\r\n');
        resolve('/exit');
        return;
      }

      // ── Backspace ─────────────────────────────────────────────
      if (s === '\x7f' || s === '\b') {
        if (col === 0 && row > 0) {
          // At column 0 of a continuation line — join with previous line
          const prevLen = lines[row - 1].length;
          lines[row - 1] += lines[row];
          lines.splice(row, 1);
          row--;
          col = prevLen;
          redraw();
        } else if (col === lines[row].length && row < lines.length - 1) {
          // At end of a non-last line — join next line to current (symmetric with Delete)
          lines[row] += lines[row + 1];
          lines.splice(row + 1, 1);
          redraw();
        } else if (col > 0) {
          // Delete character before cursor within line
          const line = lines[row];
          lines[row] = line.slice(0, col - 1) + line.slice(col);
          col--;
          process.stdout.write('\b \b');
          if (col < lines[row].length) redraw();
        }
        return;
      }

      // ── Escape sequences (arrows, home, end, delete) ──────────
      if (s.startsWith('\x1b[')) {
        // Arrow keys: CSI n A/B/C/D
        const m = s.match(/^\x1b\[(\d*)([ABCD])/);
        if (m) {
          const n = m[1] ? parseInt(m[1], 10) : 1;
          const dir = m[2];
          if (dir === 'D' && col > 0) {
            col = Math.max(0, col - n);
            process.stdout.write(`\x1b[${n}D`);
          } else if (dir === 'C' && col < lines[row].length) {
            col = Math.min(lines[row].length, col + n);
            process.stdout.write(`\x1b[${n}C`);
          } else if (dir === 'A' && row > 0) {
            row = Math.max(0, row - n);
            col = Math.min(col, lines[row].length);
            process.stdout.write(`\x1b[${n}A`);
          } else if (dir === 'B' && row < lines.length - 1) {
            row = Math.min(lines.length - 1, row + n);
            col = Math.min(col, lines[row].length);
            process.stdout.write(`\x1b[${n}B`);
          }
          return;
        }

        // Home
        if (s === '\x1b[H' || s === '\x1b[1~') {
          const diff = col;
          col = 0;
          process.stdout.write(`\x1b[${diff}D`);
          return;
        }

        // End
        if (s === '\x1b[F' || s === '\x1b[4~') {
          const diff = lines[row].length - col;
          col = lines[row].length;
          process.stdout.write(`\x1b[${diff}C`);
          return;
        }

        // Delete
        if (s === '\x1b[3~') {
          if (col < lines[row].length) {
            lines[row] = lines[row].slice(0, col) + lines[row].slice(col + 1);
            redraw();
          } else if (row < lines.length - 1) {
            // Join with next line
            lines[row] += lines[row + 1];
            lines.splice(row + 1, 1);
            redraw();
          }
          return;
        }

        // Unknown escape — ignore
        return;
      }

      // ── Regular character ─────────────────────────────────────
      const before = lines[row];
      lines[row] = before.slice(0, col) + s + before.slice(col);
      col += s.length;
      if (col < lines[row].length) {
        // Cursor is now in the middle of the line — need to repaint
        redraw();
      } else {
        // Cursor at end — simple echo suffices
        process.stdout.write(s);
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Create a prompt function appropriate for the current terminal.
 * Returns multilinePrompt for TTYs, simplePrompt for pipes/files.
 */
export function createPrompt(): {
  prompt: () => Promise<string>;
  enableBracketedPaste: () => void;
  disableBracketedPaste: () => void;
} {
  const isTTY = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';

  return {
    prompt: isTTY ? multilinePrompt : simplePrompt,
    enableBracketedPaste: () => {
      if (isTTY) process.stdout.write('\x1b[?2004h');
    },
    disableBracketedPaste: () => {
      if (isTTY) process.stdout.write('\x1b[?2004l');
    },
  };
}
