// @jawere/coding-agent — Main CLI entry point (REPL loop)

import * as readline from "readline";
import { mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { loadConfig, type Config } from "./config.js";
import {
  saveKey,
  loadKey,
  saveConfig,
  deleteKey,
  loadSavedConfig,
  type SavedConfig,
  type SavedProvider,
} from "./crypto.js";
import { createPrompt } from "@jawere/tui";
import { runScanner, loadFileList } from "./scanner.js";
import { type DisplayState, createDisplaySubscriber } from "./agent-runner.js";
import { PiRpcAgent, type ExtensionUIHandler, type ExtensionUIRequest, type ExtensionUIResponse } from "./pi-rpc-agent.js";
import type { SlashCommand } from "@jawere/pi-tui";
import { resolvePiBinary, getPiInstallInstructions, type PiInfo } from "./pi-resolver.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createSpinner } from "@jawere/tui";

// Gruvbox dark palette
const G_GREEN  = "\x1b[38;2;184;187;38m"; // #b8bb26
const G_GREEN2 = "\x1b[38;2;142;192;124m";// #8ec07c
const G_GRAY   = "\x1b[38;2;146;131;116m"; // #928374
const G_DIM    = "\x1b[38;2;102;92;84m";  // #665c54
const G_FG     = "\x1b[38;2;235;219;178m";// #ebdbb2
const G_RED    = "\x1b[38;2;251;73;52m";  // #fb4934
const G_YELLOW = "\x1b[38;2;250;189;47m"; // #fabd2f
const G_BLUE   = "\x1b[38;2;131;165;152m";// #83a598
const G_ORANGE = "\x1b[38;2;254;128;25m"; // #fe8019
const G_MAGENTA = "\x1b[38;2;211;134;155m"; // #d3869b — Gruvbox purple
const R = "\x1b[0m";

function center(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, Math.floor((width - visible.length) / 2));
  return " ".repeat(pad) + text;
}

function printBanner(config: { model: string; provider: string; isDev: boolean; thinkingLevel?: string }) {
  const cols = process.stdout.columns || 60;
  const sep = G_DIM + "─".repeat(Math.min(cols - 2, 50)) + R;
  const thinkingStr = config.thinkingLevel && config.thinkingLevel !== "off"
    ? ` ${G_DIM}think:${R}${G_MAGENTA}${config.thinkingLevel}${R}`
    : "";
  console.log("");
  console.log(
    center(
      `${G_GREEN}${config.provider}${R} ${G_DIM}/${R} ${G_FG}${config.model}${R}  ${G_DIM}${config.isDev ? "dev" : "prod"}${R}${thinkingStr}`,
      cols,
    ),
  );
  console.log(center(sep, cols));
  console.log("");
}

// ── Models.json loader ─────────────────────────────────────────────

interface ModelEntry {
  id: string;
  name: string;
  contextWindow: number;
}

interface ProviderEntry {
  baseURL: string;
  envKey: string;
  models: ModelEntry[];
}

interface ModelsConfig {
  version: string;
  defaultModel: string;
  defaultProvider: string;
  providers: Record<string, ProviderEntry>;
  thinkingLevels: Record<string, { description: string }>;
  defaults: { thinkingLevel: string; timeout: number };
}

async function loadModelsConfig(): Promise<ModelsConfig | null> {
  // Try project-level, then package-level
  const paths = [
    resolve(process.cwd(), "models.json"),
    resolve(process.cwd(), "packages/coding-agent/models.json"),
  ];
  // Resolve relative to the module
  const selfDir = new URL(".", import.meta.url).pathname;
  paths.push(resolve(selfDir, "../../models.json"));

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return JSON.parse(await readFile(p, "utf-8"));
      } catch {
        // continue
      }
    }
  }
  return null;
}

// ── Slash commands ─────────────────────────────────────────────────

function printHelp() {
  console.log(`
${G_GREEN}jawere — Terminal AI Coding Agent${R}

${G_YELLOW}Commands:${R}
  ${G_FG}/help${R}                    Show this help
  ${G_FG}/key${R}                     Show API key status for current provider
  ${G_FG}/key add${R}                 Add or change API key for current provider
  ${G_FG}/key delete${R}              Delete saved API key
  ${G_FG}/key list${R}                List all configured API keys (masked)
  ${G_FG}/model${R}                   Show current model
  ${G_FG}/model list${R}              List available models for current provider
  ${G_FG}/model list all${R}          List all models across all providers
  ${G_FG}/model switch <name>${R}     Switch to a different model
  ${G_FG}/provider${R}                Show current provider
  ${G_FG}/provider list${R}           List all providers
  ${G_FG}/provider switch <name>${R}  Switch provider (updates model too)
  ${G_FG}/think${R}                   Show current thinking level
  ${G_FG}/think <level>${R}           Set thinking level (off|minimal|low|medium|high|xhigh)
  ${G_FG}/setup${R}                   Run full setup wizard
  ${G_FG}/clear${R}                   Clear screen
  ${G_FG}/exit${R}, ${G_FG}/quit${R}             Quit
`);
}

