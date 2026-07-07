// @jawere/coding-agent — JSONL session storage (pi-compatible format v3)

import { readFile, appendFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import type {
  JsonlSessionMetadata,
  SessionHeader,
  SessionStorage,
  SessionTreeEntry,
  LeafEntry,
  LabelEntry,
} from "./types.js";
import { SessionError } from "./types.js";
import { uuidv7, generateEntryId } from "./uuid.js";

// ── Helpers ──────────────────────────────────────────────────────────

function updateLabelCache(labelsById: Map<string, string>, entry: SessionTreeEntry): void {
  if (entry.type !== "label") return;
  const e = entry as LabelEntry;
  const label = e.label?.trim();
  if (label) {
    labelsById.set(e.targetId, label);
  } else {
    labelsById.delete(e.targetId);
  }
}

function buildLabelsById(entries: SessionTreeEntry[]): Map<string, string> {
  const labelsById = new Map<string, string>();
  for (const entry of entries) updateLabelCache(labelsById, entry);
  return labelsById;
}

function leafIdAfterEntry(entry: SessionTreeEntry): string | null {
  return entry.type === "leaf" ? (entry as LeafEntry).targetId : entry.id;
}

// ── Parse helpers ────────────────────────────────────────────────────

function parseHeaderLine(line: string, filePath: string): SessionHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new SessionError("invalid_session", `Invalid JSONL session ${filePath}: first line is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SessionError("invalid_session", `Invalid JSONL session ${filePath}: first line is not an object`);
  }
  const h = parsed as Record<string, unknown>;
  if (h.type !== "session") throw new SessionError("invalid_session", `${filePath}: missing type=session`);
  if (h.version !== 3) throw new SessionError("invalid_session", `${filePath}: unsupported version (want 3)`);
  if (typeof h.id !== "string" || !h.id) throw new SessionError("invalid_session", `${filePath}: missing id`);
  if (typeof h.timestamp !== "string" || !h.timestamp) throw new SessionError("invalid_session", `${filePath}: missing timestamp`);
  if (typeof h.cwd !== "string" || !h.cwd) throw new SessionError("invalid_session", `${filePath}: missing cwd`);
  return {
    type: "session",
    version: 3,
    id: h.id,
    timestamp: h.timestamp,
    cwd: h.cwd,
    parentSession: typeof h.parentSession === "string" ? h.parentSession : undefined,
  };
}

function parseEntryLine(line: string, filePath: string, lineNumber: number): SessionTreeEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new SessionError("invalid_entry", `${filePath}:${lineNumber} — not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new SessionError("invalid_entry", `${filePath}:${lineNumber} — not an object`);
  }
  const e = parsed as Record<string, unknown>;
  if (typeof e.type !== "string") throw new SessionError("invalid_entry", `${filePath}:${lineNumber} — missing type`);
  if (typeof e.id !== "string" || !e.id) throw new SessionError("invalid_entry", `${filePath}:${lineNumber} — missing id`);
  if (e.parentId !== null && typeof e.parentId !== "string") throw new SessionError("invalid_entry", `${filePath}:${lineNumber} — invalid parentId`);
  if (typeof e.timestamp !== "string" || !e.timestamp) throw new SessionError("invalid_entry", `${filePath}:${lineNumber} — missing timestamp`);
  return e as unknown as SessionTreeEntry;
}

// ── Load ─────────────────────────────────────────────────────────────

async function loadJsonlStorage(
  filePath: string,
): Promise<{ header: SessionHeader; entries: SessionTreeEntry[]; leafId: string | null }> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length === 0) throw new SessionError("invalid_session", `${filePath}: empty file`);

  const header = parseHeaderLine(lines[0]!, filePath);
  const entries: SessionTreeEntry[] = [];
  let leafId: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const entry = parseEntryLine(lines[i]!, filePath, i + 1);
    entries.push(entry);
    leafId = leafIdAfterEntry(entry);
  }
  return { header, entries, leafId };
}

