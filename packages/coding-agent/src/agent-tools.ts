// @jawere/coding-agent — AgentTool[] factory for @jawere/agent

import type { AgentTool, AgentToolResult } from "@jawere/agent";
import {
  execBash,
  readFileTool,
  editFileTool,
  writeFileTool,
  lsTool,
  findTool,
  grepTool,
  statTool,
  diffTool,
  webSearchTool,
  docsSearchTool,
} from "./tools.js";

// ── Helpers ──────────────────────────────────────────────────────────

function ok(text: string, details?: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text }],
    details: details ?? {},
  };
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create AgentTool[] bound to a specific working directory.
 * Each tool's execute() closure captures workDir so the Agent class
 * doesn't need to pass it explicitly.
 */
export function createAgentTools(workDir: string): AgentTool[] {
  return [
    // ── bash ───────────────────────────────────────────────────────
    {
      name: "bash",
      description:
        "Execute a bash command in the working directory. Returns stdout and stderr. " +
        "Output is truncated to 2000 lines or 50KB (whichever is hit first). " +
        "Optionally provide a timeout in seconds (max 300s).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute" },
          timeout: { type: "number", description: "Timeout in seconds (optional, max 300)" },
        },
        required: ["command"],
      },
      readOnly: false,
      async execute(_id, rawArgs) {
        const args = rawArgs as { command: string; timeout?: number };
        const result = await execBash(args.command, workDir, args.timeout);
        return ok(result);
      },
    },

    // ── read ───────────────────────────────────────────────────────
    {
      name: "read",
      description:
        "Read the contents of a file. Supports text files. Output is truncated to 2000 lines " +
        "or 50KB (whichever is hit first). Use offset/limit for large files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to read (relative or absolute)" },
          offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
          limit: { type: "number", description: "Maximum number of lines to read" },
        },
        required: ["path"],
      },
      fileOriented: true,
      readOnly: true,
      async execute(_id, rawArgs) {
        const args = rawArgs as { path: string; offset?: number; limit?: number };
        const result = await readFileTool(args.path, workDir, args.offset, args.limit);
        return ok(result);
      },
    },

    // ── edit ───────────────────────────────────────────────────────
    {
      name: "edit",
      description:
        "Edit a file using exact text replacement. Every edits[].oldText must match a unique, " +
        "non-overlapping region of the original file. Merge nearby changes into one edit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string", description: "Exact text to replace (must be unique in file)" },
                newText: { type: "string", description: "Replacement text" },
              },
              required: ["oldText", "newText"],
            },
            description: "One or more targeted replacements",
          },
        },
        required: ["path", "edits"],
      },
      fileOriented: true,
      readOnly: false,
      async execute(_id, rawArgs) {
        const args = rawArgs as { path: string; edits: Array<{ oldText: string; newText: string }> };
        const result = await editFileTool(args.path, args.edits, workDir);
        return ok(result);
      },
    },

    // ── write ──────────────────────────────────────────────────────
    {
      name: "write",
      description:
        "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
        "Automatically creates parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file to write (relative or absolute)" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["path", "content"],
      },
      fileOriented: true,
      readOnly: false,
      async execute(_id, rawArgs) {
        const args = rawArgs as { path: string; content: string };
        const result = await writeFileTool(args.path, args.content, workDir);
        return ok(result);
      },
    },

    // ── ls ─────────────────────────────────────────────────────────
    {
      name: "ls",
      description:
        "List directory contents. Shows files and directories with sizes, sorted (dirs first, " +
        "then files alphabetically).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory to list (defaults to working directory)" },
        },
      },
      fileOriented: true,
      readOnly: true,
      async execute(_id, rawArgs) {
        const args = rawArgs as { path?: string };
        const result = await lsTool(args.path, workDir);
        return ok(result);
      },
    },

    // ── find ───────────────────────────────────────────────────────
    {
      name: "find",
      description:
        'Find files by name. Supports fuzzy matching (e.g. "agentloop" matches "agent-loop.ts") ' +
        'and glob patterns (e.g. "*.ts"). Skips hidden dirs and common large directories.',
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search query (fuzzy or glob like *.ts)" },
          path: { type: "string", description: "Directory to search in (defaults to working directory)" },
        },
        required: ["pattern"],
      },
      fileOriented: true,
      readOnly: true,
      async execute(_id, rawArgs) {
        const args = rawArgs as { pattern: string; path?: string };
        const result = await findTool(args.pattern, args.path, workDir);
        return ok(result);
      },
    },

    // ── grep ───────────────────────────────────────────────────────
    {
      name: "grep",
      description:
        "Search file contents with regex. Returns matching file paths with line numbers. " +
        "Skips binary files and files over 500KB.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Directory or file to search in (defaults to working directory)" },
          include: { type: "string", description: "File glob filter (e.g. *.ts)" },
        },
        required: ["pattern"],
      },
      fileOriented: true,
      readOnly: true,
      async execute(_id, rawArgs) {
        const args = rawArgs as { pattern: string; path?: string; include?: string };
        const result = await grepTool(args.pattern, args.path, args.include, workDir);
        return ok(result);
      },
    },

    // ── stat ───────────────────────────────────────────────────────
    {
      name: "stat",
      description:
        "Get file or directory metadata. Returns size, line count (for text files), " +
        "modification time, and whether the file is binary.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file or directory (relative or absolute)" },
        },
        required: ["path"],
      },
      fileOriented: true,
      readOnly: true,
      async execute(_id, rawArgs) {
        const args = rawArgs as { path: string };
        const result = await statTool(args.path, workDir);
        return ok(result);
      },
    },

    // ── diff ───────────────────────────────────────────────────────
    {
      name: "diff",
      description:
        "Show a git diff of changes. Supports --staged for staged changes, " +
        "and optional path/file and base ref.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Specific file or directory to diff (optional — diffs everything if omitted)" },
          staged: { type: "boolean", description: "Show staged changes (git diff --staged). Default: false (working tree)" },
          base: { type: "string", description: "Base ref to diff against (e.g. HEAD~1, main). Default: HEAD for staged, working tree otherwise" },
        },
      },
      fileOriented: true,
      readOnly: true,
      async execute(_id, rawArgs) {
        const args = rawArgs as { path?: string; staged?: boolean; base?: string };
        const result = await diffTool(args.path, args.staged, args.base, workDir);
        return ok(result);
      },
    },

    // ── web_search ─────────────────────────────────────────────────
    {
      name: "web_search",
      description:
        "Search the web for information. Uses DuckDuckGo (free). Returns abstracts, " +
        "answers, related topics, and web links.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string" },
          count: { type: "number", description: "Maximum number of results to return (default 5, max 10)" },
        },
        required: ["query"],
      },
      readOnly: true,
      async execute(_id, rawArgs) {
        const args = rawArgs as { query: string; count?: number };
        const result = await webSearchTool(args.query, args.count);
        return ok(result);
      },
    },

    // ── docs ───────────────────────────────────────────────────────
    {
      name: "docs",
      description:
        "Search library/framework/API documentation. Uses DuckDuckGo site-targeted queries. " +
        "Use for API references, method signatures, config options, package usage examples.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Documentation search query (e.g. \"fs.readFile options\", \"React useEffect cleanup\")" },
          library: { type: "string", description: "Optional library/package name to narrow search (e.g. \"react\", \"typescript\", \"express\")" },
          count: { type: "number", description: "Maximum results (default 5, max 8)" },
        },
        required: ["query"],
      },
      readOnly: true,
      async execute(_id, rawArgs) {
        const args = rawArgs as { query: string; library?: string; count?: number };
        const result = await docsSearchTool(args.query, args.library, args.count);
        return ok(result);
      },
    },
  ];
}
