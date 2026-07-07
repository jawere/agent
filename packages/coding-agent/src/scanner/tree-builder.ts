// @jawere/coding-agent — Tree builder and YAML serializer for the codebase scanner

import { statSync, readFileSync } from 'fs';
import { writeFile, readdir } from 'fs/promises';
import { resolve, relative, join, basename, dirname } from 'path';
import { classifyFile } from './classifier.js';
import { summarizeFile, type FileSummary } from './summarizer.js';

export interface FileEntry {
  name: string;
  type: string;
  desc: string;
  size?: number;
}

export interface TreeYAML {
  project: {
    name: string;
    version: string;
    language: string;
    type: string;
  };
  tree: Record<string, FileEntry[]>;
  summaries: Record<string, FileSummary>;
}

// Files/dirs to skip entirely
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.codebase',
  '.logic',
  '__pycache__', '.cache', '.next', '.turbo',
]);

export const SKIP_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);

export async function getAllFiles(dir: string, baseDir: string): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
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

export function buildTree(files: string[]): Record<string, FileEntry[]> {
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

  for (const key of Object.keys(tree)) {
    tree[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  return tree;
}

export function getProjectInfo(workDir: string): { name: string; version: string } {
  let name = basename(workDir);
  let version = '0.0.0';

  try {
    const pkg = JSON.parse(readFileSync(resolve(workDir, 'package.json'), 'utf-8'));
    if (pkg.name) name = pkg.name;
    if (pkg.version) version = pkg.version;
  } catch { /* use defaults */ }

  return { name, version };
}

function escapeYaml(str: string): string {
  return str.replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function generateTreeYaml(
  name: string,
  version: string,
  tree: Record<string, FileEntry[]>,
  summaries: Record<string, FileSummary>,
  includeSummaries = false,
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

  if (includeSummaries) {
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
  }

  return lines.join('\n') + '\n';
}