// ── Metadata load (header only, fast) ────────────────────────────────

export async function loadJsonlSessionMetadata(filePath: string): Promise<JsonlSessionMetadata> {
  const content = await readFile(filePath, "utf-8");
  const firstLine = content.split("\n")[0]?.trim();
  if (!firstLine) throw new SessionError("invalid_session", `${filePath}: empty file`);
  const header = parseHeaderLine(firstLine, filePath);
  return {
    id: header.id,
    createdAt: header.timestamp,
    cwd: header.cwd,
    path: filePath,
    parentSessionPath: header.parentSession,
  };
}

export function headerToMetadata(header: SessionHeader, path: string): JsonlSessionMetadata {
  return {
    id: header.id,
    createdAt: header.timestamp,
    cwd: header.cwd,
    path,
    parentSessionPath: header.parentSession,
  };
}

// ── JSONL storage class ──────────────────────────────────────────────

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
  private filePath: string;
  private metadata: JsonlSessionMetadata;
  private entries: SessionTreeEntry[];
  private byId: Map<string, SessionTreeEntry>;
  private labelsById: Map<string, string>;
  private currentLeafId: string | null;

  private constructor(
    filePath: string,
    header: SessionHeader,
    entries: SessionTreeEntry[],
    leafId: string | null,
  ) {
    this.filePath = filePath;
    this.metadata = headerToMetadata(header, filePath);
    this.entries = entries;
    this.byId = new Map(entries.map((e) => [e.id, e]));
    this.labelsById = buildLabelsById(entries);
    this.currentLeafId = leafId;
  }

  // ── Factory methods ──────────────────────────────────────────────

  static async open(filePath: string): Promise<JsonlSessionStorage> {
    const loaded = await loadJsonlStorage(filePath);
    return new JsonlSessionStorage(filePath, loaded.header, loaded.entries, loaded.leafId);
  }

  static async create(
    filePath: string,
    options: { cwd: string; sessionId: string; parentSessionPath?: string },
  ): Promise<JsonlSessionStorage> {
    const header: SessionHeader = {
      type: "session",
      version: 3,
      id: options.sessionId,
      timestamp: new Date().toISOString(),
      cwd: options.cwd,
      parentSession: options.parentSessionPath,
    };
    await writeFile(filePath, JSON.stringify(header) + "\n", "utf-8");
    return new JsonlSessionStorage(filePath, header, [], null);
  }

  // ── Storage interface ────────────────────────────────────────────

  async getMetadata(): Promise<JsonlSessionMetadata> {
    return this.metadata;
  }

  async getLeafId(): Promise<string | null> {
    if (this.currentLeafId !== null && !this.byId.has(this.currentLeafId)) {
      throw new SessionError("invalid_session", `Entry ${this.currentLeafId} not found`);
    }
    return this.currentLeafId;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !this.byId.has(leafId)) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    const entry: LeafEntry = {
      type: "leaf",
      id: generateEntryId(this.byId),
      parentId: this.currentLeafId,
      timestamp: new Date().toISOString(),
      targetId: leafId,
    };
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.currentLeafId = leafId;
  }

  async createEntryId(): Promise<string> {
    return generateEntryId(this.byId);
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    await appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    updateLabelCache(this.labelsById, entry);
    this.currentLeafId = leafIdAfterEntry(entry);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.byId.get(id);
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    return this.entries.filter(
      (e): e is Extract<SessionTreeEntry, { type: TType }> => e.type === type,
    );
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.labelsById.get(id);
  }

  async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const path: SessionTreeEntry[] = [];
    let current = this.byId.get(leafId);
    if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (!current.parentId) break;
      const parent = this.byId.get(current.parentId);
      if (!parent) throw new SessionError("invalid_session", `Parent ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  async getEntries(): Promise<SessionTreeEntry[]> {
    return [...this.entries];
  }
}
