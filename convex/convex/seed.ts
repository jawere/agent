import { internalMutation } from "./_generated/server";

const BUILTIN_TOOLS = [
  {
    name: "read",
    description: "Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). For text files, output is truncated to 2000 lines or 500KB (whichever is hit first). Use offset/limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write",
    description: "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write (relative or absolute)" },
        content: { type: "string", description: "Content to write to the file" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit",
    description: "Make precise file edits using exact text replacement. Each edit's oldText must match a unique region. Supports multiple edits in one call.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "Exact text to replace" },
              newText: { type: "string", description: "Replacement text" },
            },
            required: ["oldText", "newText"],
          },
          description: "Array of edit operations",
        },
      },
      required: ["path", "edits"],
    },
  },
  {
    name: "ls",
    description: "List directory contents. Shows files and directories with size and type.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (defaults to cwd)" },
      },
      required: [],
    },
  },
  {
    name: "find",
    description: "Find files by name. Supports fuzzy matching (e.g. 'agentloop' matches 'agent-loop.ts') and glob wildcards (*.ts).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search query (fuzzy or glob like *.ts)" },
        path: { type: "string", description: "Directory to search in (defaults to cwd)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents with regex. Returns matching file paths with line numbers and content.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in (defaults to cwd)" },
        include: { type: "string", description: "File glob filter (e.g. *.ts)" },
        caseSensitive: { type: "boolean", description: "Case-sensitive search (default: false)" },
      },
      required: ["pattern"],
    },
  },
];

/** Seed the built-in tools into the database. Idempotent (upserts by name). */
export const seedTools = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    for (const tool of BUILTIN_TOOLS) {
      const existing = await ctx.db
        .query("tools")
        .withIndex("by_name", (q) => q.eq("name", tool.name))
        .first();
      if (!existing) {
        await ctx.db.insert("tools", {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          isBuiltin: true,
          createdAt: now,
        });
      }
    }
    return { seeded: BUILTIN_TOOLS.length };
  },
});
