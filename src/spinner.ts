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

// Fun verb list — one random word shown each frame tick
const WORDS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking',
  'Beaming', 'Beboppin\'', 'Befuddling', 'Billowing', 'Blanching',
  'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping',
  'Brewing', 'Burrowing', 'Calculating', 'Canoodling', 'Caramelizing',
  'Cascading', 'Catapulting', 'Cerebrating', 'Channeling', 'Channelling',
  'Choreographing', 'Churning', 'Clauding', 'Coalescing', 'Cogitating',
  'Combobulating', 'Composing', 'Computing', 'Concocting', 'Considering',
  'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching',
  'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating',
  'Determining', 'Dilly-dallying', 'Discombobulating', 'Doing', 'Doodling',
  'Drizzling', 'Ebbing', 'Effecting', 'Elucidating', 'Embellishing',
  'Enchanting', 'Envisioning', 'Evaporating', 'Fermenting',
  'Fiddle-faddling', 'Finagling', 'Flambeing', 'Flibbertigibbeting',
  'Flowing', 'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking',
  'Frosting', 'Gallivanting', 'Galloping', 'Garnishing', 'Generating',
  'Germinating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing',
  'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing',
  'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating',
  'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning',
  'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting',
  'Marinating', 'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking',
  'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing', 'Nesting',
  'Newspapering', 'Noodling', 'Nucleating', 'Orbiting', 'Orchestrating',
  'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophising',
  'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating',
  'Pouncing', 'Precipitating', 'Prestidigitating', 'Processing', 'Proofing',
  'Propagating', 'Puttering', 'Puzzling', 'Quantumizing',
  'Razzle-dazzling', 'Razzmatazzing', 'Recombobulating', 'Reticulating',
  'Roosting', 'Ruminating', 'Sauteing', 'Scampering', 'Schlepping',
  'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering',
  'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping',
  'Spelunking', 'Spinning', 'Sprouting', 'Stewing', 'Sublimating',
  'Swirling', 'Swooping', 'Symbioting', 'Synthesizing', 'Tempering',
  'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering', 'Topsy-turvying',
  'Transfiguring', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling',
  'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping',
  'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling',
  'Working', 'Wrangling', 'Zesting', 'Zigzagging',
];

// Gruvbox colors
const GRAY = '\x1b[38;2;146;131;116m';
const GREEN = '\x1b[38;2;184;187;3m';
const RESET = '\x1b[0m';

const FRAME_INTERVAL = 80; // ms per frame

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
  let interval: ReturnType<typeof setInterval> | null = null;
  let frameIdx = 0;
  let currentMessage = '';

  // Remember the cursor position where the spinner line was drawn.
  // We use this to overwrite the line cleanly.
  let lastLineLen = 0;

  function pickWord(): string {
    return WORDS[Math.floor(Math.random() * WORDS.length)];
  }

  function draw(message: string): void {
    const frame = FRAMES[frameIdx % FRAMES.length];
    const word = pickWord();
    const line = `  ${GREEN}${frame}${RESET} ${GRAY}${word}…${RESET}`;

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

  const self: Spinner = {
    get running() {
      return interval !== null;
    },

    start(message: string) {
      if (interval !== null) {
        // Already running — just change the message
        currentMessage = message;
        draw(message);
        return;
      }

      currentMessage = message;
      frameIdx = 0;

      draw(message);
      interval = setInterval(() => {
        frameIdx++;
        draw(currentMessage);
      }, FRAME_INTERVAL);
    },

    update(message: string) {
      // Show the actual message for important state changes
      currentMessage = message;
      draw(message);
    },

    stop(finalMessage?: string) {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
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
    },
  };

  return self;
}
