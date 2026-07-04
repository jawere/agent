import * as readline from 'readline';
import { writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { runAgent } from './agent.js';
import { loadConfig, hasApiKey } from './config.js';
import { saveKey, loadKey, deleteKey, hasKey, saveConfig, type SavedConfig } from './crypto.js';

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

function printBanner(config: { model: string; provider: string; isDev: boolean }) {
  const cols = process.stdout.columns || 60;
  const sep = G_GRAY + '─'.repeat(Math.min(cols - 2, 50)) + R;
  console.log('');
  console.log(center(`${G_GRAY}${config.provider} / ${config.model}${R}  ${G_GRAY}${config.isDev ? 'dev' : 'prod'}${R}`, cols));
  console.log(center(sep, cols));
  console.log('');
}

function printHelp() {
  console.log(`
${G_GREEN}Commands:${R}
  ${G_GRAY}/help${R}          Show this help

  ${G_GRAY}/key${R}           Show API key status
  ${G_GRAY}/setup${R}         Re-configure AI provider & key
  ${G_GRAY}/clear${R}         Clear screen & start fresh session
  ${G_GRAY}/exit${R}, ${G_GRAY}/quit${R}   Quit

${G_GREEN}CLI flags:${R}
  ${G_GRAY}--setup${R}        Run setup wizard (provider, key, model)
`);
}

async function setupKey(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

  console.log('');
  console.log(`${G_GREEN}╔══════════════════════════════════════════╗${R}`);
  console.log(`${G_GREEN}║   jawere — Setup                         ║${R}`);
  console.log(`${G_GREEN}╚══════════════════════════════════════════╝${R}`);
  console.log('');

  // ── Provider selection ──
  console.log('Select AI provider:');
  console.log(`  ${G_AQUA}1.${R} DeepSeek`);
  console.log(`  ${G_AQUA}2.${R} OpenAI`);
  console.log(`  ${G_AQUA}3.${R} Custom (enter base URL)`);
  console.log('');

  const choice = await ask(`Choice [1]: `) || '1';

  let provider: SavedConfig['provider'] = 'deepseek';
  let baseURL: string | undefined;
  let defaultModel: string;

  if (choice === '2') {
    provider = 'openai';
    defaultModel = 'gpt-4o';
  } else if (choice === '3') {
    provider = 'custom';
    console.log('');
    baseURL = await ask('Base URL (e.g. https://api.openai.com/v1): ');
    if (!baseURL) {
      console.log('No URL entered. Aborting setup.');
      rl.close();
      return;
    }
    defaultModel = 'gpt-4o';
  } else {
    provider = 'deepseek';
    defaultModel = 'deepseek-v4-pro';
  }

  // ── API Key ──
  console.log('');
  const keyHint = provider === 'openai' ? 'sk-' : provider === 'deepseek' ? 'sk-' : '';
  const hintText = keyHint ? ` (starts with ${keyHint})` : '';
  console.log(`Enter your API key${hintText}:`);
  const key = await ask('API Key: ');

  if (!key) {
    console.log('No key entered. Aborting setup.');
    rl.close();
    return;
  }

  // ── Model ──
  console.log('');
  const model = await ask(`Model [${defaultModel}]: `) || defaultModel;

  // ── Save ──
  await saveKey(key);
  await saveConfig({ provider, baseURL: baseURL || undefined, model });

  console.log('');
  console.log(`${G_GREEN}Setup complete!${R}`);
  console.log(`  Provider : ${G_AQUA}${provider}${R}`);
  console.log(`  Model    : ${G_AQUA}${model}${R}`);
  console.log(`  Key saved: ~/.jawere/key.enc`);
  console.log('');

  rl.close();
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
    console.log('╔══════════════════════════════════════════╗');
    console.log('║        jawere — AI Coding Agent          ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log('║ No API key found.                        ║');
    console.log('║                                          ║');
    console.log('║ Option 1: Set AI_API_KEY env var         ║');
    console.log('║ Option 2: Run jawere --setup             ║');
    console.log('║                                          ║');
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
        case 'key': {
          const savedKey = await loadKey();
          if (savedKey) {
            console.log(`Key status: saved (encrypted) — ${savedKey.slice(0, 3)}...`);
          } else if (process.env.DEEPSEEK_API_KEY) {
            console.log(`Key status: DEEPSEEK_API_KEY env var (starts ${process.env.DEEPSEEK_API_KEY.slice(0, 3)}...)`);
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
