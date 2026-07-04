import { exec, ExecOptions } from 'child_process';
import { readFile, writeFile, mkdir, access, stat as fsStat } from 'fs/promises';
import { constants } from 'fs';
import { resolve, dirname } from 'path';
import { get as httpsGet } from 'https';

// ── Security helpers ───────────────────────────────────────────────

/** Resolve a user-supplied path against workDir, blocking traversal escapes. */
function safeResolve(workDir: string, userPath: string): string {
  // Resolve to absolute path
  const resolved = resolve(workDir, userPath);
  const normalizedWd = resolve(workDir).replace(/\/+$/, '') + '/';
  const normalizedResolved = resolved.replace(/\/+$/, '') + '/';
  if (!normalizedResolved.startsWith(normalizedWd)) {
    throw new Error(
      `Path traversal blocked: "${userPath}" escapes the working directory. ` +
      `All file operations must stay within ${workDir}.`,
    );
  }
  return resolved;
}

/** Patterns that are never safe for an automated agent to run. */
const DANGEROUS_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(?:^|[;&|])\s*rm\s.*-rf\s*(?:\/|\/\*|\s+\/)/, reason: 'rm -rf on root filesystem' },
  { pattern: /(?:^|[;&|])\s*sudo\s/, reason: 'sudo escalation' },
  { pattern: /:.*\(.*\)\s*\{\s*:\|:.*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /(?:^|[;&|])\s*(?:dd|mkfs|fdisk|parted)\s.*if=\/dev\/|of=\/dev\//, reason: 'raw device write' },
  { pattern: /(?:^|[;&|])\s*chmod\s.*-R\s*(?:777|o\+rwx|a\+rwx)\s*(?:\/|\/etc|\/usr|\/var)/, reason: 'recursive world-writable on system dirs' },
  { pattern: /(?:^|[;&|])\s*(?:curl|wget)\s.*\|\s*(?:ba)?sh/, reason: 'curl-pipe-shell — use safer methods' },
  { pattern: /(?:^|[;&|])\s*git\s+push\s+--force.*main|master/, reason: 'force push to main/master' },
];

function checkDangerousCommand(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      return `Blocked dangerous command (${reason}). If you need this, run it manually in your terminal.`;
    }
  }
  return null;
}

// ── Types ───────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: 'tool';
  content: string;
}

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

// ── Tool definitions ────────────────────────────────────────────────

export const TOOL_DEFS: OpenAITool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a bash command in the working directory. Returns stdout and stderr. ' +
        'Output is truncated to 2000 lines or 50KB (whichever is hit first). ' +
        'Optionally provide a timeout in seconds (max 300s).',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Bash command to execute',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in seconds (optional, max 300)',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description:
        'Read the contents of a file. Supports text files. ' +
        'Output is truncated to 2000 lines or 50KB (whichever is hit first). ' +
        'Use offset/limit for large files. When you need the full file, continue with offset until complete.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to read (relative or absolute)',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description:
        'Edit a file using exact text replacement. Every edits[].oldText must match a unique, ' +
        'non-overlapping region of the original file. If two changes affect the same block or ' +
        'nearby lines, merge them into one edit. Do not include large unchanged regions.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to edit (relative or absolute)',
          },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                oldText: {
                  type: 'string',
                  description: 'Exact text to replace (must be unique in file)',
                },
                newText: {
                  type: 'string',
                  description: 'Replacement text',
                },
              },
              required: ['oldText', 'newText'],
            },
            description: 'One or more targeted replacements',
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description:
        'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. ' +
        'Automatically creates parent directories.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write (relative or absolute)',
          },
          content: {
            type: 'string',
            description: 'Content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description:
        'List directory contents. Shows files and directories with sizes, sorted (dirs first, then files alphabetically).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory to list (defaults to working directory)',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find',
      description:
        'Find files by name. Supports fuzzy matching (e.g. "agentloop" matches "agent-loop.ts") ' +
        'and glob patterns (e.g. "*.ts"). Skips hidden dirs and common large directories ' +
        '(node_modules, .git, dist, etc.).',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Search query (fuzzy or glob like *.ts)',
          },
          path: {
            type: 'string',
            description: 'Directory to search in (defaults to working directory)',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stat',
      description:
        'Get file or directory metadata. Returns size, line count (for text files), ' +
        'modification time, and whether the file is binary. Use before reading large files ' +
        'to decide if chunking with offset/limit is needed.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file or directory (relative or absolute)',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff',
      description:
        'Show a git diff of changes. Useful for reviewing what changed before committing. ' +
        'Supports --staged for staged changes, and optional path/file and base ref.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Specific file or directory to diff (optional — diffs everything if omitted)',
          },
          staged: {
            type: 'boolean',
            description: 'Show staged changes (git diff --staged). Default: false (working tree)',
          },
          base: {
            type: 'string',
            description: 'Base ref to diff against (e.g. HEAD~1, main). Default: HEAD for staged, working tree otherwise',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents with regex. Returns matching file paths with line numbers and content. ' +
        'Skips binary files and files over 500KB.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for',
          },
          path: {
            type: 'string',
            description: 'Directory or file to search in (defaults to working directory)',
          },
          include: {
            type: 'string',
            description: 'File glob filter (e.g. *.ts)',
          },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for information. Uses DuckDuckGo (free, no API key needed). ' +
        'Returns relevant results including abstracts, answers, related topics, and web links. ' +
        'Use this for general knowledge, news, current events, or broad information not found locally.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query string',
          },
          count: {
            type: 'number',
            description: 'Maximum number of results to return (default 5, max 10)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docs',
      description:
        'Search library, framework, and API documentation. Uses DuckDuckGo site-targeted ' +
        'queries to search official documentation sources (MDN, Node.js docs, npm packages, ' +
        'Rust docs, Python docs, Go docs, etc.). Free — no API key needed. ' +
        'Use this for API signatures, method references, configuration options, ' +
        'package usage examples, or any programming documentation lookup.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Documentation search query (e.g. "fs.readFile options", "React useEffect cleanup")',
          },
          library: {
            type: 'string',
            description: 'Optional library/package name to narrow search (e.g. "react", "typescript", "express")',
          },
          count: {
            type: 'number',
            description: 'Maximum results (default 5, max 8)',
          },
        },
        required: ['query'],
      },
    },
  },
];

