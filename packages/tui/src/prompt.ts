// @jawere/tui — Multiline terminal prompt with paste support

import * as readline from "readline";

// Colors
const G_GRAY = "\x1b[38;2;146;131;116m";
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

function multilinePrompt(): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [""];
    let row = 0;
    let col = 0;

    let pasteMode = false;
    let pasteBuf = "";
    const storedPastes: string[] = [];
    let pasteCounter = 0;

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

    const redraw = () => {
      process.stdout.write(`\x1b[${row}A\r`);
      process.stdout.write("\x1b[0J");
      process.stdout.write(PROMPT_STR + lines[0]);
      for (let i = 1; i < lines.length; i++) {
        process.stdout.write("\r\n" + CONT + lines[i]);
      }
      const moveUp = lines.length - 1 - row;
      if (moveUp > 0) process.stdout.write(`\x1b[${moveUp}A`);
      process.stdout.write("\r");
      const prefixLen = row === 0 ? PROMPT_STR.length : CONT.length;
      if (col > 0) process.stdout.write(`\x1b[${prefixLen + col}C`);
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

    const onData = (buf: Buffer) => {
      const s = buf.toString();

      // Paste start
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

      // Shift+Enter
      if (/^\x1b\[(?:13;\d+[~u]|27;\d+;13~)$/.test(s)) {
        const before = lines[row].slice(0, col);
        const after = lines[row].slice(col);
        lines[row] = before;
        lines.splice(row + 1, 0, after);
        row++;
        col = 0;
        redraw();
        return;
      }

      // Enter
      if (s === "\r" || s === "\n") {
        cleanup();
        process.stdout.write("\r\n");
        const raw = lines.join("\n");
        const expanded = expandPastes(raw);
        resolve(expanded);
        return;
      }

      // Ctrl+C
      if (s === "\x03") {
        cleanup();
        process.stdout.write("^C\r\n");
        resolve("");
        return;
      }

      // Ctrl+D on empty
      if (s === "\x04" && lines.length === 1 && lines[0].length === 0) {
        cleanup();
        process.stdout.write("\r\n");
        resolve("/exit");
        return;
      }

      // Backspace
      if (s === "\x7f" || s === "\b") {
        if (col === 0 && row > 0) {
          const prevLen = lines[row - 1].length;
          lines[row - 1] += lines[row];
          lines.splice(row, 1);
          row--;
          col = prevLen;
          redraw();
        } else if (col === lines[row].length && row < lines.length - 1) {
          lines[row] += lines[row + 1];
          lines.splice(row + 1, 1);
          redraw();
        } else if (col > 0) {
          const line = lines[row];
          lines[row] = line.slice(0, col - 1) + line.slice(col);
          col--;
          process.stdout.write("\b \b");
          if (col < lines[row].length) redraw();
        }
        return;
      }

      // Escape sequences
      if (s.startsWith("\x1b[")) {
        const m = s.match(/^\x1b\[(\d*)([ABCD])/);
        if (m) {
          const n = m[1] ? parseInt(m[1], 10) : 1;
          const dir = m[2];
          if (dir === "D" && col > 0) {
            col = Math.max(0, col - n);
            process.stdout.write(`\x1b[${n}D`);
          } else if (dir === "C" && col < lines[row].length) {
            col = Math.min(lines[row].length, col + n);
            process.stdout.write(`\x1b[${n}C`);
          } else if (dir === "A" && row > 0) {
            row = Math.max(0, row - n);
            col = Math.min(col, lines[row].length);
            process.stdout.write(`\x1b[${n}A`);
          } else if (dir === "B" && row < lines.length - 1) {
            row = Math.min(lines.length - 1, row + n);
            col = Math.min(col, lines[row].length);
            process.stdout.write(`\x1b[${n}B`);
          }
          return;
        }

        if (s === "\x1b[H" || s === "\x1b[1~") {
          const diff = col;
          col = 0;
          process.stdout.write(`\x1b[${diff}D`);
          return;
        }

        if (s === "\x1b[F" || s === "\x1b[4~") {
          const diff = lines[row].length - col;
          col = lines[row].length;
          process.stdout.write(`\x1b[${diff}C`);
          return;
        }

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
        return;
      }

      // Regular character
      const before = lines[row];
      lines[row] = before.slice(0, col) + s + before.slice(col);
      col += s.length;
      if (col < lines[row].length) {
        redraw();
      } else {
        process.stdout.write(s);
      }
    };

    process.stdin.on("data", onData);
  });
}

export function createPrompt(): {
  prompt: () => Promise<string>;
  enableBracketedPaste: () => void;
  disableBracketedPaste: () => void;
} {
  const isTTY =
    process.stdin.isTTY && typeof process.stdin.setRawMode === "function";

  return {
    prompt: isTTY ? multilinePrompt : simplePrompt,
    enableBracketedPaste: () => {
      if (isTTY) process.stdout.write("\x1b[?2004h");
    },
    disableBracketedPaste: () => {
      if (isTTY) process.stdout.write("\x1b[?2004l");
    },
  };
}
