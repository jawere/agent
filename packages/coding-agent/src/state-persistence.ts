// @jawere/coding-agent — Persistent working memory across CLI restarts
// Reads/writes .codebase/project-context.json so the agent doesn't re-read
// the entire codebase on every session.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';

export interface ProjectContext {
  /** When this context was last updated */
  updatedAt: number;
  /** Git commit hash when last updated */
  gitHash: string | null;
  /** Files the agent has read, with their content hashes */
  filesRead: Record<string, { hash: string; readAt: number }>;
  /** Files the agent has modified */
  filesModified: Record<string, { modifiedAt: number }>;
  /** Notes accumulated across sessions */
  notes: string[];
  /** Test descriptions extracted from the codebase */
  testIndex: TestIndexEntry[];
}

export interface TestIndexEntry {
  file: string;
  describe: string;
  tests: string[];
  /** Source files this test depends on (approximate) */
  dependsOn: string[];
}

const CONTEXT_FILE = '.codebase/project-context.json';

let cachedContext: ProjectContext | null = null;

export async function loadProjectContext(workDir: string): Promise<ProjectContext> {
  if (cachedContext) return cachedContext;

  const path = resolve(workDir, CONTEXT_FILE);
  try {
    if (!existsSync(path)) {
      cachedContext = createEmptyContext();
      return cachedContext;
    }
    const raw = await readFile(path, 'utf-8');
    cachedContext = JSON.parse(raw) as ProjectContext;
    return cachedContext;
  } catch {
    cachedContext = createEmptyContext();
    return cachedContext;
  }
}

export async function saveProjectContext(workDir: string, context: ProjectContext): Promise<void> {
  const path = resolve(workDir, CONTEXT_FILE);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  context.updatedAt = Date.now();
  await writeFile(path, JSON.stringify(context, null, 2), 'utf-8');
  cachedContext = context;
}

export function createEmptyContext(): ProjectContext {
  return {
    updatedAt: 0,
    gitHash: null,
    filesRead: {},
    filesModified: {},
    notes: [],
    testIndex: [],
  };
}

/**
 * Get a diff of files that have changed since the last scan.
 * Returns files that are either new, modified (different hash), or deleted.
 */
export async function getChangedFiles(
  workDir: string,
  checksums: Record<string, { hash: string; size: number }>,
): Promise<{ new: string[]; modified: string[]; deleted: string[] }> {
  const context = await loadProjectContext(workDir);
  const result: { new: string[]; modified: string[]; deleted: string[] } = {
    new: [],
    modified: [],
    deleted: [],
  };

  const knownFiles = new Set(Object.keys(context.filesRead));

  for (const [file, info] of Object.entries(checksums)) {
    if (!knownFiles.has(file)) {
      result.new.push(file);
    } else if (context.filesRead[file]?.hash !== info.hash) {
      result.modified.push(file);
    }
  }

  for (const file of knownFiles) {
    if (!checksums[file]) {
      result.deleted.push(file);
    }
  }

  return result;
}

/**
 * Update the hash for a file that was just read.
 * Invalidates the cached hash so future staleness checks detect changes.
 */
export async function recordFileRead(
  workDir: string,
  filepath: string,
  hash: string,
): Promise<void> {
  const context = await loadProjectContext(workDir);
  context.filesRead[filepath] = { hash, readAt: Date.now() };
  await saveProjectContext(workDir, context);
}

/**
 * Record a file modification and invalidate its read hash.
 * The agent will know its cached knowledge of this file is stale.
 */
export async function recordFileModified(
  workDir: string,
  filepath: string,
): Promise<void> {
  const context = await loadProjectContext(workDir);
  context.filesModified[filepath] = { modifiedAt: Date.now() };
  // Invalidate read hash so agent knows memory is stale
  if (context.filesRead[filepath]) {
    context.filesRead[filepath].hash = '__stale__';
  }
  await saveProjectContext(workDir, context);
}

/**
 * Check if the agent's cached knowledge of a file is stale.
 * Returns true if the file was modified after it was last read.
 */
export function isFileStale(context: ProjectContext, filepath: string): boolean {
  const readInfo = context.filesRead[filepath];
  const modInfo = context.filesModified[filepath];
  if (!readInfo) return true; // never read
  if (!modInfo) return false; // never modified after read
  return modInfo.modifiedAt > readInfo.readAt;
}