// ── Tool implementations ────────────────────────────────────────────

const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB

/** Truncation result with metadata for the agent to continue reading. */
interface TruncateResult {
  text: string;
  totalLines: number;
  totalBytes: number;
  linesShown: number;
  truncated: boolean;
}

function truncateOutput(text: string): TruncateResult {
  const lines = text.split('\n');
  const byteLen = Buffer.byteLength(text, 'utf-8');
  const totalLines = lines.length;
  const totalBytes = byteLen;

  if (lines.length <= MAX_OUTPUT_LINES && byteLen <= MAX_OUTPUT_BYTES) {
    return { text, totalLines, totalBytes, linesShown: totalLines, truncated: false };
  }

  let truncated = '';
  if (lines.length > MAX_OUTPUT_LINES) {
    truncated = lines.slice(0, MAX_OUTPUT_LINES).join('\n');
  } else {
    truncated = text;
  }

  if (Buffer.byteLength(truncated, 'utf-8') > MAX_OUTPUT_BYTES) {
    const buf = Buffer.from(truncated, 'utf-8');
    truncated = buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf-8');
  }

  const linesShown = truncated.split('\n').length;

  // Help the agent continue: tell it what to do next
  truncated += `\n\n[Showing ${linesShown}/${totalLines} lines, ${Buffer.byteLength(truncated, 'utf-8')}/${totalBytes} bytes.`;
  if (totalLines > linesShown) {
    truncated += ` Continue with offset=${linesShown + 1}.`;
  }
  truncated += ']';

  return { text: truncated, totalLines, totalBytes, linesShown, truncated: true };
}

async function execBash(command: string, workDir: string, timeoutSec?: number): Promise<string> {
  // Security check before executing
  const blocked = checkDangerousCommand(command);
  if (blocked) return blocked;

  const timeout = Math.min(timeoutSec ?? 120, 300) * 1000;

  return new Promise<string>((resolve) => {
    const child = exec(
      command,
      {
        cwd: workDir,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout,
        shell: '/bin/bash',
      } as ExecOptions,
      (error, stdout, stderr) => {
        let result = '';
        const outStr = typeof stdout === 'string' ? stdout : stdout?.toString() ?? '';
        const errStr = typeof stderr === 'string' ? stderr : stderr?.toString() ?? '';
        const exitCode = error ? (error as any).code ?? 1 : 0;
        if (outStr.trim()) result += outStr.trim();
        if (errStr.trim()) {
          if (result) result += '\n';
          result += errStr.trim();
        }
        if (error && !result) {
          result = error.message;
        }
        const truncated = truncateOutput(result || '(no output)');
        // Append exit code so the agent knows whether the command succeeded
        const suffix = exitCode !== 0 ? `\n[exit code: ${exitCode}]` : '';
        resolve(truncated.text + suffix);
      },
    );
  });
}

async function readFileTool(
  path: string,
  workDir: string,
  offset?: number,
  limit?: number,
): Promise<string> {
  let fullPath: string;
  try {
    fullPath = safeResolve(workDir, path);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }

  try {
    await access(fullPath, constants.R_OK);
  } catch {
    return `Error: [file-not-found] ${fullPath} does not exist or is not readable.`;
  }

  const content = await readFile(fullPath, 'utf-8');
  const allLines = content.split('\n');
  const totalLines = allLines.length;
  const totalBytes = Buffer.byteLength(content, 'utf-8');

  const start = offset ? offset - 1 : 0;
  const end = limit ? start + limit : undefined;

  const sliced = allLines.slice(start, end);
  let result = sliced.join('\n');
  if (result.length === 0 && content.length > 0) {
    result = content;
  }

  const truncated = truncateOutput(result);

  // Include total file metadata so the agent knows if more is available
  const range = offset || limit
    ? ` (offset=${offset ?? 1}, limit=${limit ?? 'none'})`
    : '';
  const header = `[${fullPath}: ${totalLines} lines, ${totalBytes} bytes total${range}]\n`;

  return header + truncated.text;
}

