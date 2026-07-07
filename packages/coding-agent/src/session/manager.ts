// @jawere/coding-agent — SessionManager: CRUD, listing, forking for JSONL sessions

import { mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import type {
  JsonlSessionMetadata,
  SessionMetadata,
  SessionTreeEntry,
} from "./types.js";
import { Session } from "./session.js";
import { JsonlSessionStorage, loadJsonlSessionMetadata, headerToMetadata } from "./jsonl-storage.js";
import { uuidv7 } from "./uuid.js";

// ── Helpers ──────────────────────────────────────────────────────────

function encodeCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function createSessionId(): string {
  return uuidv7();
}

function formatTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── SessionManager ───────────────────────────────────────────────────

export class SessionManager {
  private sessionsRoot: string;
  private workDir: string;

  constructor(options: { sessionsRoot: string; workDir: string }) {
    this.sessionsRoot = options.sessionsRoot;
    this.workDir = options.workDir;
  }

  private get cwd(): string {
    return this.workDir;
  }

  private getSessionDir(): string {
    return join(this.sessionsRoot, encodeCwd(this.cwd));
  }

  private sessionFilePath(sessionId: string, createdAt: string): string {
    return join(this.getSessionDir(), `${createdAt}_${sessionId}.jsonl`);
  }

  // ── Create ──────────────────────────────────────────────────────

  async create(options?: {
    sessionId?: string;
    parentSessionPath?: string;
  }): Promise<Session<JsonlSessionMetadata>> {
    const id = options?.sessionId ?? createSessionId();
    const createdAt = formatTimestamp();
    const dir = this.getSessionDir();
    await mkdir(dir, { recursive: true });
    const filePath = this.sessionFilePath(id, createdAt);
    const storage = await JsonlSessionStorage.create(filePath, {
      cwd: this.cwd,
      sessionId: id,
      parentSessionPath: options?.parentSessionPath,
    });
    return new Session(storage);
  }

  // ── Open ────────────────────────────────────────────────────────

  async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
    if (!existsSync(metadata.path)) {
      throw new Error(`Session file not found: ${metadata.path}`);
    }
    const storage = await JsonlSessionStorage.open(metadata.path);
    return new Session(storage);
  }

  // ── List ────────────────────────────────────────────────────────

  async list(options?: { cwd?: string; limit?: number }): Promise<JsonlSessionMetadata[]> {
    const dir = options?.cwd
      ? join(this.sessionsRoot, encodeCwd(options.cwd))
      : await this.listSessionDirs();
    const maxResults = options?.limit ?? 50;

    const sessions: JsonlSessionMetadata[] = [];

    if (typeof dir === "string") {
      // Single directory
      if (!existsSync(dir)) return [];
      try {
        const files = await readdir(dir, { withFileTypes: true });
        for (const f of files) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          try {
            sessions.push(await loadJsonlSessionMetadata(join(dir, f.name)));
          } catch { /* skip invalid */ }
        }
      } catch { /* skip */ }
    } else {
      // Multiple directories
      for (const d of dir) {
        if (sessions.length >= maxResults) break;
        if (!existsSync(d)) continue;
        try {
          const files = await readdir(d, { withFileTypes: true });
          for (const f of files) {
            if (sessions.length >= maxResults) break;
            if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
            try {
              sessions.push(await loadJsonlSessionMetadata(join(d, f.name)));
            } catch { /* skip invalid */ }
          }
        } catch { /* skip */ }
      }
    }

    // Sort newest first
    sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return sessions.slice(0, maxResults);
  }

  // ── Delete ──────────────────────────────────────────────────────

  async delete(metadata: JsonlSessionMetadata): Promise<void> {
    await rm(metadata.path, { force: true });
  }

  // ── Fork ────────────────────────────────────────────────────────

  async fork(
    sourceMetadata: JsonlSessionMetadata,
    options?: {
      entryId?: string;
      position?: "before" | "at";
      sessionId?: string;
    },
  ): Promise<Session<JsonlSessionMetadata>> {
    const source = await this.open(sourceMetadata);
    const forkedEntries = await getEntriesToFork(
      source.getStorage(),
      { entryId: options?.entryId, position: options?.position },
    );

    const id = options?.sessionId ?? createSessionId();
    const createdAt = formatTimestamp();
    const dir = this.getSessionDir();
    await mkdir(dir, { recursive: true });

    const storage = await JsonlSessionStorage.create(
      this.sessionFilePath(id, createdAt),
      {
        cwd: this.cwd,
        sessionId: id,
        parentSessionPath: sourceMetadata.path,
      },
    );

    for (const entry of forkedEntries) {
      await storage.appendEntry(entry);
    }

    return new Session(storage);
  }

  // ── Internals ───────────────────────────────────────────────────

  private async listSessionDirs(): Promise<string[]> {
    if (!existsSync(this.sessionsRoot)) return [];
    try {
      const entries = await readdir(this.sessionsRoot, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => join(this.sessionsRoot, e.name));
    } catch {
      return [];
    }
  }
}

// ── Fork helper ──────────────────────────────────────────────────────

export async function getEntriesToFork(
  storage: { getEntries: () => Promise<SessionTreeEntry[]>; getEntry: (id: string) => Promise<SessionTreeEntry | undefined>; getPathToRoot: (leafId: string | null) => Promise<SessionTreeEntry[]> },
  options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
  if (!options.entryId) return storage.getEntries();

  const target = await storage.getEntry(options.entryId);
  if (!target) {
    throw new Error(`Entry ${options.entryId} not found`);
  }

  let effectiveLeafId: string | null;
  if ((options.position ?? "before") === "at") {
    effectiveLeafId = target.id;
  } else {
    if (target.type !== "message" || (target as any).message?.role !== "user") {
      throw new Error(`Entry ${options.entryId} is not a user message`);
    }
    effectiveLeafId = target.parentId;
  }

  return storage.getPathToRoot(effectiveLeafId);
}
