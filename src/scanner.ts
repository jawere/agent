// src/scanner.ts — Background codebase scanner
// Runs before the user prompt becomes available.
// Generates .codebase/tree.yaml (annotated project tree + file summaries)
// and .codebase/meta.json (scan metadata for cache invalidation).
// Also generates .codebase/checksums.json for content-hash change detection.

import { existsSync, statSync, readFileSync } from 'fs';
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { resolve, relative, join, basename, dirname } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 min cache validity
const CODEBASE_DIR = '.codebase';
const TREE_FILE = '.codebase/tree.yaml';
const META_FILE = '.codebase/meta.json';
const CHECKSUMS_FILE = '.codebase/checksums.json';

// Files/dirs to skip entirely
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.codebase',
  '__pycache__', '.cache', '.next', '.turbo',
]);

const SKIP_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);

// Files we can summarize by reading first N lines
const SUMMARIZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb',
  '.c', '.cpp', '.h', '.hpp', '.java', '.kt', '.swift',
  '.yaml', '.yml', '.json', '.toml', '.md', '.css', '.scss',
  '.sql', '.sh', '.bash', '.zsh', '.Dockerfile',
]);

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

interface FileEntry {
  name: string;
  type: string;
  desc: string;
  size?: number;
}

interface FileSummary {
  lines: number;
  exports: string[];
  key_functions: string[];
  depends_on: string[];
  description: string;
}