/** Build a compact diff summary: lines changed, chars added/removed. */
function diffSummary(before: string, after: string): string {
  const beforeLines = before.split('\n').length;
  const afterLines = after.split('\n').length;
  const beforeBytes = Buffer.byteLength(before, 'utf-8');
  const afterBytes = Buffer.byteLength(after, 'utf-8');
  const deltaLines = afterLines - beforeLines;
  const deltaBytes = afterBytes - beforeBytes;
  const linePart = deltaLines >= 0 ? `+${deltaLines}` : `${deltaLines}`;
  const bytePart = deltaBytes >= 0 ? `+${deltaBytes}B` : `${deltaBytes}B`;
  return `(${linePart} lines, ${bytePart})`;
}

async function editFileTool(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
  workDir: string,
): Promise<string> {
  let fullPath: string;
  try {
    fullPath = safeResolve(workDir, path);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }

  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch {
    if (edits.length === 1 && edits[0].oldText === '') {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, edits[0].newText, 'utf-8');
      return `Created new file: ${fullPath} (${edits[0].newText.split('\n').length} lines, ${Buffer.byteLength(edits[0].newText, 'utf-8')}B)`;
    }
    return `Error: [file-not-found] ${fullPath} does not exist. Use write to create a new file, or stat to check the path.`;
  }

  let modified = content;
  const errors: string[] = [];
  const diffs: string[] = [];

  for (let ei = 0; ei < edits.length; ei++) {
    const edit = edits[ei];
    const { oldText, newText } = edit;

    if (oldText === '') {
      errors.push(`Edit #${ei + 1}: empty oldText — use write tool for new files`);
      continue;
    }

    const count = modified.split(oldText).length - 1;
    if (count === 0) {
      errors.push(`Edit #${ei + 1}: oldText not found. Try grep to locate it, or read the file to verify exact whitespace.`);
      continue;
    }
    if (count > 1) {
      errors.push(`Edit #${ei + 1}: oldText matches ${count} times — must be unique. Add more surrounding context to disambiguate.`);
      continue;
    }

    modified = modified.replace(oldText, newText);
    diffs.push(`Edit #${ei + 1}: ${diffSummary(oldText, newText)}`);
  }

  if (errors.length > 0 && modified === content) {
    return `Edit failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`;
  }

  await writeFile(fullPath, modified, 'utf-8');

  const parts: string[] = [];
  parts.push(`Edited: ${fullPath}`);
  if (diffs.length > 0) parts.push(`  ${diffs.join('\n  ')}`);
  if (errors.length > 0) {
    parts.push(`Warnings:`);
    parts.push(...errors.map((e) => `  - ${e}`));
  }

  return parts.join('\n');
}

