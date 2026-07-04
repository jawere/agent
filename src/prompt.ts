// src/prompt.ts — Multiline prompt with Shift+Enter & paste support
// Extracted from index.ts to isolate complex terminal handling for testability.

import * as readline from 'readline';

// Gruvbox colors
const G_GRAY = '\x1b[38;2;146;131;116m';
const R = '\x1b[0m';

const PROMPT = `${G_GRAY}>${R} `;
const CONT = '  ';

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
 *   - Shift+Enter for newlines
 *   - Bracketed paste mode (multi-line paste support)
 *   - Arrow keys, Home, End, Delete, Backspace
 *   - Ctrl+C to cancel, Ctrl+D to exit on empty
 *
 * This is raw-mode terminal handling — fragile but necessary for a good UX.
 * Isolating it here makes it easier to test, debug, and replace.
 */
function multilinePrompt(): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [''];
    let row = 0;
    let col = 0;
    let pasteBuf = '';
    let pasteMode = false;

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

    const redraw = () => {
      process.stdout.write(`\x1b[${row}A\r`);
      process.stdout.write('\x1b[0J');
      process.stdout.write(PROMPT + lines[0]);
      for (let i = 1; i < lines.length; i++) {
        process.stdout.write('\r\n' + CONT + lines[i]);
      }
      const targetRow = row;
      const targetCol = col;
      const moveUp = lines.length - 1 - targetRow;
      if (moveUp > 0) process.stdout.write(`\x1b[${moveUp}A`);
      process.stdout.write('\r');
      const prefixLen = targetRow === 0 ? PROMPT.length : CONT.length;
      if (targetCol > 0) process.stdout.write(`\x1b[${prefixLen + targetCol}C`);
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      rawOff();
    };

    const onData = (buf: Buffer) => {
      const s = buf.toString();

      // ── Bracketed paste ──
      if (s.startsWith('\x1b[200~')) {
        pasteMode = true;
        pasteBuf = s.slice(6);
        return;
      }
      if (pasteMode) {
        const end = s.indexOf('\x1b[201~');
        if (end !== -1) {
          pasteBuf += s.slice(0, end);
          const before = lines[row].slice(0, col);
          const after = lines[row].slice(col);
          const pasteLines = pasteBuf.split('\n');
          if (pasteLines.length === 1) {
            lines[row] = before + pasteLines[0] + after;
            col += pasteLines[0].length;
            process.stdout.write(pasteLines[0]);
            if (after) redraw();
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
          pasteBuf = '';
          pasteMode = false;
          const rest = s.slice(end + 6);
          if (rest) onData(Buffer.from(rest));
          return;
        } else {
          pasteBuf += s;
          return;
        }
      }

      // ── Shift+Enter (kitty: CSI 13;2u, xterm: CSI 13;2~) ──
      if (s === '\x1b[13;2u' || s === '\x1b[13;2~') {
        const before = lines[row].slice(0, col);
        const after = lines[row].slice(col);
        lines[row] = before;
        lines.splice(row + 1, 0, after);
        row++;
        col = 0;
        process.stdout.write('\r\n' + CONT);
        return;
      }

      // ── Enter ──
      if (s === '\r' || s === '\n') {
        cleanup();
        process.stdout.write('\r\n');
        resolve(lines.join('\n'));
        return;
      }

      // ── Ctrl+C ──
      if (s === '\x03') {
        cleanup();
        process.stdout.write('^C\r\n');
        resolve('');
        return;
      }

      // ── Ctrl+D on empty line ──
      if (s === '\x04' && lines.length === 1 && lines[0].length === 0) {
        cleanup();
        process.stdout.write('\r\n');
        resolve('/exit');
        return;
      }

      // ── Backspace ──
      if (s === '\x7f' || s === '\b') {
        if (col > 0) {
          const line = lines[row];
          lines[row] = line.slice(0, col - 1) + line.slice(col);
          col--;
          process.stdout.write('\b \b');
          if (col < lines[row].length) redraw();
        } else if (row > 0) {
          const prevLen = lines[row - 1].length;
          lines[row - 1] += lines[row];
          lines.splice(row, 1);
          row--;
          col = prevLen;
          redraw();
        }
        return;
      }

      // ── Escape sequences (arrows, home, end, delete) ──
      if (s.startsWith('\x1b[')) {
        const m = s.match(/^\x1b\[(\d*)([ABCD])/);
        if (m) {
          const n = m[1] ? parseInt(m[1]) : 1;
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
            lines[row] += lines[row + 1];
            lines.splice(row + 1, 1);
            redraw();
          }
          return;
        }
        return;
      }

      // ── Regular character ──
      const before = lines[row];
      lines[row] = before.slice(0, col) + s + before.slice(col);
      col += s.length;
      if (col < lines[row].length) {
        redraw();
      } else {
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