async function cmdKey(args: string[], config: Config): Promise<void> {
  const sub = args[1] || "status";

  switch (sub) {
    case "status":
    case "show": {
      const savedKey = await loadKey();
      if (savedKey) {
        console.log(`${G_GREEN}●${R} API key saved for ${G_GREEN2}${config.provider}${R}`);
        console.log(`  Key: ${G_DIM}${savedKey.slice(0, 4)}...${savedKey.slice(-3)}${R}`);
        const saved = await loadSavedConfig();
        if (saved) {
          console.log(`  Model: ${G_FG}${saved.model || config.model}${R}`);
          if (saved.baseURL) console.log(`  URL: ${G_DIM}${saved.baseURL}${R}`);
        }
      } else if (config.apiKey) {
        console.log(`${G_GREEN}●${R} API key from environment variable`);
        console.log(`  Key: ${G_DIM}${config.apiKey.slice(0, 4)}...${config.apiKey.slice(-3)}${R}`);
      } else {
        console.log(`${G_RED}✗${R} No API key configured`);
        console.log(`  Use ${G_FG}/key add${R} to set one, or set ${G_DIM}AI_API_KEY${R}`);
      }
      break;
    }

    case "add":
    case "set": {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q: string): Promise<string> =>
        new Promise((r) => rl.question(q, (a) => r(a.trim())));

      console.log(`${G_YELLOW}Set API key for ${config.provider}:${R}`);
      const keyHints: Record<string, string> = {
        openai: "sk-", deepseek: "sk-", anthropic: "sk-ant-",
        google: "", groq: "gsk_", xai: "xai-", mistral: "",
        openrouter: "sk-or-", custom: "",
      };
      const hint = keyHints[config.provider] ?? "";
      if (hint) console.log(`${G_DIM}Hint: keys usually start with "${hint}"${R}`);
      const key = await ask("API Key: ");

      if (!key) {
        console.log(`${G_DIM}No key entered. Aborted.${R}`);
        rl.close();
        return;
      }

      await saveKey(key);
      const model = await ask(`Model [${config.model}]: `);
      if (model) {
        await saveConfig({
          provider: config.provider,
          model: model || config.model,
          baseURL: config.baseURL,
        });
      }
      console.log(`${G_GREEN}✓ Key saved${R}`);
      console.log(`${G_DIM}Restart to use the new key.${R}`);
      rl.close();
      break;
    }

    case "delete":
    case "remove": {
      const savedKey = await loadKey();
      if (!savedKey) {
        console.log(`${G_DIM}No key to delete.${R}`);
        return;
      }
      await deleteKey();
      console.log(`${G_GREEN}✓ Key deleted${R}`);
      break;
    }

    case "list": {
      const savedKey = await loadKey();
      const saved = await loadSavedConfig();
      if (savedKey && saved) {
        console.log(`${G_GREEN}Saved keys:${R}`);
        console.log(`  ${G_FG}${saved.provider}${R} — ${G_DIM}${savedKey.slice(0,4)}...${savedKey.slice(-3)}${R} (model: ${saved.model || "?"})`);
      }
      // Check env vars
      const envKeys = [
        "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY",
        "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "AI_API_KEY",
      ];
      const found = envKeys.filter((k) => process.env[k]);
      if (found.length > 0) {
        console.log(`${G_YELLOW}Environment keys:${R}`);
        for (const k of found) {
          const v = process.env[k]!;
          console.log(`  ${G_DIM}${k}${R} — ${v.slice(0,4)}...${v.slice(-3)}`);
        }
      }
      if (!savedKey && found.length === 0) {
        console.log(`${G_DIM}No keys configured.${R}`);
      }
      break;
    }

    default:
      console.log(`${G_RED}Unknown key command:${R} ${sub}`);
      console.log(`Try: ${G_FG}/key${R}, ${G_FG}/key add${R}, ${G_FG}/key delete${R}, ${G_FG}/key list${R}`);
  }
}

