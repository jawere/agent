// @jawere/coding-agent — Main CLI entry point (REPL loop)

import * as readline from "readline";
import { writeFile, mkdir } from "fs/promises";
import { resolve } from "path";
import { loadConfig, hasApiKey } from "./config.js";
import {
  saveKey,
  loadKey,
  deleteKey,
  hasKey,
  saveConfig,
  type SavedConfig,
} from "./crypto.js";
import { SessionManager } from "./session/manager.js";
import type { JsonlSessionMetadata } from "./session/types.js";
import { Session } from "./session/session.js";
import { runScanner } from "./scanner.js";
import { createPrompt, loadFileList } from "@jawere/tui";
import { SYSTEM_PROMPT } from "./system-prompt.js";

// Gruvbox dark palette
const G_GREEN  = "\x1b[38;2;184;187;38m"; // #b8bb26
const G_GREEN2 = "\x1b[38;2;142;192;124m";// #8ec07c
const G_GRAY   = "\x1b[38;2;146;131;116m"; // #928374
const G_DIM    = "\x1b[38;2;102;92;84m";  // #665c54
const G_FG     = "\x1b[38;2;235;219;178m";// #ebdbb2
const R = "\x1b[0m";

function center(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, Math.floor((width - visible.length) / 2));
  return " ".repeat(pad) + text;
}

function printBanner(config: { model: string; provider: string; isDev: boolean }) {
  const cols = process.stdout.columns || 60;
  const sep = G_DIM + "─".repeat(Math.min(cols - 2, 50)) + R;
  console.log("");
  console.log(
    center(
      `${G_GREEN}${config.provider}${R} ${G_DIM}/${R} ${G_FG}${config.model}${R}  ${G_DIM}${config.isDev ? "dev" : "prod"}${R}`,
      cols,
    ),
  );
  console.log(center(sep, cols));
  console.log("");
}

function printHelp() {
  console.log(`
${G_GREEN}Commands:${R}
  ${G_FG}/help${R}          Show this help
  ${G_FG}/sessions${R}      List past sessions
  ${G_FG}/resume <id>${R}   Resume a past session
  ${G_FG}/key${R}           Show API key status
  ${G_FG}/setup${R}         Re-configure AI provider & key
  ${G_FG}/clear${R}         Clear screen & start fresh session
  ${G_FG}/exit${R}, ${G_FG}/quit${R}   Quit

${G_GREEN}CLI flags:${R}
  ${G_FG}--setup${R}        Run setup wizard (provider, key, model)
  ${G_FG}--update${R}       Quick update: pull, install, build, push as fix
`);
}

function formatTime(iso: string): string {
  const d = new Date(iso + "Z");
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

async function setupKey(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));

  console.log("");
  console.log(`${G_GREEN}╔══════════════════════════════════════════╗${R}`);
  console.log(`${G_GREEN}║   jawere — Setup                         ║${R}`);
  console.log(`${G_GREEN}╚══════════════════════════════════════════╝${R}`);
  console.log("");

  console.log("Select AI provider:");
  console.log(`  ${G_GREEN2}1.${R} DeepSeek`);
  console.log(`  ${G_GREEN2}2.${R} OpenAI`);
  console.log(`  ${G_GREEN2}3.${R} Anthropic`);
  console.log(`  ${G_GREEN2}4.${R} Google Gemini`);
  console.log(`  ${G_GREEN2}5.${R} Groq`);
  console.log(`  ${G_GREEN2}6.${R} xAI (Grok)`);
  console.log(`  ${G_GREEN2}7.${R} Mistral`);
  console.log(`  ${G_GREEN2}8.${R} OpenRouter`);
  console.log(`  ${G_GREEN2}9.${R} Custom (enter base URL)`);
  console.log("");

  const choice = (await ask(`Choice [1]: `)) || "1";

  let provider: SavedConfig["provider"] = "deepseek";
  let baseURL: string | undefined;
  let defaultModel: string;

  switch (choice) {
    case "2":
      provider = "openai";
      defaultModel = "gpt-4o";
      break;
    case "3":
      provider = "anthropic";
      defaultModel = "claude-sonnet-4-20250514";
      break;
    case "4":
      provider = "google";
      defaultModel = "gemini-2.5-pro";
      break;
    case "5":
      provider = "groq";
      defaultModel = "llama-3.3-70b-versatile";
      break;
    case "6":
      provider = "xai";
      defaultModel = "grok-3-beta";
      break;
    case "7":
      provider = "mistral";
      defaultModel = "mistral-large-latest";
      break;
    case "8":
      provider = "openrouter";
      defaultModel = "openai/gpt-4o";
      break;
    case "9":
      provider = "custom";
      console.log("");
      baseURL = await ask("Base URL (e.g. https://api.openai.com/v1): ");
      if (!baseURL) {
        console.log("No URL entered. Aborting setup.");
        rl.close();
        return;
      }
      defaultModel = "gpt-4o";
      break;
    default:
      provider = "deepseek";
      defaultModel = "deepseek-chat";
      break;
  }

  console.log("");
  const keyHints: Record<string, string> = {
    openai: "sk-",
    deepseek: "sk-",
    anthropic: "sk-ant-",
    google: "",
    groq: "gsk_",
    xai: "xai-",
    mistral: "",
    openrouter: "sk-or-",
    custom: "",
  };
  const keyHint = keyHints[provider] ?? "";
  const hintText = keyHint ? ` (starts with ${keyHint})` : "";
  console.log(`Enter your API key${hintText}:`);
  const key = await ask("API Key: ");

  if (!key) {
    console.log("No key entered. Aborting setup.");
    rl.close();
    return;
  }

  console.log("");
  const model = (await ask(`Model [${defaultModel}]: `)) || defaultModel;

  await saveKey(key);
  await saveConfig({ provider, baseURL: baseURL || undefined, model });

  console.log("");
  console.log(`${G_GREEN}Setup complete!${R}`);
  console.log(`  Provider : ${G_GREEN2}${provider}${R}`);
  console.log(`  Model    : ${G_GREEN2}${model}${R}`);
  console.log(`  Key saved: ~/.jawere/key.enc`);
  console.log("");

  rl.close();
}

