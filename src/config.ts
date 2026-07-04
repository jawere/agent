import { loadKey, hasKey } from './crypto.js';

// Convex deployments
const CONVEX_DEV = 'https://dazzling-jackal-33.convex.cloud';
const CONVEX_PROD = 'https://friendly-pigeon-624.convex.cloud';

export interface Config {
  /** DeepSeek API base URL */
  baseURL: string;
  /** API key (loaded from encrypted storage or env var) */
  apiKey: string;
  /** Model name */
  model: string;
  /** Working directory */
  workDir: string;
  /** Convex deployment URL */
  convexUrl: string;
  /** Whether the key came from encrypted storage */
  keyFromFile: boolean;
  /** Whether running in dev mode */
  isDev: boolean;
}

function isDevMode(): boolean {
  // Explicit env var always wins
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.NODE_ENV === 'development') return true;
  // Heuristic: running via tsx (src/*.ts) = dev; compiled dist/*.js = prod
  const main = process.argv[1] || '';
  if (main.endsWith('.ts') || main.includes('/src/')) return true;
  // Heuristic: node_modules/.bin or global install = prod
  if (main.includes('/node_modules/') || main.includes('/.local/lib/node_modules/')) return false;
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
  }

  const isDev = isDevMode();

  cachedConfig = {
    baseURL: 'https://api.deepseek.com/v1',
    apiKey,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
    workDir: process.env.WORK_DIR || process.cwd(),
    convexUrl: process.env.CONVEX_URL || (isDev ? CONVEX_DEV : CONVEX_PROD),
    keyFromFile,
    isDev,
  };

  return cachedConfig;
}

/** Check if an API key is configured */
export async function hasApiKey(): Promise<boolean> {
  if (process.env.DEEPSEEK_API_KEY) return true;
  return hasKey();
}
