// @jawere/ai — Dynamic API key resolution
// Supports: env vars ($VAR), command execution (!cmd), credential stores

import { execSync } from "node:child_process";

export type KeySource = string; // e.g. "$OPENAI_API_KEY", "!pass show api/token", "keychain:my-app"

export interface ResolvedKey {
  value: string;
  source: KeySource;
  cached: boolean;
}

export interface KeyResolverOptions {
  /** Time-to-live for cached keys in ms (default: 5 minutes) */
  cacheTtlMs?: number;
  /** Timeout for command execution in ms (default: 5000) */
  commandTimeoutMs?: number;
  /** Shell to use for command execution (default: /bin/sh) */
  shell?: string;
}

interface CacheEntry {
  value: string;
  expiresAt: number;
}

export class KeyResolver {
  private cache: Map<KeySource, CacheEntry> = new Map();
  private options: Required<KeyResolverOptions>;

  constructor(options: KeyResolverOptions = {}) {
    this.options = {
      cacheTtlMs: options.cacheTtlMs ?? 5 * 60 * 1000,
      commandTimeoutMs: options.commandTimeoutMs ?? 5000,
      shell: options.shell ?? "/bin/sh",
    };
  }

  /**
   * Resolve a key source to its actual value.
   *
   * Formats:
   *   "$VAR_NAME"           — read from process.env
   *   "$VAR_NAME|default"   — env var with fallback
   *   "!command"            — execute shell command, use stdout (trimmed)
   *   "keychain:name"       — read from OS keychain (not yet implemented, throws)
   *   "raw-value"           — literal value (no prefix)
   */
  async resolve(source: KeySource): Promise<ResolvedKey> {
    // Check cache
    const cached = this.cache.get(source);
    if (cached && cached.expiresAt > Date.now()) {
      return { value: cached.value, source, cached: true };
    }

    let value: string | undefined;

    if (source.startsWith("!")) {
      value = await this.resolveCommand(source.slice(1));
    } else if (source.startsWith("$")) {
      value = this.resolveEnvVar(source.slice(1));
    } else if (source.startsWith("keychain:")) {
      value = await this.resolveKeychain(source.slice("keychain:".length));
    } else if (source.startsWith("file:")) {
      value = await this.resolveFile(source.slice("file:".length));
    } else {
      // Raw value
      value = source;
    }

    if (value === undefined || value === "") {
      throw new Error(`Failed to resolve key source: ${source}`);
    }

    // Cache
    this.cache.set(source, { value, expiresAt: Date.now() + this.options.cacheTtlMs });

    return { value, source, cached: false };
  }

  /** Resolve multiple sources, returning the first successful one */
  async resolveFirst(sources: KeySource[]): Promise<ResolvedKey> {
    const errors: string[] = [];
    for (const source of sources) {
      try {
        return await this.resolve(source);
      } catch (err: unknown) {
        errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`All key sources failed:\n${errors.join("\n")}`);
  }

  /** Clear the cache */
  clearCache(): void {
    this.cache.clear();
  }

  /** Remove a specific key from cache */
  invalidate(source: KeySource): void {
    this.cache.delete(source);
  }

  // ── Private resolvers ───────────────────────────────────────────

  private resolveEnvVar(spec: string): string | undefined {
    const [name, fallback] = spec.split("|", 2);
    const value = process.env[name.trim()];
    if (value !== undefined && value !== "") return value;
    if (fallback !== undefined) return fallback.trim();
    return undefined;
  }

  private async resolveCommand(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      try {
        const result = execSync(command, {
          encoding: "utf-8",
          timeout: this.options.commandTimeoutMs,
          shell: this.options.shell,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const trimmed = result.trim();
        if (!trimmed) {
          reject(new Error(`Command produced no output: ${command}`));
          return;
        }
        // Take only the first line
        resolve(trimmed.split("\n")[0].trim());
      } catch (err: unknown) {
        reject(new Error(
          `Command failed: ${command} — ${err instanceof Error ? err.message : String(err)}`,
        ));
      }
    });
  }

  private async resolveKeychain(name: string): Promise<string> {
    try {
      // Try macOS keychain
      const result = execSync(
        `security find-generic-password -w -s "${name}" 2>/dev/null`,
        { encoding: "utf-8", timeout: this.options.commandTimeoutMs, stdio: ["ignore", "pipe", "pipe"] },
      );
      const trimmed = result.trim();
      if (trimmed) return trimmed;
    } catch {
      // Fall through
    }

    try {
      // Try secret-tool (Linux)
      const result = execSync(
        `secret-tool lookup name "${name}" 2>/dev/null`,
        { encoding: "utf-8", timeout: this.options.commandTimeoutMs, stdio: ["ignore", "pipe", "pipe"] },
      );
      const trimmed = result.trim();
      if (trimmed) return trimmed;
    } catch {
      // Fall through
    }

    throw new Error(`Keychain entry not found: ${name}`);
  }

  private async resolveFile(path: string): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    try {
      const content = await readFile(path, "utf-8");
      return content.trim().split("\n")[0].trim();
    } catch (err: unknown) {
      throw new Error(
        `File read failed: ${path} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Default singleton */
let defaultResolver: KeyResolver | null = null;

export function getDefaultKeyResolver(): KeyResolver {
  if (!defaultResolver) {
    defaultResolver = new KeyResolver();
  }
  return defaultResolver;
}