// ── Main ────────────────────────────────────────────────────────────

async function quickUpdate(): Promise<void> {
  const { execSync } = await import("child_process");

  console.log(`${G_GREEN}╔══════════════════════════════════════════╗${R}`);
  console.log(`${G_GREEN}║   jawere — Quick Update                  ║${R}`);
  console.log(`${G_GREEN}╚══════════════════════════════════════════╝${R}\n`);

  // Detect if installed globally
  let isGlobal = false;
  try {
    execSync("npm list -g @jawere/coding-agent", { encoding: "utf-8", stdio: "pipe" });
    isGlobal = true;
  } catch {}

  const installCmd = isGlobal
    ? "npm install -g @jawere/coding-agent@latest"
    : "npm install @jawere/coding-agent@latest";

  console.log(`${G_GRAY}── Updating @jawere/coding-agent to latest ──${R}`);
  console.log(`${G_DIM}→ ${installCmd}${R}`);

  try {
    const out = execSync(installCmd, { encoding: "utf-8", stdio: "pipe" });
    if (out.trim()) console.log(out.trim());
  } catch (e: any) {
    console.error(`${G_GREEN2}✗${R} ${e.stderr || e.message}`);
    process.exit(1);
  }

  // Print new version
  try {
    const ver = execSync("jawere --version 2>/dev/null || npx jawere --version 2>/dev/null", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    console.log(`\n${G_GREEN}✓ Updated to ${ver || "latest"}${R}`);
  } catch {
    console.log(`\n${G_GREEN}✓ Update complete!${R}`);
  }
}

async function main(): Promise<void> {
  const setupMode = process.argv.includes("--setup");
  const updateMode = process.argv.includes("--update");
  const config = await loadConfig();

  if (setupMode) {
    await setupKey();
    console.log("Setup complete. Run again without --setup to start.");
    process.exit(0);
  }

  if (updateMode) {
    await quickUpdate();
    process.exit(0);
  }

  if (!config.apiKey) {
    console.log("╔══════════════════════════════════════════╗");
    console.log("║        jawere — AI Coding Agent          ║");
    console.log("╠══════════════════════════════════════════╣");
    console.log("║ No API key found.                        ║");
    console.log("║                                          ║");
    console.log("║ Option 1: Set AI_API_KEY env var         ║");
    console.log("║ Option 2: Run jawere --setup             ║");
    console.log("║                                          ║");
    console.log("╚══════════════════════════════════════════╝");
    process.exit(1);
  }

  console.clear();
  printBanner(config);

  // Phase 1: Background scan
  process.stderr.write(`${G_DIM}Scanning codebase…${R}`);
  try {
    const scanResult = await runScanner(config.workDir);
    if (scanResult.cached) {
      process.stderr.write(` ${G_DIM}(${scanResult.fileCount} files cached)${R}\n`);
    } else {
      process.stderr.write(` ${G_GREEN}Done${R} ${G_DIM}— ${scanResult.fileCount} files indexed${R}\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(` ${G_DIM}[skipped: ${msg}]${R}\n`);
  }

  // Phase 2: Init SessionManager
  const sessionManager = new SessionManager({
    sessionsRoot: resolve(config.workDir, ".codebase", "sessions"),
    workDir: config.workDir,
  });

  let currentSession: Session<JsonlSessionMetadata> | null = null;
  let currentMetadata: JsonlSessionMetadata | null = null;
  let conversationHistory: any[] = [];
  let sessionShown = false;

  // Init working memory
  try {
    const codebaseDir = resolve(config.workDir, ".codebase");
    await mkdir(codebaseDir, { recursive: true });
    await writeFile(
      resolve(codebaseDir, "state.md"),
      [
        "# Working Memory",
        "",
        `Session started: ${new Date().toISOString()}`,
        "",
        "## Files Read (with hashes)",
        "(none yet)",
        "",
        "## Files Modified",
        "(none yet)",
        "",
        "## Current Task",
        "(no task yet)",
        "",
        "## Notes",
        "(none yet)",
        "",
      ].join("\n"),
      "utf-8",
    );
  } catch {
    // best effort
  }

  const { prompt, enableBracketedPaste, disableBracketedPaste } = createPrompt({
    getFiles: () => loadFileList(config.workDir),
  });
  enableBracketedPaste();

  let runningAbort: AbortController | null = null;
  let sigintCount = 0;
  const sigintHandler = () => {
    sigintCount++;
    if (sigintCount >= 2) {
      // Double Ctrl+C — force exit
      process.stderr.write("\n");
      process.exit(1);
    }
    if (runningAbort) {
      runningAbort.abort();
      process.stderr.write("\n");
    }
    // Reset counter after 1s
    setTimeout(() => { sigintCount = 0; }, 1000);
  };
  process.on("SIGINT", sigintHandler);

  const exitHandler = () => {
    // Session persists on disk; nothing to close
  };
  process.on("exit", exitHandler);
  process.on("SIGHUP", exitHandler);

  while (true) {
    const input = await prompt();
    if (!input) continue;

    if (input.startsWith("/")) {
      const [cmd, ...args] = input.slice(1).split(/\s+/);
      const arg = args.join(" ");

      switch (cmd.toLowerCase()) {
        case "help":
          printHelp();
          break;
        case "key": {
          const savedKey = await loadKey();
          if (savedKey) {
            console.log(
              `Key status: saved (encrypted) — ${savedKey.slice(0, 3)}...`,
            );
          } else if (process.env.DEEPSEEK_API_KEY) {
            console.log(
              `Key status: DEEPSEEK_API_KEY env var (starts ${process.env.DEEPSEEK_API_KEY.slice(0, 3)}...)`,
            );
          } else {
            console.log(`Key status: NOT SET`);
          }
          break;
        }
        case "setup":
          await setupKey();
          console.log("Restart the agent to pick up the new key.");
          break;
        case "clear":
          console.clear();
          printBanner(config);
          conversationHistory = [];
          currentSession = null;
          currentMetadata = null;
          sessionShown = false;
          break;
        case "sessions": {
          const sessions = await sessionManager.list({ limit: 20 });
          if (sessions.length === 0) {
            console.log(`${G_DIM}No past sessions.${R}`);
          } else {
            console.log(`\n${G_GREEN}Past sessions:${R}`);
            for (const s of sessions) {
              const time = formatTime(s.createdAt);
              console.log(
                `  ${G_GREEN2}${s.id.slice(0, 16)}…${R}  ${G_DIM}${time}${R}`,
              );
            }
            console.log(
              `${G_DIM}Use /resume <id> to restore a session.${R}`,
            );
          }
          break;
        }
        case "resume": {
          if (!arg) {
            console.log(`${G_DIM}Usage: /resume <session-id>${R}`);
            break;
          }
          const sessions = await sessionManager.list({ limit: 100 });
          const meta = sessions.find((s) => s.id.startsWith(arg));
          if (!meta) {
            console.log(`${G_DIM}Session not found: ${arg}${R}`);
          } else {
            currentSession = await sessionManager.open(meta);
            currentMetadata = meta;
            const ctx = await currentSession.buildContext();
            conversationHistory = ctx.messages as any[];
            sessionShown = true;
            console.log(
              `${G_GREEN}Resumed session ${meta.id.slice(0, 16)}…${R} ${G_DIM}(${ctx.messages.length} messages)${R}`,
            );
          }
          break;
        }
        case "exit":
        case "quit":
          console.log("Goodbye!");
          disableBracketedPaste();
          process.exit(0);
        default:
          console.log(
            `Unknown command: /${cmd}. Type /help for commands.`,
          );
      }
      continue;
    }

    // Agent run — delegates to the agent loop from @jawere/agent
    if (!sessionShown && currentMetadata) {
      console.log(`${G_DIM}[session: ${currentMetadata.id.slice(0, 12)}…]${R}`);
      sessionShown = true;
    }

    try {
      runningAbort = new AbortController();

      // Import agent runner dynamically (lazy load)
      const { runAgent } = await import("./agent-runner.js");

      const result = await runAgent(input, {
        config,
        sessionId: currentMetadata?.id,
        history: conversationHistory,
        signal: runningAbort.signal,
      });
      runningAbort = null;

      // Create session on first prompt
      if (!currentSession) {
        try {
          currentSession = await sessionManager.create();
          currentMetadata = await currentSession.getMetadata();
        } catch {
          currentSession = null;
          currentMetadata = null;
        }
        sessionShown = true;
        if (currentMetadata) {
          console.log(
            `\n${G_DIM}[session: ${currentMetadata.id.slice(0, 16)}…]${R}`,
          );
        }
      }
      conversationHistory = result.history;

      // Persist messages to session
      if (currentSession) {
        try {
          for (const msg of result.allMessages ?? []) {
            await currentSession.appendMessage(msg);
          }
        } catch {
          // best effort
        }
      }
    } catch (err: unknown) {
      runningAbort = null;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nError: ${msg}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
