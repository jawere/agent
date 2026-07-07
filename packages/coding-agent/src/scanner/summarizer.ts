// @jawere/coding-agent — Source file summarizer for the codebase scanner

import { readFile } from 'fs/promises';
import { basename } from 'path';

export interface FileSummary {
  lines: number;
  exports: string[];
  key_functions: string[];
  depends_on: string[];
  description: string;
}

const SUMMARIZABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb',
  '.c', '.cpp', '.h', '.hpp', '.java', '.kt', '.swift',
  '.yaml', '.yml', '.json', '.toml', '.md', '.css', '.scss',
  '.sql', '.sh', '.bash', '.zsh', '.Dockerfile',
]);

export function extractExports(lines: string[]): string[] {
  const exports: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const namedMatch = trimmed.match(
      /^export\s+(const|function|class|interface|type|enum|async\s+function|let|var)\s+(\w+)/,
    );
    if (namedMatch) {
      exports.push(namedMatch[2]);
      continue;
    }
    if (trimmed.startsWith('export default')) {
      exports.push('default');
      continue;
    }
  }
  return exports;
}

export function extractImports(lines: string[]): string[] {
  const deps: string[] = [];
  for (const line of lines) {
    const relMatch = line.match(/from\s+['"](\.[^'"]+)['"]/);
    if (relMatch) {
      deps.push(relMatch[1]);
    }
  }
  return deps;
}

export function extractKeyFunctions(lines: string[]): string[] {
  const funcs: string[] = [];
  for (const line of lines) {
    const expFunc = line.match(/^export\s+(async\s+)?function\s+(\w+)/);
    if (expFunc) {
      funcs.push(expFunc[2]);
      continue;
    }
    const topFunc = line.match(/^(async\s+)?function\s+(\w+)/);
    if (topFunc) {
      funcs.push(topFunc[2]);
      continue;
    }
    const arrowFunc = line.match(/^(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?\(/);
    if (arrowFunc) {
      funcs.push(arrowFunc[2]);
    }
  }
  return funcs;
}

export function extractBehaviorHints(lines: string[]): string[] {
  const hints: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();

    // Return type annotations on exported functions
    const retTypeMatch = trimmed.match(/^export\s+(async\s+)?function\s+\w+[^)]*\)\s*:\s*(\S+)/);
    if (retTypeMatch) {
      hints.push(`Returns: ${retTypeMatch[2].replace(/[,;{].*/, '').slice(0, 40)}`);
      continue;
    }

    // Inline comments describing function behavior
    const commentMatch = trimmed.match(/^\/\/\s*(Returns|Handles|Skips|Throws|Strips|Only|Unless|If|Takes|Filters|Converts|Maps|Reduces|Sorts|Groups|Validates|Normalizes|Parses|Formats|Escapes|Encodes|Decodes|Merges)\s+(.+)/i);
    if (commentMatch) {
      hints.push(`${commentMatch[1]}: ${commentMatch[2].slice(0, 80)}`);
      if (hints.length >= 8) break;
      continue;
    }

    // JSDoc @returns with type
    const jsdocMatch = trimmed.match(/@returns?\s+\{([^}]+)\}\s*(.+)/);
    if (jsdocMatch) {
      hints.push(`Returns ${jsdocMatch[1]} — ${jsdocMatch[2].slice(0, 60)}`);
      if (hints.length >= 8) break;
      continue;
    }

    // Arrow function with return type annotation
    const arrowRetMatch = trimmed.match(/(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*:\s*(\S+)/);
    if (arrowRetMatch) {
      hints.push(`Returns: ${arrowRetMatch[1].replace(/=>.*/, '').slice(0, 40)}`);
      continue;
    }

    // Guard clauses with early returns
    const guardMatch = trimmed.match(/^\s*if\s*\([^)]+\)\s*return\s*([^;]+)?;/);
    if (guardMatch && guardMatch[1]) {
      const val = guardMatch[1].trim().slice(0, 40);
      if (val && !['null', 'undefined', 'false', 'true', '0', '""', "''"].includes(val)) {
        hints.push(`Early return: ${val}`);
        if (hints.length >= 8) break;
      }
      continue;
    }

    // Throw statements
    const throwMatch = trimmed.match(/^\s*throw\s+new\s+\w+\(['"]([^'"]+)['"]/);
    if (throwMatch) {
      hints.push(`Throws: ${throwMatch[1].slice(0, 50)}`);
      if (hints.length >= 8) break;
      continue;
    }
  }
  return hints;
}