async function writeFileTool(path: string, content: string, workDir: string): Promise<string> {
  let fullPath: string;
  try {
    fullPath = safeResolve(workDir, path);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
  return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${fullPath}`;
}

// ── New tools: ls, find, grep ──────────────────────────────────────

async function lsTool(path: string | undefined, workDir: string): Promise<string> {
  let dir: string;
  try {
    dir = safeResolve(workDir, path || '.');
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
  const { readdir, stat } = await import('fs/promises');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length === 0) return `(empty directory: ${dir})`;

    // Get sizes and sort: dirs first, then files alphabetically
    const withMeta = await Promise.all(
      entries.map(async (e) => {
        const full = resolve(dir, e.name);
        let size = '';
        try {
          const s = await stat(full);
          if (s.isFile()) {
            const kb = s.size / 1024;
            size = kb >= 1000 ? `${(kb / 1024).toFixed(1)}M` : kb >= 1 ? `${kb.toFixed(0)}K` : `${s.size}B`;
          }
        } catch { /* skip */ }
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size,
        };
      }),
    );

    withMeta.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const lines = withMeta.map((e) => {
      const type = e.isDir ? '/' : '';
      const sizeStr = e.size ? ` (${e.size})` : '';
      return `${e.name}${type}${sizeStr}`;
    });

    return truncateOutput(`${dir}:\n${lines.join('\n')}`).text;
  } catch (err: any) {
    return `Error listing ${dir}: ${err.message}`;
  }
}

async function findTool(
  pattern: string,
  searchPath: string | undefined,
  workDir: string,
): Promise<string> {
  let base: string;
  try {
    base = safeResolve(workDir, searchPath || '.');
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv',
    '.next', '.cache', 'coverage', '.convex', '_generated',
  ]);

  // Detect if pattern looks like a glob
  const isGlob = /[*?[\]{}]/.test(pattern);

  const results: string[] = [];
  const MAX_RESULTS = 200;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || results.length >= MAX_RESULTS) return;
    let entries;
    try {
      const { readdir } = await import('fs/promises');
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_RESULTS) break;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(resolve(dir, e.name), depth + 1);
      } else {
        if (isGlob) {
          // Simple glob matching
          const regex = new RegExp(
            '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
          );
          if (regex.test(e.name)) {
            results.push(resolve(dir, e.name).replace(base + '/', ''));
          }
        } else {
          // Fuzzy matching: all pattern chars appear in order in filename
          const lower = e.name.toLowerCase();
          const pat = pattern.toLowerCase();
          let pi = 0;
          for (let i = 0; i < lower.length && pi < pat.length; i++) {
            if (lower[i] === pat[pi]) pi++;
          }
          if (pi === pat.length) {
            results.push(resolve(dir, e.name).replace(base + '/', ''));
          }
        }
      }
    }
  }

  try {
    await walk(base, 0);
  } catch (err: any) {
    return `Error finding files: ${err.message}`;
  }

  if (results.length === 0) return `No files matching "${pattern}" found.`;
  return truncateOutput(
    `Found ${results.length} file${results.length !== 1 ? 's' : ''} matching "${pattern}":\n${results.join('\n')}`,
  ).text;
}

async function grepTool(
  pattern: string,
  searchPath: string | undefined,
  include: string | undefined,
  workDir: string,
): Promise<string> {
  let base: string;
  try {
    base = safeResolve(workDir, searchPath || '.');
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv',
    '.next', '.cache', '.convex', '_generated',
  ]);
  const MAX_FILE_SIZE = 500 * 1024;
  const MAX_MATCHES = 100;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'gi');
  } catch (err: any) {
    return `Error: Invalid regex pattern: ${err.message}`;
  }

  const results: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || results.length >= MAX_MATCHES) return;
    let entries;
    try {
      const { readdir, stat } = await import('fs/promises');
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_MATCHES) break;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else {
        // Include filter
        if (include) {
          const incRegex = new RegExp(
            '^' + include.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
          );
          if (!incRegex.test(e.name)) continue;
        }
        // Size check
        try {
          const { stat } = await import('fs/promises');
          const s = await stat(full);
          if (s.size > MAX_FILE_SIZE) continue;
        } catch {
          continue;
        }
        // Read and search
        try {
          const content = await readFile(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < MAX_MATCHES; i++) {
            if (regex.test(lines[i])) {
              regex.lastIndex = 0;
              const relPath = full.replace(base + '/', '');
              results.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
            }
          }
        } catch {
          // Skip binary/unreadable files
        }
      }
    }
  }

  try {
    const s = await (await import('fs/promises')).stat(base);
    if (s.isFile()) {
      // Single file mode
      const content = await readFile(base, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < MAX_MATCHES; i++) {
        if (regex.test(lines[i])) {
          regex.lastIndex = 0;
          results.push(`L${i + 1}: ${lines[i].trim().slice(0, 120)}`);
        }
      }
    } else {
      await walk(base, 0);
    }
  } catch (err: any) {
    return `Error searching: ${err.message}`;
  }

  if (results.length === 0) return `No matches for "${pattern}" found.`;
  return truncateOutput(
    `${results.length} match${results.length !== 1 ? 'es' : ''} for "${pattern}":\n${results.join('\n')}`,
  ).text;
}

// ── Stat tool ───────────────────────────────────────────────────────

async function statTool(path: string, workDir: string): Promise<string> {
  let fullPath: string;
  try {
    fullPath = safeResolve(workDir, path);
  } catch (err: any) {
    return `Error: ${err.message}`;
  }
  try {
    const s = await fsStat(fullPath);
    const parts: string[] = [`${fullPath}:`];
    if (s.isDirectory()) {
      parts.push(`  type: directory`);
      parts.push(`  modified: ${s.mtime.toISOString()}`);
      return parts.join('\n');
    }
    if (s.isFile()) {
      const sizeBytes = s.size;
      const sizeStr = sizeBytes >= 1024 * 1024
        ? `${(sizeBytes / (1024 * 1024)).toFixed(1)}MB`
        : sizeBytes >= 1024
          ? `${(sizeBytes / 1024).toFixed(1)}KB`
          : `${sizeBytes}B`;
      parts.push(`  size: ${sizeBytes} (${sizeStr})`);
      parts.push(`  modified: ${s.mtime.toISOString()}`);
      // Try to count lines for text files
      try {
        const content = await readFile(fullPath, 'utf-8');
        // Check binary heuristic
        const sample = content.slice(0, 4096);
        if (sample.includes('\x00')) {
          parts.push(`  binary: yes`);
        } else {
          const lineCount = content.split('\n').length;
          parts.push(`  lines: ${lineCount}`);
          parts.push(`  binary: no`);
          // Hint for read tool
          if (lineCount > 2000 || sizeBytes > 50 * 1024) {
            parts.push(`  hint: large file — use read with offset/limit to chunk`);
          }
        }
      } catch {
        parts.push(`  binary: yes (unreadable as text)`);
      }
      return parts.join('\n');
    }
    parts.push(`  type: other`);
    return parts.join('\n');
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return `[not-found] ${fullPath} does not exist.`;
    }
    return `Error: [stat-failed] ${fullPath}: ${err.message}`;
  }
}

// ── Diff tool ───────────────────────────────────────────────────────

async function diffTool(
  path: string | undefined,
  staged: boolean | undefined,
  base: string | undefined,
  workDir: string,
): Promise<string> {
  const args: string[] = ['diff'];
  if (staged) args.push('--staged');
  if (base) args.push(base);
  if (path) args.push('--', path);
  else args.push('--', '.');

  return execBash(`git ${args.join(' ')}`, workDir, 30);
}

// ── Web search tool ─────────────────────────────────────────────────

interface DDGResponse {
  Abstract?: string;
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  Answer?: string;
  AnswerType?: string;
  Definition?: string;
  DefinitionSource?: string;
  Heading?: string;
  RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
  Results?: Array<{ Text?: string; FirstURL?: string }>;
  Infobox?: {
    content?: Array<{ label?: string; value?: string; data_type?: string }>;
    meta?: Array<{ label?: string; value?: string }>;
  };
}

function httpsGetJSON(url: string, timeout = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, { timeout }, (res) => {
      // Follow redirects (up to 3)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGetJSON(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.length > 500_000) {
          res.destroy();
          reject(new Error('Response too large'));
        }
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse JSON (status ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

async function webSearchTool(query: string, count?: number): Promise<string> {
  const maxResults = Math.min(Math.max(count ?? 5, 1), 10);
  const encoded = encodeURIComponent(query);
  const ddgUrl = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;

  let json: DDGResponse;
  try {
    json = await httpsGetJSON(ddgUrl, 10000) as DDGResponse;
  } catch (err: any) {
    return `Error: Web search failed — ${err.message || err}`;
  }

  const parts: string[] = [];

  // Heading
  if (json.Heading && json.Heading !== query) {
    parts.push(`Topic: ${json.Heading}`);
  }

  // Direct answer (calculator, weather, etc.)
  if (json.Answer) {
    parts.push(`Answer: ${json.Answer}`);
  }

  // Abstract/summary
  if (json.AbstractText && json.AbstractText.trim()) {
    let abstract = json.AbstractText.trim();
    if (json.AbstractSource) {
      abstract += ` [Source: ${json.AbstractSource}]`;
    }
    if (json.AbstractURL) {
      abstract += ` — ${json.AbstractURL}`;
    }
    parts.push(`Summary: ${abstract}`);
  } else if (json.Abstract && json.Abstract.trim()) {
    parts.push(`Summary: ${json.Abstract.trim()}`);
  }

  // Definition
  if (json.Definition) {
    let def = `Definition: ${json.Definition}`;
    if (json.DefinitionSource) def += ` [Source: ${json.DefinitionSource}]`;
    parts.push(def);
  }

  // Infobox (structured data)
  if (json.Infobox?.content) {
    const fields = json.Infobox.content
      .filter((c) => c.label && c.value)
      .map((c) => `  ${c.label}: ${c.value}`)
      .slice(0, 8);
    if (fields.length > 0) {
      parts.push(`Details:\n${fields.join('\n')}`);
    }
  }

  // Related topics
  if (json.RelatedTopics && json.RelatedTopics.length > 0) {
    const topics: string[] = [];
    for (const t of json.RelatedTopics) {
      if (topics.length >= maxResults) break;
      if (t.Text && t.FirstURL) {
        // Extract title from the Text field (often "Title — Description" format)
        const cleanText = t.Text.replace(/<[^>]+>/g, '').trim();
        topics.push(`  - ${cleanText.slice(0, 200)}\n    ${t.FirstURL}`);
      } else if (t.Text) {
        topics.push(`  - ${t.Text.replace(/<[^>]+>/g, '').trim().slice(0, 200)}`);
      }
    }
    if (topics.length > 0) {
      parts.push(`Related:\n${topics.join('\n')}`);
    }
  }

  // Web results (sometimes included)
  if (json.Results && json.Results.length > 0) {
    const results: string[] = [];
    for (const r of json.Results) {
      if (results.length >= maxResults) break;
      if (r.Text && r.FirstURL) {
        results.push(`  - ${r.Text.replace(/<[^>]+>/g, '').trim().slice(0, 200)}\n    ${r.FirstURL}`);
      }
    }
    if (results.length > 0) {
      parts.push(`Web Results:\n${results.join('\n')}`);
    }
  }

  if (parts.length === 0) {
    return `No results found for "${query}". Try different keywords or be more specific.`;
  }

  return truncateOutput(parts.join('\n\n')).text;
}

// ── Documentation search ────────────────────────────────────────────

/**
 * Known documentation domains — DuckDuckGo site:-scoped searches.
 * Each entry maps a library pattern to site: domains that have official docs.
 */
const KNOWN_DOC_SITES: Array<{ patterns: string[]; sites: string[] }> = [
  // JavaScript/TypeScript ecosystem
  { patterns: ['node', 'nodejs', 'node.js'], sites: ['nodejs.org', 'nodejs.dev'] },
  { patterns: ['javascript', 'js', 'mozilla', 'mdn'], sites: ['developer.mozilla.org'] },
  { patterns: ['typescript', 'ts'], sites: ['typescriptlang.org'] },
  { patterns: ['react', 'reactjs', 'react.js'], sites: ['react.dev', 'reactjs.org', 'legacy.reactjs.org'] },
  { patterns: ['express', 'expressjs', 'express.js'], sites: ['expressjs.com'] },
  { patterns: ['next', 'nextjs', 'next.js'], sites: ['nextjs.org'] },
  { patterns: ['vue', 'vuejs', 'vue.js'], sites: ['vuejs.org'] },
  { patterns: ['svelte', 'sveltekit'], sites: ['svelte.dev', 'kit.svelte.dev'] },
  { patterns: ['tailwind', 'tailwindcss'], sites: ['tailwindcss.com'] },
  { patterns: ['prisma'], sites: ['prisma.io'] },
  { patterns: ['vite'], sites: ['vitejs.dev'] },
  { patterns: ['esbuild'], sites: ['esbuild.github.io'] },
  { patterns: ['webpack'], sites: ['webpack.js.org'] },
  { patterns: ['babel'], sites: ['babeljs.io'] },
  { patterns: ['eslint'], sites: ['eslint.org'] },
  { patterns: ['prettier'], sites: ['prettier.io'] },
  { patterns: ['jest'], sites: ['jestjs.io'] },
  { patterns: ['vitest'], sites: ['vitest.dev'] },
  { patterns: ['playwright'], sites: ['playwright.dev'] },
  { patterns: ['cypress'], sites: ['cypress.io', 'docs.cypress.io'] },
  { patterns: ['graphql'], sites: ['graphql.org'] },
  { patterns: ['apollo'], sites: ['apollographql.com'] },
  { patterns: ['trpc'], sites: ['trpc.io'] },
  { patterns: ['zod'], sites: ['github.com/colinhacks/zod', 'zod.dev'] },
  { patterns: ['axios'], sites: ['axios-http.com'] },
  { patterns: ['npm'], sites: ['npmjs.com', 'docs.npmjs.com'] },
  { patterns: ['pnpm'], sites: ['pnpm.io'] },
  { patterns: ['yarn'], sites: ['yarnpkg.com'] },
  { patterns: ['deno'], sites: ['deno.com', 'deno.land', 'docs.deno.com'] },
  { patterns: ['bun'], sites: ['bun.sh'] },
  // Python
  { patterns: ['python', 'py'], sites: ['docs.python.org'] },
  { patterns: ['django'], sites: ['djangoproject.com', 'docs.djangoproject.com'] },
  { patterns: ['flask'], sites: ['flask.palletsprojects.com'] },
  { patterns: ['fastapi'], sites: ['fastapi.tiangolo.com'] },
  { patterns: ['pydantic'], sites: ['docs.pydantic.dev'] },
  { patterns: ['pytest'], sites: ['docs.pytest.org'] },
  { patterns: ['poetry'], sites: ['python-poetry.org'] },
  { patterns: ['numpy'], sites: ['numpy.org'] },
  { patterns: ['pandas'], sites: ['pandas.pydata.org'] },
  { patterns: ['sqlalchemy'], sites: ['docs.sqlalchemy.org'] },
  { patterns: ['alembic'], sites: ['alembic.sqlalchemy.org'] },
  // Rust
  { patterns: ['rust', 'cargo', 'rustc'], sites: ['doc.rust-lang.org', 'docs.rs'] },
  { patterns: ['tokio'], sites: ['docs.rs/tokio', 'tokio.rs'] },
  { patterns: ['serde'], sites: ['docs.rs/serde', 'serde.rs'] },
  { patterns: ['actix'], sites: ['actix.rs', 'docs.rs/actix-web'] },
  { patterns: ['axum'], sites: ['docs.rs/axum'] },
  { patterns: ['bevy'], sites: ['bevyengine.org', 'docs.rs/bevy'] },
  // Go
  { patterns: ['go', 'golang'], sites: ['pkg.go.dev', 'go.dev'] },
  { patterns: ['gin'], sites: ['gin-gonic.com', 'pkg.go.dev/github.com/gin-gonic'] },
  { patterns: ['echo'], sites: ['echo.labstack.com', 'pkg.go.dev/github.com/labstack/echo'] },
  { patterns: ['fiber'], sites: ['docs.gofiber.io', 'pkg.go.dev/github.com/gofiber/fiber'] },
  // Ruby
  { patterns: ['ruby', 'rubygems'], sites: ['ruby-doc.org', 'rubygems.org'] },
  { patterns: ['rails', 'ruby on rails'], sites: ['guides.rubyonrails.org', 'api.rubyonrails.org'] },
  { patterns: ['rspec'], sites: ['rspec.info', 'rubydoc.info'] },
  // Other
  { patterns: ['linux', 'man'], sites: ['man7.org', 'linux.die.net'] },
  { patterns: ['git'], sites: ['git-scm.com'] },
  { patterns: ['docker'], sites: ['docs.docker.com'] },
  { patterns: ['kubernetes', 'k8s'], sites: ['kubernetes.io'] },
  { patterns: ['nginx'], sites: ['nginx.org', 'nginx.com'] },
  { patterns: ['postgresql', 'postgres', 'pg'], sites: ['postgresql.org'] },
  { patterns: ['mysql'], sites: ['dev.mysql.com'] },
  { patterns: ['redis'], sites: ['redis.io'] },
  { patterns: ['mongodb', 'mongo'], sites: ['mongodb.com', 'docs.mongodb.com'] },
  { patterns: ['sqlite'], sites: ['sqlite.org'] },
  { patterns: ['aws'], sites: ['docs.aws.amazon.com'] },
  // Add more as needed — this list guides the agent to official docs
];

/** Resolve site: targets for a library name or query */
function resolveDocSites(query: string, library?: string): string[] {
  const searchTerms = (library ? `${library} ${query}` : query).toLowerCase();
  const sites: string[] = [];

  for (const entry of KNOWN_DOC_SITES) {
    for (const pat of entry.patterns) {
      if (searchTerms.includes(pat) && !sites.some((s) => entry.sites.includes(s))) {
        sites.push(...entry.sites);
        break;
      }
    }
  }

  return sites;
}

async function docsSearchTool(
  query: string,
  library?: string,
  count?: number,
  useSites = true,
): Promise<string> {
  const maxResults = Math.min(Math.max(count ?? 5, 1), 8);
  const sites = useSites ? resolveDocSites(query, library) : [];

  // Build query
  let searchQuery: string;
  if (library) {
    searchQuery = `${library} ${query}`;
  } else {
    searchQuery = query;
  }

  // If we have known doc sites, prioritize them with site: scoping
  if (sites.length > 0) {
    const siteFilters = sites.map((s) => `site:${s}`).join(' OR ');
    searchQuery = `${searchQuery} (${siteFilters})`;
  } else {
    // Generic doc search — append "documentation" to bias results
    searchQuery = `${searchQuery} documentation`;
  }

  const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(searchQuery)}&format=json&no_html=1&skip_disambig=1`;

  let json: DDGResponse;
  try {
    json = await httpsGetJSON(ddgUrl, 10000) as DDGResponse;
  } catch (err: any) {
    return `Error: Docs search failed — ${err.message || err}`;
  }

  const parts: string[] = [];
  const headerParts: string[] = [];
  if (library) headerParts.push(`Library: ${library}`);
  if (sites.length > 0) headerParts.push(`Sources: ${sites.join(', ')}`);
  if (headerParts.length > 0) {
    parts.push(headerParts.join(' | '));
  }

  // Direct answer
  if (json.Answer) {
    parts.push(`Answer: ${json.Answer}`);
  }

  // Abstract
  if (json.AbstractText && json.AbstractText.trim()) {
    const abstract = json.AbstractText.trim();
    const source = json.AbstractSource ? ` [${json.AbstractSource}]` : '';
    const url = json.AbstractURL ? ` — ${json.AbstractURL}` : '';
    parts.push(`Summary: ${abstract}${source}${url}`);
  } else if (json.Abstract && json.Abstract.trim()) {
    parts.push(`Summary: ${json.Abstract.trim()}`);
  }

  // Definition
  if (json.Definition) {
    let def = `Definition: ${json.Definition}`;
    if (json.DefinitionSource) def += ` [Source: ${json.DefinitionSource}]`;
    parts.push(def);
  }

  // Related topics — primary results
  if (json.RelatedTopics && json.RelatedTopics.length > 0) {
    const topics: string[] = [];
    for (const t of json.RelatedTopics) {
      if (topics.length >= maxResults) break;
      if (t.Text && t.FirstURL) {
        const cleanText = t.Text.replace(/<[^>]+>/g, '').trim();
        topics.push(`  - ${cleanText.slice(0, 250)}\n    ${t.FirstURL}`);
      } else if (t.Text) {
        topics.push(`  - ${t.Text.replace(/<[^>]+>/g, '').trim().slice(0, 250)}`);
      }
    }
    if (topics.length > 0) {
      parts.push(`Documentation Results:\n${topics.join('\n')}`);
    }
  }

  // Web results
  if (json.Results && json.Results.length > 0) {
    const results: string[] = [];
    for (const r of json.Results) {
      if (results.length >= maxResults) break;
      if (r.Text && r.FirstURL) {
        results.push(`  - ${r.Text.replace(/<[^>]+>/g, '').trim().slice(0, 200)}\n    ${r.FirstURL}`);
      }
    }
    if (results.length > 0) {
      parts.push(`More:\n${results.join('\n')}`);
    }
  }

  // Header-only means no content — fall back to broad search without site: scoping
  const hasContent = parts.length > (headerParts.length > 0 ? 1 : 0);
  if (!hasContent && sites.length > 0) {
    return docsSearchTool(query, library, count, false);
  }

  if (!hasContent) {
    return `No documentation results for "${query}". Try different terms or use web_search for broader results.`;
  }

  return truncateOutput(parts.join('\n\n')).text;
}

// ── Tool dispatcher ─────────────────────────────────────────────────

export async function executeTool(
  call: ToolCall,
  workDir: string,
): Promise<ToolResult> {
  const { id, function: fn } = call;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(fn.arguments);
  } catch {
    return {
      tool_call_id: id,
      role: 'tool',
      content: `Error: Invalid JSON arguments: ${fn.arguments}`,
    };
  }

  let result: string;

  // ── Input validation ──────────────────────────────────────────
  try {
    switch (fn.name) {
      case 'bash':
        if (typeof args.command !== 'string' || args.command.length === 0) throw new Error('bash requires a non-empty "command" (string)');
        if (args.timeout !== undefined && typeof args.timeout !== 'number') throw new Error('bash "timeout" must be a number');
        break;
      case 'read':
        if (typeof args.path !== 'string' || args.path.length === 0) throw new Error('read requires a non-empty "path" (string)');
        if (args.offset !== undefined && typeof args.offset !== 'number') throw new Error('read "offset" must be a number');
        if (args.limit !== undefined && typeof args.limit !== 'number') throw new Error('read "limit" must be a number');
        break;
      case 'edit':
        if (typeof args.path !== 'string' || args.path.length === 0) throw new Error('edit requires a non-empty "path" (string)');
        if (!Array.isArray(args.edits)) throw new Error('edit "edits" must be an array');
        if (args.edits.length === 0) throw new Error('edit "edits" must be non-empty');
        for (let i = 0; i < args.edits.length; i++) {
          const e = args.edits[i];
          if (typeof e.oldText !== 'string') throw new Error(`edit "edits[${i}].oldText" must be a string`);
          if (typeof e.newText !== 'string') throw new Error(`edit "edits[${i}].newText" must be a string`);
        }
        break;
      case 'write':
        if (typeof args.path !== 'string' || args.path.length === 0) throw new Error('write requires a non-empty "path" (string)');
        if (typeof args.content !== 'string') throw new Error('write requires "content" (string)');
        break;
      case 'find':
        if (typeof args.pattern !== 'string' || args.pattern.length === 0) throw new Error('find requires a non-empty "pattern" (string)');
        if (args.path !== undefined && typeof args.path !== 'string') throw new Error('find "path" must be a string');
        break;
      case 'grep':
        if (typeof args.pattern !== 'string' || args.pattern.length === 0) throw new Error('grep requires a non-empty "pattern" (string)');
        if (args.path !== undefined && typeof args.path !== 'string') throw new Error('grep "path" must be a string');
        if (args.include !== undefined && typeof args.include !== 'string') throw new Error('grep "include" must be a string');
        break;
      case 'stat':
        if (typeof args.path !== 'string' || args.path.length === 0) throw new Error('stat requires a non-empty "path" (string)');
        break;
      case 'web_search':
        if (typeof args.query !== 'string' || args.query.length === 0) throw new Error('web_search requires a non-empty "query" (string)');
        if (args.count !== undefined && typeof args.count !== 'number') throw new Error('web_search "count" must be a number');
        break;
      case 'docs':
        if (typeof args.query !== 'string' || args.query.length === 0) throw new Error('docs requires a non-empty "query" (string)');
        if (args.count !== undefined && typeof args.count !== 'number') throw new Error('docs "count" must be a number');
        if (args.library !== undefined && typeof args.library !== 'string') throw new Error('docs "library" must be a string');
        break;
      // ls and diff have no required arguments — no validation needed
    }
  } catch (validationErr: any) {
    return {
      tool_call_id: id,
      role: 'tool',
      content: `Error: ${validationErr.message}`,
    };
  }

  try {
    switch (fn.name) {
      case 'bash':
        result = await execBash(args.command as string, workDir, args.timeout as number | undefined);
        break;
      case 'read':
        result = await readFileTool(
          args.path as string,
          workDir,
          args.offset as number | undefined,
          args.limit as number | undefined,
        );
        break;
      case 'edit':
        result = await editFileTool(
          args.path as string,
          args.edits as Array<{ oldText: string; newText: string }>,
          workDir,
        );
        break;
      case 'write':
        result = await writeFileTool(args.path as string, args.content as string, workDir);
        break;
      case 'ls':
        result = await lsTool(args.path as string | undefined, workDir);
        break;
      case 'find':
        result = await findTool(args.pattern as string, args.path as string | undefined, workDir);
        break;
      case 'diff':
        result = await diffTool(
          args.path as string | undefined,
          args.staged as boolean | undefined,
          args.base as string | undefined,
          workDir,
        );
        break;
      case 'grep':
        result = await grepTool(
          args.pattern as string,
          args.path as string | undefined,
          args.include as string | undefined,
          workDir,
        );
        break;
      case 'stat':
        result = await statTool(args.path as string, workDir);
        break;
      case 'web_search':
        result = await webSearchTool(
          args.query as string,
          args.count as number | undefined,
        );
        break;
      case 'docs':
        result = await docsSearchTool(
          args.query as string,
          args.library as string | undefined,
          args.count as number | undefined,
        );
        break;
      default:
        result = `Error: Unknown tool: ${fn.name}`;
    }
  } catch (err: unknown) {
    result = `Error executing ${fn.name}: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    tool_call_id: id,
    role: 'tool',
    content: result,
  };
}
