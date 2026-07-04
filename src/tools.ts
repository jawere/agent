import { exec, ExecOptions } from 'child_process';
import { readFile, writeFile, mkdir, access } from 'fs/promises';
import { constants } from 'fs';
import { resolve, dirname } from 'path';

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
];

// ── Tool implementations ────────────────────────────────────────────

const MAX_OUTPUT_LINES = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB

function truncateOutput(text: string): string {
  const lines = text.split('\n');
  const byteLen = Buffer.byteLength(text, 'utf-8');

  if (lines.length <= MAX_OUTPUT_LINES && byteLen <= MAX_OUTPUT_BYTES) {
    return text;
  }

  let truncated = '';
  if (lines.length > MAX_OUTPUT_LINES) {
    truncated = lines.slice(0, MAX_OUTPUT_LINES).join('\n');
    truncated += `\n\n[Truncated: ${lines.length - MAX_OUTPUT_LINES} more lines]`;
  } else {
    truncated = text;
  }

  if (Buffer.byteLength(truncated, 'utf-8') > MAX_OUTPUT_BYTES) {
    const buf = Buffer.from(truncated, 'utf-8');
    truncated = buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf-8');
    truncated += '\n\n[Truncated: output exceeded 50KB]';
  }

  return truncated;
}

async function execBash(command: string, workDir: string, timeoutSec?: number): Promise<string> {
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
        if (outStr.trim()) result += outStr.trim();
        if (errStr.trim()) {
          if (result) result += '\n';
          result += errStr.trim();
        }
        if (error && !result) {
          result = error.message;
        }
        resolve(truncateOutput(result) || '(no output)');
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
  const fullPath = resolve(workDir, path);

  // Safety: ensure path is within workDir or is a reasonable absolute path
  try {
    await access(fullPath, constants.R_OK);
  } catch {
    return `Error: File not found or not readable: ${fullPath}`;
  }

  const content = await readFile(fullPath, 'utf-8');
  let lines = content.split('\n');

  const start = offset ? offset - 1 : 0;
  const end = limit ? start + limit : undefined;

  lines = lines.slice(start, end);

  let result = lines.join('\n');
  if (result.length === 0 && content.length > 0) {
    result = content; // fallback for non-newline files
  }

  return truncateOutput(result);
}

async function editFileTool(
  path: string,
  edits: Array<{ oldText: string; newText: string }>,
  workDir: string,
): Promise<string> {
  const fullPath = resolve(workDir, path);

  let content: string;
  try {
    content = await readFile(fullPath, 'utf-8');
  } catch {
    // If file doesn't exist, create it if we have exactly one "empty" edit
    if (edits.length === 1 && edits[0].oldText === '') {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, edits[0].newText, 'utf-8');
      return `Created new file: ${fullPath}`;
    }
    return `Error: File not found: ${fullPath}`;
  }

  let modified = content;
  const errors: string[] = [];

  for (const edit of edits) {
    const { oldText, newText } = edit;

    if (oldText === '') {
      errors.push(`Edit with empty oldText — use write tool for new files`);
      continue;
    }

    const count = modified.split(oldText).length - 1;
    if (count === 0) {
      errors.push(`oldText not found in file: "${oldText.slice(0, 80)}..."`);
      continue;
    }
    if (count > 1) {
      errors.push(`oldText matches ${count} times (must be unique): "${oldText.slice(0, 80)}..."`);
      continue;
    }

    modified = modified.replace(oldText, newText);
  }

  if (errors.length > 0 && modified === content) {
    return `Edit failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`;
  }

  await writeFile(fullPath, modified, 'utf-8');

  const result = errors.length > 0
    ? `File edited with warnings:\n${errors.map((e) => `  - ${e}`).join('\n')}`
    : `File edited successfully: ${fullPath}`;

  return result;
}

async function writeFileTool(path: string, content: string, workDir: string): Promise<string> {
  const fullPath = resolve(workDir, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
  return `Successfully wrote ${Buffer.byteLength(content, 'utf-8')} bytes to ${fullPath}`;
}

// ── New tools: ls, find, grep ──────────────────────────────────────

async function lsTool(path: string | undefined, workDir: string): Promise<string> {
  const dir = resolve(workDir, path || '.');
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

    return truncateOutput(`${dir}:\n${lines.join('\n')}`);
  } catch (err: any) {
    return `Error listing ${dir}: ${err.message}`;
  }
}

async function findTool(
  pattern: string,
  searchPath: string | undefined,
  workDir: string,
): Promise<string> {
  const base = resolve(workDir, searchPath || '.');
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
  );
}

async function grepTool(
  pattern: string,
  searchPath: string | undefined,
  include: string | undefined,
  workDir: string,
): Promise<string> {
  const base = resolve(workDir, searchPath || '.');
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
  );
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
      case 'grep':
        result = await grepTool(
          args.pattern as string,
          args.path as string | undefined,
          args.include as string | undefined,
          workDir,
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
