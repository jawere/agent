/**
 * Terminal spinner — a lightweight animated indicator shown while the agent
 * is waiting for an API response or processing tool results.
 *
 * Usage:
 *   const spin = createSpinner();
 *   spin.start('Thinking…');
 *   // ... do work ...
 *   spin.update('Running tool…');
 *   // ... more work ...
 *   spin.stop();
 */

// Spinner frames — classic braille dots
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// Words that the spinner cycles through while idling
const IDLE_WORDS = [
  'Accomplishing…', 'Actioning…', 'Actualizing…', 'Architecting…', 'Baking…',
  'Beaming…', 'Beboppin\'…', 'Befuddling…', 'Billowing…', 'Blanching…',
  'Bloviating…', 'Boogieing…', 'Boondoggling…', 'Booping…', 'Bootstrapping…',
  'Brewing…', 'Burrowing…', 'Calculating…', 'Canoodling…', 'Caramelizing…',
  'Cascading…', 'Catapulting…', 'Cerebrating…', 'Channeling…', 'Choreographing…',
  'Churning…', 'Clauding…', 'Coalescing…', 'Cogitating…', 'Combobulating…',
  'Composing…', 'Computing…', 'Concocting…', 'Considering…', 'Contemplating…',
  'Cooking…', 'Crafting…', 'Creating…', 'Crunching…', 'Crystallizing…',
  'Cultivating…', 'Deciphering…', 'Deliberating…', 'Determining…', 'Dilly-dallying…',
  'Discombobulating…', 'Doing…', 'Doodling…', 'Drizzling…', 'Ebbing…',
  'Effecting…', 'Elucidating…', 'Embellishing…', 'Enchanting…', 'Envisioning…',
  'Evaporating…', 'Fermenting…', 'Fiddle-faddling…', 'Finagling…', 'Flambeing…',
  'Flibbertigibbeting…', 'Flowing…', 'Flummoxing…', 'Fluttering…', 'Forging…',
  'Forming…', 'Frolicking…', 'Frosting…', 'Gallivanting…', 'Galloping…',
  'Garnishing…', 'Generating…', 'Germinating…', 'Gitifying…', 'Grooving…',
  'Gusting…', 'Harmonizing…', 'Hashing…', 'Hatching…', 'Herding…',
  'Honking…', 'Hullaballooing…', 'Hyperspacing…', 'Ideating…', 'Imagining…',
  'Improvising…', 'Incubating…', 'Inferring…', 'Infusing…', 'Ionizing…',
  'Jitterbugging…', 'Julienning…', 'Kneading…', 'Leavening…', 'Levitating…',
  'Lollygagging…', 'Manifesting…', 'Marinating…', 'Meandering…', 'Metamorphosing…',
  'Misting…', 'Moonwalking…', 'Moseying…', 'Mulling…', 'Mustering…',
  'Musing…', 'Nebulizing…', 'Nesting…', 'Newspapering…', 'Noodling…',
  'Nucleating…', 'Orbiting…', 'Orchestrating…', 'Osmosing…', 'Perambulating…',
  'Percolating…', 'Perusing…', 'Philosophising…', 'Photosynthesizing…', 'Pollinating…',
  'Pondering…', 'Pontificating…', 'Pouncing…', 'Precipitating…', 'Prestidigitating…',
  'Processing…', 'Proofing…', 'Propagating…', 'Puttering…', 'Puzzling…',
  'Quantumizing…', 'Razzle-dazzling…', 'Razzmatazzing…', 'Recombobulating…', 'Reticulating…',
  'Roosting…', 'Ruminating…', 'Sauteing…', 'Scampering…', 'Schlepping…',
  'Scurrying…', 'Seasoning…', 'Shenaniganing…', 'Shimmying…', 'Simmering…',
  'Skedaddling…', 'Sketching…', 'Slithering…', 'Smooshing…', 'Sock-hopping…',
  'Spelunking…', 'Spinning…', 'Sprouting…', 'Stewing…', 'Sublimating…',
  'Swirling…', 'Swooping…', 'Symbioting…', 'Synthesizing…', 'Tempering…',
  'Thinking…', 'Thundering…', 'Tinkering…', 'Tomfoolering…', 'Topsy-turvying…',
  'Transfiguring…', 'Transmuting…', 'Twisting…', 'Undulating…', 'Unfurling…',
  'Unravelling…', 'Vibing…', 'Waddling…', 'Wandering…', 'Warping…',
  'Whatchamacalliting…', 'Whirlpooling…', 'Whirring…', 'Whisking…', 'Wibbling…',
  'Working…', 'Wrangling…', 'Zesting…', 'Zigzagging…',
];

