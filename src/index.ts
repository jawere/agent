import * as readline from 'readline';
import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { runAgent } from './agent.js';
import { loadConfig, hasApiKey } from './config.js';
import { saveKey, loadKey, deleteKey, hasKey } from './crypto.js';
import { listSessions } from './convex-client.js';
import { runScanner } from './scanner.js';
import { createPrompt } from './prompt.js';

// ── Helpers ─────────────────────────────────────────────────────────

// Gruvbox colors
const G_FG = '\x1b[38;2;235;219;178m';
const G_GREEN = '\x1b[38;2;184;187;3m';
const G_GRAY = '\x1b[38;2;146;131;116m';
const G_AQUA = '\x1b[38;2;142;192;124m';
const R = '\x1b[0m';

function center(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, Math.floor((width - visible.length) / 2));
  return ' '.repeat(pad) + text;
}

function printBanner(config: { model: string; isDev: boolean }) {
  const cols = process.stdout.columns || 60;
  const sep = G_GRAY + '─'.repeat(Math.min(cols - 2, 50)) + R;
  console.log('');
  console.log(center(`${G_GRAY}${config.model}${R}  ${G_GRAY}${config.isDev ? 'dev' : 'prod'}${R}`, cols));
  console.log(center(sep, cols));
  console.log('');
}

function printHelp() {
  console.log(`
${G_GREEN}Commands:${R}
  ${G_GRAY}/help${R}          Show this help
  ${G_GRAY}/sessions${R}      List recent Convex sessions
  ${G_GRAY}/load${R} <num>    Resume a session (run /sessions first)
  ${G_GRAY}/key${R}           Show API key status
  ${G_GRAY}/setup${R}         Re-enter API key
  ${G_GRAY}/clear${R}         Clear screen & start fresh session
  ${G_GRAY}/exit${R}, ${G_GRAY}/quit${R}   Quit
`);
}

