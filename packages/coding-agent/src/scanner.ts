// src/scanner.ts — Background codebase scanner (orchestrator)
// Runs before the user prompt becomes available.
// Generates .codebase/tree.yaml, summaries.json, checksums.json, meta.json.

import { existsSync, statSync, readFileSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { getAllFiles, buildTree, getProjectInfo, generateTreeYaml } from './scanner/tree-builder.js';
import { summarizeFile, type FileSummary } from './scanner/summarizer.js';
import { indexTestFiles, findTestsForSource, type TestIndexEntry } from './test-indexer.js';
import { loadProjectContext, saveProjectContext, getChangedFiles, createEmptyContext } from './state-persistence.js';

const SCAN_INTERVAL_MS = 5 * 60 * 1000;
const CODEBASE_DIR = '.codebase';
const TREE_FILE = '.codebase/tree-shallow.yaml';
const TREE_FULL_FILE = '.codebase/tree.yaml';
const SUMMARIES_FILE = '.codebase/summaries.json';
const META_FILE = '.codebase/meta.json';
const CHECKSUMS_FILE = '.codebase/checksums.json';
const FILES_LIST_FILE = '.codebase/files.txt';
const CHANGES_FILE = '.codebase/changes.json';
const TEST_INDEX_FILE = '.codebase/test-index.json';

interface ScanMeta {
  scannedAt: number;
  fileCount: number;
  gitHash: string | null;
  workDir: string;
  scanner: string;
}

interface ChecksumEntry {
  hash: string;
  size: number;
  scannedAt: number;
}

interface Checksums {
  scannedAt: number;
  gitHash: string | null;
  files: Record<string, ChecksumEntry>;
}

// ── Helpers ─────────────────────────────────────────────────────────

function hashFile(filepath: string): string | null {
  try {
    const fd = readFileSync(filepath);
    const sample = fd.length > 65536 ? fd.subarray(0, 65536) : fd;
    return createHash('sha256').update(sample).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

async function getGitHash(workDir: string): Promise<string | null> {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: workDir,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return null;
  }
}

// ── Cache check ──────────────────────────────────────────────────────

export async function cacheIsStale(workDir: string): Promise<boolean> {
  const treePath = resolve(workDir, TREE_FILE);
  const metaPath = resolve(workDir, META_FILE);

  if (!existsSync(treePath) || !existsSync(metaPath)) return true;

  let meta: ScanMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf-8'));
  } catch {
    return true;
  }

  if (Date.now() - meta.scannedAt > SCAN_INTERVAL_MS) return true;

  const currentHash = await getGitHash(workDir);
  if (currentHash && currentHash !== meta.gitHash) return true;

  return false;
}

export async function loadChecksums(workDir: string): Promise<Checksums | null> {
  const path = resolve(workDir, CHECKSUMS_FILE);
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

export async function loadFileList(workDir: string): Promise<string[]> {
  const path = resolve(workDir, FILES_LIST_FILE);
  try {
    if (!existsSync(path)) return [];
    const content = await readFile(path, 'utf-8');
    return content.split('\n').filter((f) => f.trim());
  } catch {
    return [];
  }
}

// ── Scan orchestrator ────────────────────────────────────────────────

async function scanCodebase(
  workDir: string,
  onProgress?: (phase: string, detail?: string) => void,
): Promise<{ fileCount: number }> {
  const codebaseDir = resolve(workDir, CODEBASE_DIR);
  await mkdir(codebaseDir, { recursive: true });

  onProgress?.('listing files');
  const allFiles = await getAllFiles(workDir, workDir);
  const files = allFiles.sort();
  onProgress?.(`found ${files.length} files`);

  onProgress?.('building tree');
  const tree = buildTree(files);

  onProgress?.(`summarizing ${files.length} files`);
  const summaries: Record<string, FileSummary> = {};
  let lastReport = 0;
  for (let i = 0; i < files.length; i++) {
    const summary = await summarizeFile(resolve(workDir, files[i]));
    if (summary) {
      summaries[files[i]] = summary;
    }
    const now = Date.now();
    if (i - lastReport >= 10 || now - lastReport > 200) {
      onProgress?.(`summarizing ${i + 1}/${files.length}`);
      lastReport = i;
    }
  }

  onProgress?.('reading project info');
  const { name, version } = getProjectInfo(workDir);

  onProgress?.('hashing files');
  const gitHash = await getGitHash(workDir);
  const checksums: Checksums = {
    scannedAt: Date.now(),
    gitHash,
    files: {},
  };
  for (const file of files) {
    const fullPath = resolve(workDir, file);
    const hash = hashFile(fullPath);
    if (hash) {
      try {
        const st = statSync(fullPath);
        checksums.files[file] = { hash, size: st.size, scannedAt: Date.now() };
      } catch { /* skip unreadable */ }
    }
  }
  onProgress?.('writing checksums');
  await writeFile(resolve(workDir, CHECKSUMS_FILE), JSON.stringify(checksums, null, 2) + '\n', 'utf-8');

  onProgress?.('writing files.txt');
  await writeFile(resolve(workDir, FILES_LIST_FILE), allFiles.join('\n') + '\n', 'utf-8');

  onProgress?.('writing tree-shallow.yaml');
  const treeYaml = generateTreeYaml(name, version, tree, summaries);
  await writeFile(resolve(workDir, TREE_FILE), treeYaml, 'utf-8');

  onProgress?.('writing tree-full.yaml');
  const treeFullYaml = generateTreeYaml(name, version, tree, summaries, true);
  await writeFile(resolve(workDir, TREE_FULL_FILE), treeFullYaml, 'utf-8');

  onProgress?.('writing summaries.json');
  await writeFile(resolve(workDir, SUMMARIES_FILE), JSON.stringify(summaries, null, 2) + '\n', 'utf-8');

  // Test index: parse test files for describe/it blocks + source dependencies
  onProgress?.('indexing test files');
  const testIndex = await indexTestFiles(workDir);
  await writeFile(resolve(workDir, TEST_INDEX_FILE), JSON.stringify(testIndex, null, 2) + '\n', 'utf-8');

  // Change detection: diff current checksums against previous scan
  onProgress?.('detecting changes');
  const previousContext = await loadProjectContext(workDir);
  const previousChecksums = previousContext.filesRead;
  const changes = await getChangedFiles(workDir, checksums.files);
  // Also use previous checksums for stale detection
  const changedFiles: string[] = [];
  for (const [file, info] of Object.entries(checksums.files)) {
    const prev = previousChecksums[file];
    if (!prev || prev.hash !== info.hash) {
      changedFiles.push(file);
    }
  }
  const deletedFiles = Object.keys(previousChecksums).filter((f) => !checksums.files[f]);
  await writeFile(resolve(workDir, CHANGES_FILE), JSON.stringify({
    scannedAt: Date.now(),
    changed: changedFiles,
    deleted: deletedFiles,
    totalChanged: changedFiles.length + deletedFiles.length,
  }, null, 2) + '\n', 'utf-8');

  // Update project context with new checksums
  onProgress?.('updating project context');
  const context = createEmptyContext();
  context.gitHash = gitHash;
  context.testIndex = testIndex;
  for (const [file, info] of Object.entries(checksums.files)) {
    context.filesRead[file] = { hash: info.hash, readAt: Date.now() };
  }
  await saveProjectContext(workDir, context);

  onProgress?.('writing meta.json');
  const meta: ScanMeta = {
    scannedAt: Date.now(),
    fileCount: files.length,
    gitHash,
    workDir,
    scanner: 'background-v2',
  };
  await writeFile(resolve(workDir, META_FILE), JSON.stringify(meta, null, 2) + '\n', 'utf-8');

  return { fileCount: files.length };
}

// ── Public API ───────────────────────────────────────────────────────

export async function runScanner(
  workDir: string,
  force = false,
): Promise<{ fileCount: number; cached: boolean; changedCount?: number }> {
  if (!force && !(await cacheIsStale(workDir))) {
    try {
      const meta: ScanMeta = JSON.parse(
        await readFile(resolve(workDir, META_FILE), 'utf-8'),
      );
      // Check for change diff even when cached
      let changedCount: number | undefined;
      try {
        const changesData = JSON.parse(
          await readFile(resolve(workDir, CHANGES_FILE), 'utf-8'),
        );
        changedCount = changesData.totalChanged;
      } catch { /* no changes file yet */ }
      process.stderr.write(` (cached)`);
      return { fileCount: meta.fileCount, cached: true, changedCount };
    } catch {
      // Meta corrupt, fall through
    }
  }

  const GRAY = '\x1b[38;2;146;131;116m';
  const RESET = '\x1b[0m';

  const { fileCount } = await scanCodebase(workDir, (phase, detail) => {
    const msg = detail || phase;
    process.stderr.write(`\r\x1b[K${GRAY}  scanning: ${msg}${RESET}`);
  });
  process.stderr.write(`\r\x1b[K`);

  // Read changes for return value
  let changedCount: number | undefined;
  try {
    const changesData = JSON.parse(
      await readFile(resolve(workDir, CHANGES_FILE), 'utf-8'),
    );
    changedCount = changesData.totalChanged;
  } catch { /* no changes */ }

  return { fileCount, cached: false, changedCount };
}
