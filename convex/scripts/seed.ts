// ============================================================================
// Seed script — push built-in tools and verify Convex connection
// ============================================================================

import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL || "https://friendly-pigeon-624.convex.cloud";

async function main() {
  const client = new ConvexClient(CONVEX_URL);

  console.log("Connected to", CONVEX_URL);

  // Seed built-in tools via internal mutation (if available)
  // Since we can't call internal functions from client, let's register them manually
  const tools = [
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

  for (const tool of tools) {
    await client.mutation(api.tools.register, tool);
  }

  console.log(`Seeded ${tools.length} built-in tools.`);

  // Verify
  const stored = await client.query(api.tools.list, {});
  console.log(`Total tools in DB: ${stored.length}`);
  for (const t of stored) {
    console.log(`  - ${t.name}${t.isBuiltin ? " (builtin)" : ""}`);
  }

  // Test session
  const sessionId = await client.mutation(api.sessions.create, {
    title: "Test session",
    model: "deepseek-chat",
    systemPrompt: "You are a helpful assistant.",
    toolNames: ["read", "write", "edit", "ls", "find", "grep"],
  });
  console.log(`\nCreated test session: ${sessionId}`);

  await client.mutation(api.sessions.appendMessage, {
    sessionId,
    role: "user",
    content: [{ type: "text", text: "Hello, world!" }],
    timestamp: Date.now(),
  });
  console.log("Appended test message.");

  const loaded = await client.query(api.sessions.get, { sessionId });
  console.log(`Loaded session: "${loaded?.title}" with ${loaded?.messages.length} messages`);

  client.close();
  console.log("\nDone! Convex backend is ready.");
}

main().catch(console.error);