async function cmdModel(
  args: string[],
  config: Config,
  modelsConfig: ModelsConfig | null,
  updateConfig: (c: Partial<Config>) => void,
  liveSwitchModel?: (model: string) => Promise<boolean>,
): Promise<void> {
  const sub = args[1] || "status";

  switch (sub) {
    case "status":
    case "show":
      console.log(`${G_GREEN}Current model:${R} ${G_FG}${config.model}${R}`);
      console.log(`${G_GREEN}Provider:${R} ${G_FG}${config.provider}${R}`);
      if (modelsConfig) {
        const provider = modelsConfig.providers[config.provider];
        if (provider) {
          const modelEntry = provider.models.find((m) => m.id === config.model);
          if (modelEntry) {
            console.log(`  Context window: ${G_DIM}${(modelEntry.contextWindow / 1000).toFixed(0)}K tokens${R}`);
          }
        }
      }
      break;

    case "list": {
      const listAll = args[2] === "all";
      if (!modelsConfig) {
        console.log(`${G_RED}models.json not found${R}`);
        return;
      }

      if (listAll) {
        console.log(`${G_YELLOW}All providers and models:${R}\n`);
        for (const [pid, pdata] of Object.entries(modelsConfig.providers)) {
          const isCurrent = pid === config.provider;
          const marker = isCurrent ? ` ${G_GREEN}◀ current${R}` : "";
          console.log(`  ${G_FG}${pid}${R}${marker}`);
          for (const m of pdata.models) {
            const isActive = isCurrent && m.id === config.model;
            const active = isActive ? ` ${G_GREEN}◀ active${R}` : "";
            console.log(`    ${G_DIM}•${R} ${m.id} (${(m.contextWindow / 1000).toFixed(0)}K)${active}`);
          }
          console.log("");
        }
      } else {
        const provider = modelsConfig.providers[config.provider];
        if (!provider) {
          console.log(`${G_RED}Provider ${config.provider} not found in models.json${R}`);
          return;
        }
        console.log(`${G_YELLOW}Models for ${G_FG}${config.provider}${G_YELLOW}:${R}\n`);
        for (const m of provider.models) {
          const active = m.id === config.model ? ` ${G_GREEN}◀ active${R}` : "";
          console.log(`  ${G_DIM}•${R} ${m.id} (${(m.contextWindow / 1000).toFixed(0)}K)${active}`);
        }
      }
      break;
    }

    case "switch":
    case "set": {
      const targetModel = args[2];
      if (!targetModel) {
        console.log(`${G_RED}Usage:${R} /model switch <model-id>`);
        console.log(`Use ${G_FG}/model list${R} to see available models`);
        return;
      }

      if (!modelsConfig) {
        console.log(`${G_RED}models.json not found — cannot validate model${R}`);
        console.log(`Switching anyway...`);
        // Save blindly
        await saveConfig({
          provider: config.provider,
          model: targetModel,
          baseURL: config.baseURL,
        });
        updateConfig({ model: targetModel });
        // Try live switch, fall back to restart
        const liveOk = liveSwitchModel ? await liveSwitchModel(targetModel) : false;
        if (!liveOk) {
          console.log(`${G_DIM}Restart jawere to apply the change.${R}`);
        }
        return;
      }

      const providerEntry = modelsConfig.providers[config.provider];
      if (!providerEntry) {
        console.log(`${G_YELLOW}Provider ${config.provider} not in models.json — saving anyway${R}`);
      } else {
        const exists = providerEntry.models.some((m) => m.id === targetModel);
        if (!exists) {
          console.log(`${G_YELLOW}Warning:${R} "${targetModel}" not listed for ${config.provider} in models.json`);
          console.log(`${G_DIM}Proceeding anyway...${R}`);
        }
      }

      await saveConfig({
        provider: config.provider as SavedConfig["provider"],
        model: targetModel,
        baseURL: providerEntry?.baseURL || config.baseURL,
      });
      updateConfig({ model: targetModel });
      console.log(`${G_GREEN}✓ Model switched to ${G_FG}${targetModel}${R}`);

      // Try live switch via Pi RPC, fall back to restart
      if (liveSwitchModel) {
        const liveOk = await liveSwitchModel(targetModel);
        if (liveOk) {
          console.log(`${G_GREEN2}⟳ Applied live — no restart needed${R}`);
        } else {
          console.log(`${G_DIM}Restart jawere to apply the change.${R}`);
        }
      } else {
        console.log(`${G_DIM}Restart jawere to apply the change.${R}`);
      }
      break;
    }

    default:
      console.log(`${G_RED}Unknown model command:${R} ${sub}`);
      console.log(`Try: ${G_FG}/model${R}, ${G_FG}/model list${R}, ${G_FG}/model switch <name>${R}`);
  }
}

