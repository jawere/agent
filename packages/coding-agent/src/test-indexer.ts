// @jawere/coding-agent — Test file indexer
// Parses *.test.ts files to extract describe/it blocks and their dependencies.
// Used for "affected tests" hints and isolated test running.

import { readFile, readdir } from 'fs/promises';
import { resolve, relative, dirname } from 'path';
import { statSync } from 'fs';

export interface TestIndexEntry {
  file: string;
  packageName: string;
  describes: DescribeBlock[];
  /** Source files this test file imports from (relative or @-scoped) */
  imports: string[];
}

export interface DescribeBlock {
  name: string;
  tests: string[];
  line: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '__pycache__',
  '.venv', 'venv', '.next', '.cache', '.convex',
]);

/**
 * Scan a directory tree for test files and parse their structure.
 * Does NOT execute any tests — purely static analysis.
 */
export async function indexTestFiles(workDir: string): Promise<TestIndexEntry[]> {
  const results: TestIndexEntry[] = [];
  const testFiles: string[] = [];

  await findTestFiles(workDir, workDir, testFiles);

  for (const file of testFiles) {
    try {
      const entry = await parseTestFile(file, workDir);
      if (entry) results.push(entry);
    } catch {
      // skip unparseable files
    }
  }

  return results;
}

async function findTestFiles(baseDir: string, dir: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const full = resolve(dir, e.name);
    if (e.isDirectory()) {
      await findTestFiles(baseDir, full, results);
    } else if (e.isFile() && (e.name.endsWith('.test.ts') || e.name.endsWith('.test.tsx') || e.name.endsWith('.spec.ts'))) {
      results.push(full);
    }
  }
}

async function parseTestFile(filepath: string, workDir: string): Promise<TestIndexEntry | null> {
  let content: string;
  try {
    content = await readFile(filepath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const describes: DescribeBlock[] = [];

  // Extract imports
  const imports: string[] = [];
  for (const line of lines) {
    const match = line.match(/from\s+['"]([^'"]+)['"]/);
    if (match) {
      imports.push(match[1]);
    }
  }

  // Extract describe blocks and their it/test blocks
  let currentDescribe: DescribeBlock | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // describe("name", ...) or describe('name', ...)
    const descMatch = line.match(/describe\(\s*['"]([^'"]+)['"]/);
    if (descMatch) {
      if (currentDescribe) {
        describes.push(currentDescribe);
      }
      currentDescribe = { name: descMatch[1], tests: [], line: i + 1 };
      continue;
    }

    // it("name", ...) or test("name", ...)
    const testMatch = line.match(/(?:it|test)\(\s*['"]([^'"]+)['"]/);
    if (testMatch && currentDescribe) {
      currentDescribe.tests.push(testMatch[1]);
      continue;
    }

    // Closing }) of describe block
    if (line === '});') {
      // Check if we're ending the describe block
      if (currentDescribe && lines[i - 1]?.trim() !== '})' && lines[i + 1]?.trim() !== '});') {
        // Heuristic: only close if next line isn't another close
      }
    }
  }

  if (currentDescribe) {
    describes.push(currentDescribe);
  }

  if (describes.length === 0) return null;

  // Determine package name from path
  const relPath = relative(workDir, filepath);
  const pkgMatch = relPath.match(/packages\/([^/]+)/);
  const packageName = pkgMatch ? pkgMatch[1] : 'root';

  return {
    file: relPath,
    packageName,
    describes,
    imports,
  };
}

/**
 * Find which test files depend on a given source file.
 * Matches by import path or package-scoped module references.
 */
export function findTestsForSource(
  testIndex: TestIndexEntry[],
  sourceFile: string,
): TestIndexEntry[] {
  const normalizedSource = sourceFile.replace(/\.ts$/i, '');

  return testIndex.filter((entry) => {
    return entry.imports.some((imp) => {
      // Match relative imports: "../db" matches "db.ts"
      const importBase = imp.replace(/\.\.?\//g, '').replace(/\.ts$/i, '');
      const sourceBase = normalizedSource.replace(/^.*\//, '');
      if (importBase === sourceBase) return true;

      // Match full or partial paths
      if (imp.includes(normalizedSource)) return true;
      if (normalizedSource.includes(importBase)) return true;

      return false;
    });
  });
}

/**
 * Build a CLI filter string for running a specific describe block or test.
 * Returns --test-name-pattern argument or empty string.
 */
export function buildTestFilter(
  describeName?: string,
  testName?: string,
): string {
  if (testName) {
    const escaped = testName.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
    return `--test-name-pattern="${escaped}"`;
  }
  if (describeName) {
    const escaped = describeName.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
    return `--test-name-pattern="${escaped}"`;
  }
  return '';
}

/**
 * Get the npm run-script command for a specific package.
 */
export function packageTestCommand(packageName: string, filter?: string): string {
  const base = `npm run test -w @jawere/${packageName}`;
  if (filter) {
    return `${base} -- ${filter}`;
  }
  // Node 22+ supports --experimental-strip-types natively
  // The test script uses node --test --experimental-strip-types src/*.test.ts
  // Adding -- before passes args to node
  if (filter) {
    return `${base} -- ${filter}`;
  }
  return base;
}

/**
 * Get only the packages that have git changes.
 * Returns package names that have unstaged or staged changes.
 */
export async function getChangedPackages(workDir: string): Promise<string[]> {
  const { execSync } = await import('child_process');
  try {
    const output = execSync('git diff --name-only HEAD 2>/dev/null || git diff --name-only 2>/dev/null', {
      cwd: workDir,
      encoding: 'utf-8',
      timeout: 5000,
    });

    const changedPackages = new Set<string>();
    for (const line of output.split('\n').filter(Boolean)) {
      const match = line.match(/^packages\/([^/]+)/);
      if (match) {
        changedPackages.add(match[1]);
      }
    }
    return Array.from(changedPackages);
  } catch {
    return [];
  }
}