// Gruvbox colors
const GRAY = '\x1b[38;2;146;131;116m';
const GREEN = '\x1b[38;2;184;187;3m';
const RESET = '\x1b[0m';

const FRAME_INTERVAL = 80; // ms per braille frame
const WORD_INTERVAL = 500; // ms per word shuffle

export interface Spinner {
  /** Start (or restart) the spinner with a status message */
  start(message: string): void;
  /** Update the status message without stopping the animation */
  update(message: string): void;
  /** Stop and clear the spinner. If message is provided, show it as the final status. */
  stop(finalMessage?: string): void;
  /** Whether the spinner is currently running */
  readonly running: boolean;
}

export function createSpinner(): Spinner {
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  let wordTimer: ReturnType<typeof setInterval> | null = null;
  let frameIdx = 0;
  let wordIdx = 0;
  let currentMessage = '';
  let wordList: string[] = IDLE_WORDS;

  // Remember the cursor position where the spinner line was drawn.
  // We use this to overwrite the line cleanly.
  let lastLineLen = 0;

  function draw(message: string): void {
    const frame = FRAMES[frameIdx % FRAMES.length];
    const line = `  ${GREEN}${frame}${RESET} ${GRAY}${message}${RESET}`;

    // Clear the previous line first with \r and spaces, then write new line
    const clear = ' '.repeat(Math.max(0, lastLineLen));
    process.stderr.write(`\r${clear}\r${line}`);
    lastLineLen = line.replace(/\x1b\[[0-9;]*m/g, '').length;
  }

  function clear(): void {
    if (lastLineLen > 0) {
      process.stderr.write(`\r${' '.repeat(lastLineLen)}\r`);
      lastLineLen = 0;
    }
  }

  function isRunning(): boolean {
    return frameTimer !== null;
  }

  const self: Spinner = {
    get running() {
      return isRunning();
    },

    start(message: string) {
      if (isRunning()) {
        // Already running — just change the message
        currentMessage = message;
        draw(message);
        return;
      }

      currentMessage = message;
      wordList = IDLE_WORDS;
      frameIdx = 0;
      wordIdx = 0;

      draw(message);

      // Braille frame animation — fast
      frameTimer = setInterval(() => {
        frameIdx++;
        draw(currentMessage);
      }, FRAME_INTERVAL);

      // Word shuffle — every 0.5s
      wordTimer = setInterval(() => {
        wordIdx = (wordIdx + 1) % wordList.length;
        currentMessage = wordList[wordIdx];
        // draw() is called by frameTimer, which reads currentMessage
      }, WORD_INTERVAL);
    },

    update(message: string) {
      // Show a specific message — stop word cycling, just show this
      currentMessage = message;
      wordList = [message]; // single-word list so shuffle doesn't change it
      wordIdx = 0;
      draw(message);
    },

    stop(finalMessage?: string) {
      if (frameTimer !== null) {
        clearInterval(frameTimer);
        frameTimer = null;
      }
      if (wordTimer !== null) {
        clearInterval(wordTimer);
        wordTimer = null;
      }

      if (finalMessage) {
        // Show final status on the spinner line
        const line = `  ${GREEN}✓${RESET} ${GRAY}${finalMessage}${RESET}`;
        const clear = ' '.repeat(Math.max(0, lastLineLen));
        process.stderr.write(`\r${clear}\r${line}\n`);
      } else {
        clear();
      }
      lastLineLen = 0;
      currentMessage = '';
      wordList = IDLE_WORDS;
    },
  };

  return self;
}