async function cmdProvider(
  args: string[],
  config: Config,
  modelsConfig: ModelsConfig | null,
  liveSwitchProvider?: (provider: string, model: string) => Promise<boolean>,
): Promise<void> {
  const sub = args[1] || "status";

  switch (sub) {
    case "status":
    case "show":
      console.log(`${G_GREEN}Current provider:${R} ${G_FG}${config.provider}${R}`);
      if (modelsConfig) {
        const p = modelsConfig.providers[config.provider];
        if (p) {
          console.log(`  Base URL: ${G_DIM}${p.baseURL}${R}`);
          console.log(`  Models: ${p.models.length} available`);
          const current = p.models.find((m) => m.id === config.model);
          if (current) {
            console.log(`  Active model: ${G_FG}${current.id}${R} (${(current.contextWindow / 1000).toFixed(0)}K)`);
          }
        }
      }
      break;

    case "list": {
      if (!modelsConfig) {
        console.log(`${G_RED}models.json not found${R}`);
        return;
      }
      console.log(`${G_YELLOW}Available providers:${R}\n`);
      for (const [id, pdata] of Object.entries(modelsConfig.providers)) {
        const active = id === config.provider ? ` ${G_GREEN}◀ current${R}` : "";
        console.log(`  ${G_DIM}•${R} ${G_FG}${id}${R} (${pdata.models.length} models) — ${G_DIM}${pdata.baseURL}${R}${active}`);
      }
      break;
    }

    case "switch":
    case "set": {
      const target = args[2];
      if (!target) {
        console.log(`${G_RED}Usage:${R} /provider switch <provider-id>`);
        console.log(`Use ${G_FG}/provider list${R} to see all providers`);
        return;
      }

      if (modelsConfig && !modelsConfig.providers[target]) {
        console.log(`${G_RED}Provider "${target}" not found in models.json${R}`);
        console.log(`Available: ${Object.keys(modelsConfig.providers).join(", ")}`);
        return;
      }

      const pdata = modelsConfig?.providers[target];
      const defaultModel = pdata?.models[0]?.id || "gpt-4o";
      const baseURL = pdata?.baseURL || config.baseURL;

      await saveConfig({
        provider: target as SavedConfig["provider"],
        model: defaultModel,
        baseURL,
      });
      console.log(`${G_GREEN}✓ Provider switched to ${G_FG}${target}${R} (model: ${defaultModel})`);
      console.log(`${G_YELLOW}Note:${R} You may need to set an API key with ${G_FG}/key add${R}`);

      // Try live switch via Pi RPC (Pi resolves keys from its own store)
      if (liveSwitchProvider) {
        const liveOk = await liveSwitchProvider(target, defaultModel);
        if (liveOk) {
          console.log(`${G_GREEN2}⟳ Applied live — no restart needed${R}`);
        } else {
          console.log(`${G_DIM}Restart jawere to apply the change.${R}`);
        }
      } else {
        console.log(`${G_DIM}Restart jawere to apply the change.${R}`);
      }
      break;
    }

    default:
      console.log(`${G_RED}Unknown provider command:${R} ${sub}`);
      console.log(`Try: ${G_FG}/provider${R}, ${G_FG}/provider list${R}, ${G_FG}/provider switch <id>${R}`);
  }
}

// ── Think command ────────────────────────────────────────────────────

async function cmdThink(
  args: string[],
  currentConfig: Config,
  modelsConfig: ModelsConfig | null,
  liveSwitchThink?: (level: string) => Promise<boolean>,
): Promise<void> {
  const levels = modelsConfig?.thinkingLevels ?? {
    off: { description: "No thinking — direct responses" },
    minimal: { description: "Brief reasoning before responding" },
    low: { description: "Some reasoning steps" },
    medium: { description: "Balanced reasoning" },
    high: { description: "Thorough reasoning for complex tasks" },
    xhigh: { description: "Maximum reasoning — use for critical/safety tasks" },
  };

  const sub = args[1];

  if (!sub || sub === "status" || sub === "show") {
    console.log(`${G_GREEN}Current thinking level:${R} ${G_FG}${currentConfig.thinkingLevel}${R}`);
    const desc = levels[currentConfig.thinkingLevel]?.description;
    if (desc) console.log(`  ${G_DIM}${desc}${R}`);
    console.log(`\n${G_DIM}Available levels: ${Object.keys(levels).join(', ')}${R}`);
    return;
  }

  if (sub in levels) {
    currentConfig.thinkingLevel = sub;
    console.log(`${G_GREEN}✓ Thinking level set to ${G_FG}${sub}${R}`);
    const desc = levels[sub]?.description;
    if (desc) console.log(`  ${G_DIM}${desc}${R}`);

    // Try live switch via Pi RPC
    if (liveSwitchThink) {
      const liveOk = await liveSwitchThink(sub);
      if (liveOk) {
        console.log(`${G_GREEN2}⟳ Applied live — no restart needed${R}`);
      } else {
        console.log(`${G_DIM}Restart jawere to apply the change.${R}`);
      }
    } else {
      console.log(`${G_DIM}Restart jawere to apply the change.${R}`);
    }
  } else {
    console.log(`${G_RED}Unknown level:${R} ${sub}`);
    console.log(`Valid levels: ${Object.keys(levels).join(', ')}`);
  }
}

