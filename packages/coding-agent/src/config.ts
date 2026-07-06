import { loadKey, hasKey, loadSavedConfig, type SavedConfig } from './crypto.js';

export interface Config {
  /** API base URL */
  baseURL: string;
  /** API key (loaded from encrypted storage or env var) */
  apiKey: string;
  /** Model name */
  model: string;
  /** AI provider */
  provider: 'deepseek' | 'openai' | 'custom';
  /** Working directory */
  workDir: string;
  /** Whether the key came from encrypted storage */
  keyFromFile: boolean;
  /** Whether running in dev mode */
  isDev: boolean;
}

const PROVIDER_DEFAULTS: Record<string, { baseURL: string; model: string }> = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
  openai: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
  custom: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
};

function isDevMode(): boolean {
  // Explicit env var always wins
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.NODE_ENV === 'development') return true;

  const main = process.argv[1] || '';

  // Running from node_modules (global install or npx) = prod
  if (main.includes('node_modules')) return false;
  // Running compiled dist via npm binary = prod
  if (main.endsWith('bin/jawere.js')) return false;
  if (main.includes('/dist/')) return false;

  // Running via tsx (src/*.ts) = dev
  if (main.endsWith('.ts') || main.includes('/src/')) return true;

  // Default to dev (safer for local dev)
  return true;
}

let cachedConfig: Config | null = null;

export async function loadConfig(): Promise<Config> {
  if (cachedConfig) return cachedConfig;

  // Try encrypted file first, then env var
  let apiKey = '';
  let keyFromFile = false;

  const savedKey = await loadKey();
  if (savedKey) {
    apiKey = savedKey;
    keyFromFile = true;
  } else if (process.env.DEEPSEEK_API_KEY) {
    apiKey = process.env.DEEPSEEK_API_KEY;
  } else if (process.env.OPENAI_API_KEY) {
    apiKey = process.env.OPENAI_API_KEY;
  } else if (process.env.AI_API_KEY) {
    apiKey = process.env.AI_API_KEY;
  }

  // Load saved provider/model config (from --setup)
  let savedConfig: SavedConfig | null = null;
  try {
    savedConfig = await loadSavedConfig();
  } catch { /* ignore */ }

  // Determine provider: saved config > env var > default
  const provider = (process.env.AI_PROVIDER as Config['provider'])
    || savedConfig?.provider
    || 'deepseek';

  const defaults = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.deepseek;

  // baseURL: env var > saved config > provider default
  const baseURL = process.env.AI_BASE_URL
    || savedConfig?.baseURL
    || defaults.baseURL;

  // model: env var > saved config > provider default
  const model = process.env.AI_MODEL
    || savedConfig?.model
    || defaults.model;

  const isDev = isDevMode();

  cachedConfig = {
    baseURL,
    apiKey,
    model,
    provider,
    workDir: process.env.WORK_DIR || process.cwd(),
    keyFromFile,
    isDev,
  };

  return cachedConfig;
}

/** Check if an API key is configured */
export async function hasApiKey(): Promise<boolean> {
  if (process.env.DEEPSEEK_API_KEY) return true;
  if (process.env.OPENAI_API_KEY) return true;
  if (process.env.AI_API_KEY) return true;
  return hasKey();
}