export function generateDescription(filepath: string, lines: string[], exports: string[]): string {
  const behaviorHints = extractBehaviorHints(lines);
  const basenameLower = basename(filepath).toLowerCase();

  if (basenameLower.includes('.test.') || basenameLower.includes('.spec.')) {
    const testDescribes: string[] = [];
    const testTests: string[] = [];
    const testImports: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const descMatch = lines[i].match(/describe\(\s*['"]([^'"]+)['"]/);
      if (descMatch) testDescribes.push(descMatch[1]);
      const testMatch = lines[i].match(/(?:it|test)\(\s*['"]([^'"]+)['"]/);
      if (testMatch) testTests.push(testMatch[1]);
      const importMatch = lines[i].match(/from\s+['"](\.\.[^'"]+)['"]/);
      if (importMatch) {
        const p = importMatch[1].replace(/\.ts$/, '');
        if (!testImports.includes(p)) testImports.push(p);
      }
    }
    const parts: string[] = ['Test file'];
    if (testDescribes.length > 0) parts.push(`describes: ${testDescribes.slice(0, 4).join(', ')}${testDescribes.length > 4 ? ', …' : ''}`);
    if (testTests.length > 0) parts.push(`${testTests.length} tests`);
    // Show which source files are tested (deduced from imports)
    if (testImports.length > 0) {
      const sources = testImports.map(i => i.split('/').pop() || i).slice(0, 3);
      parts.push(`covers: ${sources.join(', ')}${testImports.length > 3 ? ', …' : ''}`);
    }
    return parts.join(' — ');
  }

  const ext = filepath.includes('.') ? filepath.split('.').pop()?.toLowerCase() : '';

  if (basenameLower === 'package.json') return 'NPM package manifest — scripts, dependencies, metadata.';
  if (basenameLower === 'package-lock.json') return 'NPM dependency lockfile.';
  if (basenameLower === 'tsconfig.json') return 'TypeScript compiler configuration.';
  if (basenameLower === 'readme.md') return 'Project documentation and README.';
  if (basenameLower === '.gitignore') return 'Git ignore rules.';
  if (basenameLower === '.env.local' || basenameLower === '.env.prod') return 'Environment variables (local/prod).';
  if (basenameLower === 'convex.json') return 'Convex project configuration.';
  if (basenameLower === '.releaserc') return 'Semantic release configuration.';
  if (basenameLower === 'ci.yml' || basenameLower === '.gitlab-ci.yml') return 'CI/CD pipeline configuration.';

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

  if (ext === 'md') return 'Documentation file.';
  if (ext === 'json') return 'JSON configuration file.';
  if (ext === 'yml' || ext === 'yaml') return 'YAML configuration file.';
  if (ext === 'js') return 'JavaScript module.';
  if (ext === 'ts' || ext === 'tsx') {
    if (basenameLower.includes('types') || basenameLower.endsWith('.d')) return 'TypeScript type declarations and interfaces.';
    if (exports.length > 0) {
      const hints = behaviorHints.length > 0 ? ` ${behaviorHints.slice(0, 4).join('; ')}.` : '';
      return `Exports: ${exports.slice(0, 6).join(', ')}${exports.length > 6 ? ', …' : ''}.${hints}`;
    }
    const hints = behaviorHints.length > 0 ? ` ${behaviorHints.slice(0, 4).join('; ')}.` : '';
    return `TypeScript source file.${hints}`;
  }
  if (ext === 'd.ts') return 'TypeScript type declarations.';

  if (exports.length > 0) {
    return `Exports: ${exports.slice(0, 5).join(', ')}${exports.length > 5 ? ', …' : ''}.`;
  }
  return 'Source file.';
}

export async function summarizeFile(filepath: string): Promise<FileSummary | null> {
  const ext = filepath.includes('.') ? `.${filepath.split('.').pop()}` : '';
  if (!SUMMARIZABLE_EXTENSIONS.has(ext)) return null;

  let content: string;
  try {
    content = await readFile(filepath, 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  const exports = extractExports(lines);
  const keyFunctions = extractKeyFunctions(lines);
  const dependsOn = extractImports(lines);
  const description = generateDescription(filepath, lines, exports);

  return {
    lines: lines.length,
    exports,
    key_functions: keyFunctions,
    depends_on: dependsOn,
    description,
  };
}