// ── Setup wizard ────────────────────────────────────────────────────

async function setupWizard(): Promise<void> {
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

  // Load models config for better defaults
  const modelsConfig = await loadModelsConfig();

  console.log("Select AI provider:");
  const providers = modelsConfig
    ? Object.keys(modelsConfig.providers)
    : ["deepseek", "openai", "anthropic", "google", "groq", "xai", "mistral", "openrouter", "custom"];
  providers.forEach((p, i) => {
    console.log(`  ${G_GREEN2}${i + 1}.${R} ${p}`);
  });
  console.log("");

  const choice = await ask(`Choice [1]: `);
  const idx = (parseInt(choice) || 1) - 1;
  const provider = providers[Math.max(0, Math.min(idx, providers.length - 1))] || "deepseek";

  let baseURL = modelsConfig?.providers[provider]?.baseURL;
  let defaultModel = modelsConfig?.providers[provider]?.models[0]?.id || "gpt-4o";

  if (provider === "custom") {
    console.log("");
    baseURL = await ask("Base URL (e.g. https://api.openai.com/v1): ");
    if (!baseURL) {
      console.log("No URL entered. Aborting.");
      rl.close();
      return;
    }
  }

  console.log("");
  const keyHints: Record<string, string> = {
    openai: "sk-", deepseek: "sk-", anthropic: "sk-ant-",
    google: "", groq: "gsk_", xai: "xai-", mistral: "",
    openrouter: "sk-or-", custom: "",
  };
  const keyHint = keyHints[provider] ?? "";
  const hintText = keyHint ? ` (starts with ${keyHint})` : "";
  console.log(`Enter your API key${hintText}:`);
  const key = await ask("API Key: ");
  if (!key) {
    console.log("No key entered. Aborting.");
    rl.close();
    return;
  }

  // Show available models
  const models = modelsConfig?.providers[provider]?.models;
  if (models && models.length > 0) {
    console.log(`\n${G_DIM}Available models for ${provider}:${R}`);
    models.forEach((m) => {
      console.log(`  ${G_DIM}•${R} ${m.id} (${(m.contextWindow / 1000).toFixed(0)}K)`);
    });
  }
  console.log("");
  const model = await ask(`Model [${defaultModel}]: `);

  await saveKey(key);
  await saveConfig({
    provider: provider as SavedConfig["provider"],
    baseURL: baseURL || undefined,
    model: model || defaultModel,
  });

  console.log("");
  console.log(`${G_GREEN}Setup complete!${R}`);
  console.log(`  Provider : ${G_GREEN2}${provider}${R}`);
  console.log(`  Model    : ${G_GREEN2}${model || defaultModel}${R}`);
  console.log(`  Key saved: ~/.jawere/key.enc`);
  console.log("");

  rl.close();
}

// ── Quick update ────────────────────────────────────────────────────

async function quickUpdate(): Promise<void> {
  const { execSync } = await import("child_process");

  console.log(`${G_GREEN}╔══════════════════════════════════════════╗${R}`);
  console.log(`${G_GREEN}║   jawere — Quick Update                  ║${R}`);
  console.log(`${G_GREEN}╚══════════════════════════════════════════╝${R}\n`);

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

  try {
    const ver = execSync("jawere --version 2>/dev/null || npx jawere --version 2>/dev/null", {
      encoding: "utf-8", stdio: "pipe",
    }).trim();
    console.log(`\n${G_GREEN}✓ Updated to ${ver || "latest"}${R}`);
  } catch {
    console.log(`\n${G_GREEN}✓ Update complete!${R}`);
  }
}

// ── Extension UI handler ──────────────────────────────────────────

/**
 * Create a handler for Pi extension UI requests.
 * Uses readline for simple terminal I/O — the TUI is not active during agent runs.
 */