interface TreeYAML {
  project: {
    name: string;
    version: string;
    language: string;
    type: string;
  };
  tree: Record<string, FileEntry[]>;
  summaries: Record<string, FileSummary>;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Compute SHA-256 hash of a file's contents (first 64KB for speed). */
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

function isBinary(buffer: Buffer): boolean {
  const sample = buffer.slice(0, 4096);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

function classifyFile(filename: string, dir: string): string {
  const name = filename.toLowerCase();

  if (name.includes('.test.') || name.includes('.spec.')) return 'test';
  if (name.endsWith('.d.ts')) return 'types';
  if (dir.includes('/convex/')) return 'backend';
  if (dir.includes('/src/')) {
    if (name.includes('config') || name.includes('env')) return 'config';
    if (name.includes('test') || name.includes('spec')) return 'test';
    if (name.includes('prompt')) return 'prompt';
    if (name.includes('tool')) return 'core';
    if (name.includes('agent')) return 'core';
    if (name.includes('index')) return 'core';
    if (name.includes('crypto') || name.includes('encrypt')) return 'security';
    return 'core';
  }
  if (dir.includes('/scripts/') || dir.includes('/bin/')) {
    if (name.includes('build')) return 'build';
    return 'entry';
  }
  if (name === 'package.json') return 'config';
  if (name === 'tsconfig.json') return 'config';
  if (name.endsWith('.json')) return 'config';
  if (name.endsWith('.md')) return 'docs';
  if (name.includes('readme')) return 'docs';
  if (name.includes('.gitignore')) return 'config';
  if (name.includes('docker')) return 'container';
  if (name.includes('.env')) return 'secret';
  if (dir.includes('/.github/')) return 'ci';

  return 'other';
}

function extractExports(lines: string[]): string[] {
  const exports: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Named exports: export const/function/class/interface/type/async function
    const namedMatch = trimmed.match(
      /^export\s+(const|function|class|interface|type|enum|async\s+function|let|var)\s+(\w+)/,
    );
    if (namedMatch) {
      exports.push(namedMatch[2]);
      continue;
    }
    // Default export
    if (trimmed.startsWith('export default')) {
      exports.push('default');
      continue;
    }
  }
  return exports;
}

function extractImports(lines: string[]): string[] {
  const deps: string[] = [];
  for (const line of lines) {
    // Relative imports only (internal deps)
    const relMatch = line.match(/from\s+['"](\.[^'"]+)['"]/);
    if (relMatch) {
      deps.push(relMatch[1]);
    }
  }
  return deps;
}

function extractKeyFunctions(lines: string[]): string[] {
  const funcs: string[] = [];
  for (const line of lines) {
    // Exported functions
    const expFunc = line.match(/^export\s+(async\s+)?function\s+(\w+)/);
    if (expFunc) {
      funcs.push(expFunc[2]);
      continue;
    }
    // Top-level functions
    const topFunc = line.match(/^(async\s+)?function\s+(\w+)/);
    if (topFunc) {
      funcs.push(topFunc[2]);
      continue;
    }
    // Arrow functions assigned to const
    const arrowFunc = line.match(/^(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?\(/);
    if (arrowFunc) {
      funcs.push(arrowFunc[2]);
    }
  }
  return funcs;
}

function generateDescription(filepath: string, lines: string[], exports: string[]): string {
  const basenameLower = basename(filepath).toLowerCase();
  const ext = filepath.includes('.') ? filepath.split('.').pop()?.toLowerCase() : '';

  // ── By filename (specific) ──
  if (basenameLower === 'package.json') return 'NPM package manifest — scripts, dependencies, metadata.';
  if (basenameLower === 'package-lock.json') return 'NPM dependency lockfile.';
  if (basenameLower === 'tsconfig.json') return 'TypeScript compiler configuration.';
  if (basenameLower === 'readme.md') return 'Project documentation and README.';
  if (basenameLower === '.gitignore') return 'Git ignore rules.';
  if (basenameLower === '.env.local' || basenameLower === '.env.prod') return 'Environment variables (local/prod).';
  if (basenameLower === 'convex.json') return 'Convex project configuration.';
  if (basenameLower === '.releaserc') return 'Semantic release configuration.';
  if (basenameLower === 'ci.yml' || basenameLower === '.gitlab-ci.yml') return 'CI/CD pipeline configuration.';

  // ── By file role ──
  if (basenameLower.includes('index')) return 'Main entry point and REPL loop.';
  if (basenameLower.includes('agent')) return 'Agent loop — API calls, tool execution, spinner, retry logic.';
  if (basenameLower.includes('tool')) return 'Tool definitions and implementations for agent actions.';
  if (basenameLower.includes('config')) return 'Configuration loading and management.';
  if (basenameLower.includes('crypto') || basenameLower.includes('encrypt')) return 'Encryption/decryption utilities.';
  if (basenameLower.includes('prompt')) return 'System prompt definition for the agent.';
  if (basenameLower.includes('convex')) return 'Convex backend client for session persistence.';
  if (basenameLower.includes('scanner')) return 'Background codebase scanner — generates tree.yaml cache.';
  if (basenameLower.includes('schema')) return 'Database schema definition.';
  if (basenameLower.includes('session')) return 'Session management logic.';
  if (basenameLower.includes('seed')) return 'Database seeding script.';
  if (basenameLower.includes('build')) return 'Build/bundler script.';
  if (basenameLower.includes('test') || basenameLower.includes('spec')) return 'Test file.';

  // ── By extension ──
  if (ext === 'md') return 'Documentation file.';
  if (ext === 'json') return 'JSON configuration file.';
  if (ext === 'yml' || ext === 'yaml') return 'YAML configuration file.';
  if (ext === 'js') return 'JavaScript module.';
  if (ext === 'ts' || ext === 'tsx') {
    if (exports.length > 0) {
      return `Exports: ${exports.slice(0, 5).join(', ')}${exports.length > 5 ? ', …' : ''}.`;
    }
    return 'TypeScript source file.';
  }
  if (ext === 'd.ts') return 'TypeScript type declarations.';

  // Fallback: derive from exports
  if (exports.length > 0) {
    return `Exports: ${exports.slice(0, 5).join(', ')}${exports.length > 5 ? ', …' : ''}.`;
  }
  return 'Source file.';
}

async function summarizeFile(filepath: string): Promise<FileSummary | null> {
  const ext = filepath.includes('.') ? `.${filepath.split('.').pop()}` : '';
  if (!SUMMARIZABLE_EXTENSIONS.has(ext)) return null;

  let content: string;
  try {
    content = await readFile(filepath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const totalLines = lines.length;
  const exports = extractExports(lines);
  const keyFunctions = extractKeyFunctions(lines);
  const dependsOn = extractImports(lines);
  const description = generateDescription(filepath, lines, exports);

  return {
    lines: totalLines,
    exports,
    key_functions: keyFunctions,
    depends_on: dependsOn,
    description,
  };
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

  // Check age
  if (Date.now() - meta.scannedAt > SCAN_INTERVAL_MS) return true;

  // Check git hash (if available)
  const currentHash = await getGitHash(workDir);
  if (currentHash && currentHash !== meta.gitHash) return true;

  return false;
}

/**
 * Load stored checksums for quick file-change detection.
 * The agent can use this to skip re-reading files that haven't changed.
 */
export async function loadChecksums(workDir: string): Promise<Checksums | null> {
  const path = resolve(workDir, CHECKSUMS_FILE);
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

// ── Scanner ──────────────────────────────────────────────────────────

async function getAllFiles(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden
    if (SKIP_DIRS.has(entry.name)) continue;
    if (SKIP_FILES.has(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      const children = await getAllFiles(fullPath, baseDir);
      files.push(...children);
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }

  return files;
}

function buildTree(files: string[]): Record<string, FileEntry[]> {
  const tree: Record<string, FileEntry[]> = {};

  for (const file of files) {
    const dir = dirname(file);
    const name = basename(file);
    const key = dir === '.' ? 'root' : dir + '/';

    if (!tree[key]) tree[key] = [];

    let size = 0;
    try {
      size = statSync(file).size;
    } catch { /* ignore */ }

    const type = classifyFile(name, dir);

    tree[key].push({
      name,
      type,
      desc: '',
      size,
    });
  }

  // Sort each directory: dirs first, then files alphabetically
  for (const key of Object.keys(tree)) {
    tree[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  return tree;
}

function getProjectInfo(workDir: string): { name: string; version: string } {
  let name = basename(workDir);
  let version = '0.0.0';

  try {
    const pkg = JSON.parse(readFileSync(resolve(workDir, 'package.json'), 'utf-8'));
    if (pkg.name) name = pkg.name;
    if (pkg.version) version = pkg.version;
  } catch { /* use defaults */ }

  return { name, version };
}

async function scanCodebase(
  workDir: string,
  onProgress?: (phase: string, detail?: string) => void,
): Promise<{ fileCount: number }> {
  const codebaseDir = resolve(workDir, CODEBASE_DIR);
  await mkdir(codebaseDir, { recursive: true });

  // 1. Get all files
  onProgress?.('listing files');
  const allFiles = await getAllFiles(workDir, workDir);
  const files = allFiles.sort();
  onProgress?.(`found ${files.length} files`);

  // 2. Build tree
  onProgress?.('building tree');
  const tree = buildTree(files);

  // 3. Summarize source files
  onProgress?.(`summarizing ${files.length} files`);
  const summaries: Record<string, FileSummary> = {};
  let lastReport = 0;
  for (let i = 0; i < files.length; i++) {
    const summary = await summarizeFile(resolve(workDir, files[i]));
    if (summary) {
      summaries[files[i]] = summary;
    }
    // Report progress every 10 files or every 200ms
    const now = Date.now();
    if (i - lastReport >= 10 || now - lastReport > 200) {
      onProgress?.(`summarizing ${i + 1}/${files.length}`);
      lastReport = i;
    }
  }

  // 4. Get project info
  onProgress?.('reading project info');
  const { name, version } = getProjectInfo(workDir);

  // 5. Generate checksums (content-hash tracking for change detection)
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
      } catch { /* skip unreadable files */ }
    }
  }
  onProgress?.('writing checksums');
  await writeFile(resolve(workDir, CHECKSUMS_FILE), JSON.stringify(checksums, null, 2) + '\n', 'utf-8');

  // 6. Generate tree.yaml
  onProgress?.('writing tree.yaml');
  const treeYaml = generateTreeYaml(name, version, tree, summaries);
  await writeFile(resolve(workDir, TREE_FILE), treeYaml, 'utf-8');

  // 7. Generate meta.json
  onProgress?.('writing meta.json');
  const meta: ScanMeta = {
    scannedAt: Date.now(),
    fileCount: files.length,
    gitHash,
    workDir,
    scanner: 'background-v1',
  };
  await writeFile(resolve(workDir, META_FILE), JSON.stringify(meta, null, 2) + '\n', 'utf-8');

  return { fileCount: files.length };
}

function generateTreeYaml(
  name: string,
  version: string,
  tree: Record<string, FileEntry[]>,
  summaries: Record<string, FileSummary>,
): string {
  const lines: string[] = [];

  lines.push(`# ${name} — Full Codebase Tree (auto-generated)`);
  lines.push(`# Generated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('# Updated by background scanner agent before each session.');
  lines.push('# This file is consumed by the main agent so it doesn\'t need to re-scan.');
  lines.push('');
  lines.push('project:');
  lines.push(`  name: ${name}`);
  lines.push(`  version: ${version}`);
  lines.push('  language: typescript');
  lines.push('  type: terminal-ai-coding-agent');
  lines.push('');
  lines.push('tree:');

  // Sort keys: root first, then alphabetically
  const keys = Object.keys(tree).sort((a, b) => {
    if (a === 'root') return -1;
    if (b === 'root') return 1;
    return a.localeCompare(b);
  });

  for (const key of keys) {
    const entries = tree[key];
    const indent = '  ' + (key === 'root' ? '' : '  ');
    const displayKey = key === 'root' ? 'root:' : `${key}:`;
    lines.push(`  ${displayKey}`);

    for (const entry of entries) {
      const sizeStr = entry.size ? ` (${formatSize(entry.size)})` : '';
      lines.push(`    - ${entry.name}:`);
      lines.push(`        type: ${entry.type}`);
      if (entry.desc) {
        lines.push(`        desc: "${entry.desc}"`);
      } else {
        // Auto-describe from summary if available
        const filePath = key === 'root' ? entry.name : `${key}${entry.name}`;
        const summary = summaries[filePath];
        if (summary) {
          lines.push(`        desc: "${escapeYaml(summary.description)}"`);
        }
      }
      if (entry.size) {
        lines.push(`        size: ${entry.size}`);
      }
    }
  }

  // Summaries section
  lines.push('');
  lines.push('# ── File summaries (for quick agent context) ────────────────────────');
  lines.push('');
  lines.push('summaries:');

  const summaryKeys = Object.keys(summaries).sort();
  for (const file of summaryKeys) {
    const s = summaries[file];
    lines.push(`  "${file}":`);
    lines.push(`    lines: ${s.lines}`);
    lines.push(`    exports: [${s.exports.map((e) => `"${e}"`).join(', ')}]`);
    if (s.key_functions.length > 0) {
      lines.push(`    key_functions: [${s.key_functions.map((f) => `"${f}"`).join(', ')}]`);
    }
    if (s.depends_on.length > 0) {
      lines.push(`    depends_on: [${s.depends_on.map((d) => `"${d}"`).join(', ')}]`);
    }
    lines.push(`    description: |`);
    lines.push(`      ${s.description}`);
  }

  return lines.join('\n') + '\n';
}

function escapeYaml(str: string): string {
  return str.replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run the background scanner.
 * Checks cache validity first; if stale, re-scans the codebase.
 *
 * @param workDir Working directory to scan
 * @param force Force rescan even if cache is fresh
 * @returns Scan result with file count
 */
export async function runScanner(
  workDir: string,
  force = false,
): Promise<{ fileCount: number; cached: boolean }> {
  if (!force && !(await cacheIsStale(workDir))) {
    // Cache is fresh — read meta for fileCount
    try {
      const meta: ScanMeta = JSON.parse(
        await readFile(resolve(workDir, META_FILE), 'utf-8'),
      );
      process.stderr.write(` (cached)`);
      return { fileCount: meta.fileCount, cached: true };
    } catch {
      // Meta corrupt, fall through to scan
    }
  }

  // Show progress as the scanner works through phases
  const GRAY = '\x1b[38;2;146;131;116m';
  const RESET = '\x1b[0m';

  const { fileCount } = await scanCodebase(workDir, (phase, detail) => {
    // Clear previous progress line, show new one
    const msg = detail || phase;
    process.stderr.write(`\r\x1b[K${GRAY}  scanning: ${msg}${RESET}`);
  });
  // Clear the last progress line
  process.stderr.write(`\r\x1b[K`);
  return { fileCount, cached: false };
}
