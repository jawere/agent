// @jawere/tui — Terminal spinner

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const IDLE_WORDS = [
  "Thinking…", "Reasoning…", "Analyzing…", "Processing…",
  "Computing…", "Considering…", "Evaluating…", "Planning…",
  "Reading…", "Writing…", "Searching…", "Executing…",
];

const G_GREEN = "\x1b[38;2;184;187;38m";
const G_DIM   = "\x1b[38;2;102;92;84m";
const G_GRAY  = "\x1b[38;2;146;131;116m";
const G_RED   = "\x1b[38;2;251;73;52m";
const RESET   = "\x1b[0m";
const DIM     = "\x1b[2m";

export interface Spinner {
  start(text?: string): void;
  update(text: string): void;
  stop(): void;
  /** Stop with a completion message */
  done(text?: string): void;
  /** Stop with an error message */
  fail(text?: string): void;
}

export function createSpinner(): Spinner {
  let interval: ReturnType<typeof setInterval> | null = null;
  let frameIdx = 0;
  let wordIdx = 0;
  let currentText = "";
  let active = false;

  const render = () => {
    if (!active) return;

    // Clear current line
    process.stderr.write("\r\x1b[K");

    const frame = FRAMES[frameIdx % FRAMES.length];
    const word = currentText || IDLE_WORDS[wordIdx % IDLE_WORDS.length];

    process.stderr.write(`${G_GREEN}${frame}${RESET} ${DIM}${word}${RESET}`);

    frameIdx++;
    if (frameIdx % FRAMES.length === 0) {
      wordIdx++;
    }
  };

  return {
    start(text?: string) {
      if (active) return;
      active = true;
      currentText = text ?? "";
      frameIdx = 0;
      wordIdx = Math.floor(Math.random() * IDLE_WORDS.length);
      render();
      interval = setInterval(render, 80);
    },

    update(text: string) {
      currentText = text;
      if (active) render();
    },

    stop() {
      active = false;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      process.stderr.write("\r\x1b[K");
    },

    done(text?: string) {
      this.stop();
      if (text) {
        process.stderr.write(`${G_GREEN}✓${RESET} ${DIM}${text}${RESET}\n`);
      }
    },

    fail(text?: string) {
      this.stop();
      if (text) {
        process.stderr.write(`${G_RED}✗${RESET} ${DIM}${text}${RESET}\n`);
      }
    },
  };
}