function createExtensionUIHandler(): ExtensionUIHandler {
  const color = (text: string, c: string) => `${c}${text}${R}`;

  /** Prompt the user with a single-line question, return trimmed answer or undefined */
  function ask(question: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      rl.question(question, (answer: string) => {
        rl.close();
        resolve(answer.trim() || undefined);
      });
    });
  }

  return async (req: ExtensionUIRequest): Promise<ExtensionUIResponse | null> => {
    switch (req.method) {
      // ── Dialog methods: require user response ──

      case "select": {
        const options = req.options ?? [];
        if (options.length === 0) {
          return { type: "extension_ui_response", id: req.id, cancelled: true };
        }
        process.stderr.write(`\n${color(req.title ?? "Select", G_MAGENTA)}\n`);
        options.forEach((opt, i) => {
          process.stderr.write(`  ${G_GREEN}${i + 1}${R}. ${G_FG}${opt}${R}\n`);
        });
        const answer = await ask(`${G_DIM}Choose [1-${options.length}]:${R} `);
        const idx = answer ? parseInt(answer, 10) - 1 : -1;
        if (idx >= 0 && idx < options.length) {
          return { type: "extension_ui_response", id: req.id, value: options[idx] };
        }
        return { type: "extension_ui_response", id: req.id, cancelled: true };
      }

      case "confirm": {
        const msg = req.message ? `${req.title}: ${req.message}` : (req.title ?? "Confirm?");
        process.stderr.write(`\n${color(msg, G_MAGENTA)}\n`);
        const answer = await ask(`${G_DIM}[y/N]:${R} `);
        const confirmed = answer?.toLowerCase() === "y" || answer?.toLowerCase() === "yes";
        return { type: "extension_ui_response", id: req.id, confirmed };
      }

      case "input": {
        const prompt = req.placeholder
          ? `${req.title ?? "Input"} ${G_DIM}(${req.placeholder})${R}: `
          : `${req.title ?? "Input"}: `;
        process.stderr.write(`\n`);
        const answer = await ask(prompt);
        if (answer !== undefined) {
          return { type: "extension_ui_response", id: req.id, value: answer };
        }
        return { type: "extension_ui_response", id: req.id, cancelled: true };
      }

      case "editor": {
        // Simplified: single-line input (full multi-line editor would need TUI)
        if (req.prefill) {
          process.stderr.write(`\n${color(req.title ?? "Editor", G_MAGENTA)} ${G_DIM}[prefill: ${req.prefill.slice(0, 60)}]${R}\n`);
        } else {
          process.stderr.write(`\n${color(req.title ?? "Editor", G_MAGENTA)}\n`);
        }
        const answer = await ask(`${G_DIM}Text:${R} `);
        if (answer !== undefined) {
          return { type: "extension_ui_response", id: req.id, value: answer };
        }
        return { type: "extension_ui_response", id: req.id, cancelled: true };
      }

      // ── Fire-and-forget: log and return null (no response needed) ──

      case "notify": {
        const nType = req.notifyType ?? "info";
        const c = nType === "error" ? G_RED : nType === "warning" ? G_YELLOW : G_MAGENTA;
        process.stderr.write(`\n${c}[${nType}]${R} ${req.message ?? ""}\n`);
        return null;
      }

      case "setStatus":
        process.stderr.write(`\n${G_DIM}[status: ${req.statusKey}]${R} ${req.statusText ?? "(cleared)"}\n`);
        return null;

      case "setWidget": {
        if (req.widgetLines && req.widgetLines.length > 0) {
          process.stderr.write(`\n${G_DIM}[widget: ${req.widgetKey}]${R}\n`);
          for (const wl of req.widgetLines) {
            process.stderr.write(`  ${G_DIM}${wl}${R}\n`);
          }
        }
        return null;
      }

      case "setTitle":
        process.stderr.write(`\n${G_DIM}[title: ${req.title}]${R}\n`);
        return null;

      case "set_editor_text":
        // We don't have an active editor during agent runs — log it
        process.stderr.write(`\n${G_DIM}[editor text set: ${(req.text ?? "").slice(0, 80)}]${R}\n`);
        return null;

      default:
        return { type: "extension_ui_response", id: req.id, cancelled: true };
    }
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const setupMode = process.argv.includes("--setup");
  const updateMode = process.argv.includes("--update");

  if (setupMode) {
    await setupWizard();
    console.log("Setup complete. Run again without --setup to start.");
    process.exit(0);
  }

  if (updateMode) {
    await quickUpdate();
    process.exit(0);
  }

  const config = await loadConfig();
  const modelsConfig = await loadModelsConfig();

  // Apply models.json defaults if config has no saved config
  if (modelsConfig && !config.apiKey) {
    // Check if any env key matches a provider in models.json
    for (const [pid, pdata] of Object.entries(modelsConfig.providers)) {
      if (process.env[pdata.envKey]) {
        process.env.AI_API_KEY = process.env[pdata.envKey];
        break;
      }
    }
  }

  if (!config.apiKey) {
    // Re-load config after potential env fix
    const reloaded = await loadConfig();
    if (!reloaded.apiKey) {
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
  }

  console.clear();
  printBanner(config);

  // Phase 1: Background scan
  process.stderr.write(`${G_DIM}Scanning codebase…${R}`);
  try {
    const scanResult = await runScanner(config.workDir);
    if (scanResult.cached) {
      process.stderr.write(` ${G_DIM}(${scanResult.fileCount} files cached)${R}`);
      if (scanResult.changedCount && scanResult.changedCount > 0) {
        process.stderr.write(` ${G_YELLOW}· ${scanResult.changedCount} changed${R}`);
      }
      process.stderr.write(`\n`);
    } else {
      process.stderr.write(` ${G_GREEN2}done${R} ${G_DIM}· ${scanResult.fileCount} files indexed${R}`);
      if (scanResult.changedCount && scanResult.changedCount > 0) {
        process.stderr.write(` ${G_YELLOW}· ${scanResult.changedCount} changed${R}`);
      }
      process.stderr.write(`\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(` ${G_DIM}[skipped: ${msg}]${R}\n`);
  }

  // Phase 2: Setup .codebase directory
  try {
    const codebaseDir = resolve(config.workDir, ".codebase");
    await mkdir(codebaseDir, { recursive: true });
  } catch { /* best effort */ }

  // Phase 3: Check for AGENT_DOCS.md and print tip
  const agentDocsPath = resolve(config.workDir, ".codebase", "AGENT_DOCS.md");
  if (existsSync(agentDocsPath)) {
    process.stderr.write(`${G_DIM}Agent self-docs: .codebase/AGENT_DOCS.md${R}\n`);
  }

  // Phase 4: Detect Pi binary (stderr — async, parallel with file list)
  let piInfo: PiInfo | null = null;
  const piDetectPromise = (async () => {
    try {
      piInfo = await resolvePiBinary();
    } catch { /* handled below */ }
    if (piInfo) {
      process.stderr.write(
        `${G_GREEN}●${R} Pi ${G_GREEN2}v${piInfo.version}${R} ${G_DIM}at ${piInfo.path}${R} ` +
        `${piInfo.rpcSupported ? `${G_GREEN2}RPC ✓${R}` : `${G_RED}RPC ✗${R}`}\n`,
      );
    } else {
      process.stderr.write(`${G_YELLOW}⚠ Pi not found on PATH${R}\n`);
    }
  })();

  // Load file list for @-tag autocomplete
  const fileList = await loadFileList(config.workDir);

  // Wait for Pi detection to finish
  await piDetectPromise;

  // Fetch Pi commands and merge with jawere built-ins
  const builtInCommands: SlashCommand[] = [
    { name: "help", description: "Show help" },
    { name: "key", description: "Manage API keys", argumentHint: "add|delete|list" },
    { name: "model", description: "Switch or list models", argumentHint: "list|switch <model>" },
    { name: "provider", description: "Switch or list providers", argumentHint: "list|switch <provider>" },
    { name: "think", description: "Set thinking level", argumentHint: "off|minimal|low|medium|high|xhigh" },
    { name: "setup", description: "Run setup wizard" },
    { name: "clear", description: "Clear the screen" },
    { name: "config", description: "Show current configuration" },
    { name: "exit", description: "Exit jawere" },
    { name: "quit", description: "Exit jawere" },
  ];

  let piCommands: SlashCommand[] = [];
  if ((piInfo as PiInfo | null)?.rpcSupported) {
    try {
      // Create a temp agent just to fetch commands
      const probeAgent = new PiRpcAgent(config);
      piCommands = (await probeAgent.getCommands()).map((cmd) => ({
        name: cmd.name,
        description: cmd.description ?? `Pi ${cmd.source}`,
      }));
      probeAgent.stop();
    } catch {
      // Pi commands unavailable — use built-ins only
    }
  }

  const allCommands = [...builtInCommands, ...piCommands];

  const { prompt, enableBracketedPaste, disableBracketedPaste } = createPrompt({
    getFiles: () => fileList,
    commands: allCommands,
    basePath: config.workDir,
  });
  enableBracketedPaste();

  // Mutable config that can be updated by slash commands
  let currentConfig = { ...config };
  // Reload config after key changes
  const reloadConfig = async (): Promise<Config> => {
    // bust cached config
    const fresh = await loadConfig();
    currentConfig = { ...fresh };
    return fresh;
  };

  let runningAbort: AbortController | null = null;
  let agent: PiRpcAgent | null = null;
  const displayState: DisplayState = {
    spinner: createSpinner(),
    pendingToolArgs: new Map(),
    toolCount: 0,
    streamedText: [],
  };

  // ── Live switch helpers (use Pi RPC without restart) ────────────

  const tryLiveSwitchModel = async (model: string): Promise<boolean> => {
    if (!agent) return false;
    try {
      await agent.setModel(currentConfig.provider, model);
      return true;
    } catch {
      // Live switch failed — caller should restart
      return false;
    }
  };

  const tryLiveSwitchProvider = async (provider: string, model: string): Promise<boolean> => {
    if (!agent) return false;
    try {
      await agent.setModel(provider, model);
      // Update currentConfig to reflect the live change
      currentConfig.provider = provider as SavedProvider;
      currentConfig.model = model;
      // Reload config so persistent storage stays in sync
      await saveConfig({
        provider: provider as SavedProvider,
        model,
        baseURL: currentConfig.baseURL,
      });
      return true;
    } catch {
      return false;
    }
  };

  const tryLiveSwitchThink = async (level: string): Promise<boolean> => {
    if (!agent) return false;
    try {
      await agent.setThinkingLevel(level);
      return true;
    } catch {
      return false;
    }
  };

  let sigintCount = 0;
  const sigintHandler = () => {
    sigintCount++;
    if (sigintCount >= 2) {
      agent?.abort();
      process.stderr.write("\n");
      process.exit(1);
    }
    if (runningAbort) {
      runningAbort.abort();
      agent?.abort();
      process.stderr.write("\n");
    }
    setTimeout(() => { sigintCount = 0; }, 1000);
  };
  process.on("SIGINT", sigintHandler);

  // ── System prompt injection ────────────────────────────────────
  // Pi uses its own system prompt. We inject jawere's context by
  // prepending it to the first user message of each session.
  let isFirstPrompt = true;

  while (true) {
    const rawInput = await prompt();
    if (!rawInput) continue;

    // Prepend jawere's system prompt on the first message only
    let input = rawInput;
    if (isFirstPrompt) {
      const systemContext = [
        "<system-context>",
        "The following are your working instructions. Follow them for this entire session.",
        "",
        buildSystemPrompt(),
        "</system-context>",
      ].join("\n");
      input = systemContext + "\n\n---\n\n" + rawInput;
      isFirstPrompt = false;
    }

    if (rawInput.startsWith("/")) {
      const parts = input.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();

      switch (cmd) {
        case "help":
          printHelp();
          break;

        case "key":
          await cmdKey(parts, currentConfig);
          break;

        case "model":
          await cmdModel(parts, currentConfig, modelsConfig, async (update) => {
            Object.assign(currentConfig, update);
          }, tryLiveSwitchModel);
          break;

        case "provider":
          await cmdProvider(parts, currentConfig, modelsConfig, tryLiveSwitchProvider);
          break;

        case "think":
          await cmdThink(parts, currentConfig, modelsConfig, tryLiveSwitchThink);
          break;

        case "setup":
          await setupWizard();
          console.log(`${G_YELLOW}Restart jawere to use the new configuration.${R}`);
          break;

        case "clear":
          console.clear();
          printBanner(currentConfig);
          break;

        case "config": {
          console.log(`${G_YELLOW}Current configuration:${R}`);
          console.log(`  Provider: ${G_FG}${currentConfig.provider}${R}`);
          console.log(`  Model: ${G_FG}${currentConfig.model}${R}`);
          console.log(`  Thinking: ${G_FG}${currentConfig.thinkingLevel}${R}`);
          console.log(`  Base URL: ${G_DIM}${currentConfig.baseURL}${R}`);
          console.log(`  Work Dir: ${G_DIM}${currentConfig.workDir}${R}`);
          console.log(`  Key from: ${currentConfig.keyFromFile ? "encrypted file" : "env variable"}`);
          console.log(`  Dev mode: ${currentConfig.isDev ? "ON" : "OFF"}`);
          break;
        }

        case "exit":
        case "quit":
          agent?.stop();
          console.log("Goodbye!");
          disableBracketedPaste();
          process.exit(0);

        default:
          console.log(`${G_RED}Unknown command:${R} /${cmd}`);
          console.log(`Type ${G_FG}/help${R} for available commands.`);
      }
      continue;
    }

    try {
      runningAbort = new AbortController();

      // (Re)create agent if needed (lazy init on first prompt or after model switch)
      if (!agent) {
        agent = new PiRpcAgent(currentConfig);
        agent.subscribe(createDisplaySubscriber(displayState));
        agent.setExtensionUIHandler(createExtensionUIHandler());
      }

      await agent.prompt(input, runningAbort.signal);
      await agent.waitForIdle();
      runningAbort = null;


    } catch (err: unknown) {
      runningAbort = null;
      agent = null;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n${G_RED}Error:${R} ${msg}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