async function setupKey(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nEnter your DeepSeek API key (starts with sk-):');
  const key = await new Promise<string>((resolve) => {
    rl.question('API Key: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!key) {
    console.log('No key entered. Aborting setup.');
    return;
  }

  if (!key.startsWith('sk-')) {
    console.log('Warning: Key does not start with "sk-". Saving anyway...');
  }

  await saveKey(key);
  console.log(`API key encrypted and saved to ~/.jawere/key.enc`);
}

async function showSessions(convexUrl: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const sessions = await listSessions(convexUrl);
    if (sessions.length === 0) {
      console.log('No sessions found.');
      return map;
    }
    console.log(`\nRecent sessions:`);
    let i = 1;
    for (const s of sessions) {
      const date = new Date(s.updatedAt).toLocaleString();
      const shortId = s._id.slice(0, 10);
      console.log(`  ${i}. ${shortId}…  ${date}  ${s.title.slice(0, 50)}`);
      map.set(i, s._id);
      i++;
    }
    console.log(`\nUse /load <number> to resume a session.`);
  } catch (err: any) {
    console.log(`Error fetching sessions: ${err.message}`);
  }
  return map;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Parse --setup flag
  const setupMode = process.argv.includes('--setup');

  const config = await loadConfig();

  if (setupMode) {
    await setupKey();
    console.log('Setup complete. Run again without --setup to start.');
    process.exit(0);
  }

  // Check for API key
  if (!config.apiKey) {
    const hasExistingKey = await hasKey();
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   jawere — AI Coding Agent                  ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log('║ No API key found.                        ║');
    console.log('║                                          ║');
    console.log('║ Option 1: Set DEEPSEEK_API_KEY env var   ║');
    console.log('║ Option 2: Run --setup to encrypt & save  ║');
    console.log('║                                          ║');
    console.log('║   npx tsx src/index.ts --setup            ║');
    console.log('╚══════════════════════════════════════════╝');
    process.exit(1);
  }

  // Clear screen, print banner at top
  console.clear();
  printBanner(config);

  // ── Phase 1: Background codebase scan ─────────────────────────
  process.stderr.write(`${G_GRAY}Scanning codebase…${R}`);
  try {
    const scanResult = await runScanner(config.workDir);
    if (scanResult.cached) {
      process.stderr.write(` ${G_GRAY}(${scanResult.fileCount} files)${R}\n`);
    } else {
      process.stderr.write(`${G_GRAY}Done — ${scanResult.fileCount} files indexed${R}\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(` ${G_GRAY}[skipped: ${msg}]${R}\n`);
  }

  let currentSessionId: string | undefined;
  let conversationHistory: ChatCompletionMessageParam[] = [];
  let sessionMap = new Map<number, string>();
  let sessionShown = false;

  // ── Initialize working memory ─────────────────────────────────
  // .codebase/state.md serves as the agent's scratchpad between turns.
  // Reset it at session start so stale memory doesn't mislead.
  try {
    const codebaseDir = resolve(config.workDir, '.codebase');
    await mkdir(codebaseDir, { recursive: true });
    await writeFile(
      resolve(codebaseDir, 'state.md'),
      [
        '# Working Memory',
        '',
        `Session started: ${new Date().toISOString()}`,
        '',
        '## Files Read (with hashes)',
        '(none yet)',
        '',
        '## Files Modified',
        '(none yet)',
        '',
        '## Current Task',
        '(no task yet)',
        '',
        '## Notes',
        '(none yet)',
        '',
      ].join('\n'),
      'utf-8',
    );
  } catch {
    // Not critical — agent works without state.md too
  }

  // ── Prompt setup ──────────────────────────────────────────────
  const { prompt, enableBracketedPaste, disableBracketedPaste } = createPrompt();
  enableBracketedPaste();

  // Ctrl+C during agent execution aborts the run but keeps the REPL alive.
  // (During the prompt, readline intercepts Ctrl+C on its own.)
  let runningAbort: AbortController | null = null;
  const sigintHandler = () => {
    if (runningAbort) {
      runningAbort.abort();
      process.stderr.write('\n');
    }
  };
  process.on('SIGINT', sigintHandler);

  while (true) {
    const input = await prompt();

    if (!input) continue;

    // ── Commands ──
    if (input.startsWith('/')) {
      const [cmd, ...args] = input.slice(1).split(/\s+/);
      const arg = args.join(' ');

      switch (cmd.toLowerCase()) {
        case 'help':
          printHelp();
          break;
        case 'sessions':
          sessionMap = await showSessions(config.convexUrl);
          break;
        case 'load':
          if (arg) {
            const num = parseInt(arg, 10);
            if (!isNaN(num) && sessionMap.has(num)) {
              currentSessionId = sessionMap.get(num);
              conversationHistory = [];
              sessionShown = true;
              console.log(`Resumed session #${num}: ${currentSessionId?.slice(0, 12)}…`);
            } else if (arg.length > 10) {
              // Direct ID fallback
              currentSessionId = arg;
              conversationHistory = [];
              sessionShown = true;
              console.log(`Resumed session: ${arg.slice(0, 12)}…`);
            } else {
              console.log(`Session #${arg} not found. Run /sessions first.`);
            }
          } else {
            console.log('Usage: /load <number>  (run /sessions first)');
          }
          break;
        case 'key': {
          const savedKey = await loadKey();
          if (savedKey) {
            console.log(`Key status: saved (encrypted) — ${savedKey.slice(0, 8)}...`);
          } else if (process.env.DEEPSEEK_API_KEY) {
            console.log(`Key status: DEEPSEEK_API_KEY env var`);
          } else {
            console.log(`Key status: NOT SET`);
          }
          break;
        }
        case 'setup':
          await setupKey();
          console.log('Restart the agent to pick up the new key.');
          break;
        case 'clear':
          console.clear();
          printBanner(config);
          conversationHistory = [];
          currentSessionId = undefined;
          sessionShown = false;
          break;
        case 'exit':
        case 'quit':
          console.log('Goodbye!');
          disableBracketedPaste();
          process.exit(0);
        default:
          console.log(`Unknown command: /${cmd}. Type /help for commands.`);
      }
      continue;
    }

    // ── Agent run ──
    // Show session banner once per session
    if (!sessionShown && currentSessionId && currentSessionId !== 'local') {
      console.log(`${G_GRAY}[session: ${currentSessionId.slice(0, 12)}…]${R}`);
      sessionShown = true;
    }

    try {
      // Create abort controller for this run
      runningAbort = new AbortController();
      const result = await runAgent(input, {
        sessionId: currentSessionId,
        history: conversationHistory,
        signal: runningAbort.signal,
      });
      runningAbort = null;

      // The final summary is already printed by runAgent internally.
      // We just track session state here.

      // Track session (show banner on first turn)
      if (!currentSessionId || currentSessionId === 'local') {
        currentSessionId = result.sessionId;
        if (currentSessionId !== 'local' && !sessionShown) {
          console.log(`\n${G_GRAY}[session: ${currentSessionId.slice(0, 12)}…]${R}`);
          sessionShown = true;
        }
      }
      conversationHistory = result.history;
    } catch (err: unknown) {
      runningAbort = null;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nError: ${msg}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
