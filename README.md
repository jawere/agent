# ponytail — AI Coding Agent

**ponytail** is a terminal-based AI coding assistant powered by DeepSeek's API. It runs as an interactive REPL where you describe tasks in natural language, and the agent reads, edits, writes, and executes shell commands in your project directory — all autonomously.

Think of it as an AI pair-programmer that lives in your terminal, with persistent conversation history backed by [Convex](https://convex.dev).

## Features

- **🤖 Autonomous Agent Loop** — Describe tasks in natural language. The agent uses a tool-calling loop (up to 500 turns) to explore your codebase, read files, make edits, run commands, and iterate until the task is complete.
- **🛠️ Seven Filesystem Tools**
  - `bash` — Execute arbitrary shell commands with configurable timeouts (up to 300s). Output truncated at 2000 lines / 50KB.
  - `read` — Read text files with optional line offset/limit for large files.
  - `edit` — Precise exact-text replacement with uniqueness validation. Supports batching multiple edits into one call.
  - `write` — Create new files or overwrite existing ones. Automatically creates parent directories.
  - `ls` — List directory contents with sizes, sorted (dirs first, then files alphabetically).
  - `find` — Find files by name with fuzzy matching and glob pattern support. Skips hidden dirs and common large directories.
  - `grep` — Search file contents with regex. Returns matching file paths with line numbers and content. Supports glob filtering.
- **💬 Interactive REPL** — Multi-turn conversations with session resumption. Commands include `/help`, `/sessions`, `/load`, `/key`, `/setup`, `/clear`, `/exit`.
- **💾 Session Persistence** — Every conversation is saved to a Convex cloud backend. Sessions include full message history, tool calls, and token usage. Resume any session with `/load <id>`.
- **🔐 Encrypted API Key Storage** — Your DeepSeek API key is encrypted at rest (AES-256-GCM) using a machine-derived key. Stored at `~/.ponytail/key.enc`.
- **📊 Token Usage Tracking** — Per-session and per-day token counts stored in Convex. Tracks input, output, and total tokens.
- **🧠 DeepSeek Reasoning** — Leverages DeepSeek's thinking/reasoning mode with high reasoning effort for complex tasks.
- **🌍 Dual Environment** — Runs in `dev` or `prod` mode, each with its own Convex deployment for isolated session storage.
- **🧩 Extensible Convex Backend** — Full database schema for sessions, messages, custom tools, and usage tracking. Deploy your own backend.

## How it works

```
You: "Add error handling to the fetch call in src/api.ts"
        │
        ▼
┌─────────────────────────────────────────────┐
│  ponytail REPL                              │
│  (src/index.ts)                             │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  Agent Loop (src/agent.ts)          │   │
│  │  • Sends prompt + tools to DeepSeek │   │
│  │  • Executes tool calls (bash/read/  │   │
│  │    edit/write)                       │   │
│  │  • Streams tool execution output    │   │
│  │  • Loops up to 500 turns            │   │
│  └─────────────────────────────────────┘   │
│             │                               │
│             ▼                               │
│  ┌─────────────────────────────────────┐   │
│  │  Convex Backend                     │   │
│  │  • Sessions & messages persisted    │   │
│  │  • Token usage tracking (daily)     │   │
│  │  • Resume any session               │   │
│  │  • Custom tool definitions          │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 18+
- A [DeepSeek API key](https://platform.deepseek.com/api_keys)
- (Optional) A [Convex](https://convex.dev) account for session persistence

### Install & Run

```bash
# Clone the repo
git clone <repo-url>
cd ponytail

# Install dependencies
npm install

# Set up your API key (one-time)
npx tsx src/index.ts --setup

# Start the agent
npm start
```

Or set the key via environment variable:

```bash
export DEEPSEEK_API_KEY=sk-...
npm start
```

### First Run

On first launch, ponytail will prompt you to configure an API key. Run `--setup` to encrypt and save it to `~/.ponytail/key.enc`, or set the `DEEPSEEK_API_KEY` environment variable.

```
╔══════════════════════════════════════════╗
║        ponytail — AI Coding Agent        ║
╠══════════════════════════════════════════╣
║ Model:  deepseek-v4-pro                  ║
║ Key:    encrypted file                   ║
║ Env:    dev  (dazzling-jackal-33)        ║
║ Dir:    /home/user/projects/my-app       ║
╠══════════════════════════════════════════╣
║ Tools: bash, read, edit, write,          ║
║        ls, find, grep                    ║
║ Type /help for commands, Ctrl+C to quit  ║
╚══════════════════════════════════════════╝
```

## Usage

### Interactive Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/sessions` | List recent Convex sessions |
| `/load <id>` | Resume a previous session |
| `/key` | Show API key status |
| `/setup` | Re-enter and save API key |
| `/clear` | Clear the screen |
| `/exit`, `/quit` | Exit the agent |

### Example Session

```
> Create a new file called hello.py that prints "Hello, ponytail!"

  ⚡ write: hello.py                                          ✓

[session: abc123def456...]

> Now make it executable and run it

  ⚡ bash: chmod +x hello.py                                  ✓
  ⚡ bash: python3 hello.py                                   ✓

[session: abc123def456...]
```

The agent uses its tools to write the file, run `chmod +x`, and execute it — all autonomously. A live spinner with fun verbs keeps you company during API calls.

## Project Structure

```
ponytail/
├── bin/
│   └── ponytail.js            # CLI entry point (npm bin)
├── src/
│   ├── index.ts               # REPL main loop, command handling
│   ├── agent.ts               # Agent loop: LLM calls + tool execution
│   ├── config.ts              # Configuration loading (env, key, mode)
│   ├── tools.ts               # Tool definitions & implementations (bash, read, edit, write, ls, find, grep)
│   ├── convex-client.ts       # HTTP client for Convex backend
│   ├── crypto.ts              # Encrypted API key storage (AES-256-GCM)
│   └── system-prompt.ts       # System prompt for the LLM
├── convex/
│   ├── convex/
│   │   ├── schema.ts          # Convex database schema (sessions, messages, tools, usage)
│   │   ├── sessions.ts        # Session & message CRUD mutations/queries
│   │   ├── chat.ts            # Chat-specific logic (reserved)
│   │   ├── http.ts            # HTTP endpoint handlers (reserved)
│   │   ├── tools.ts           # Custom tool definitions (reserved)
│   │   └── seed.ts            # Database seeding script
│   ├── convex.json            # Convex project config
│   ├── bin/ponytail.js        # Convex-side bin entry
│   ├── .env.local             # Dev environment variables
│   ├── .env.prod              # Prod environment variables
│   └── README.md              # Convex-specific documentation
├── scripts/
│   └── build.js               # esbuild bundler script
├── dist/                      # Compiled output (gitignored)
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration

ponytail reads configuration from environment variables and an optional encrypted key file:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key (env var takes precedence over saved key) |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Model name to use |
| `WORK_DIR` | `process.cwd()` | Working directory for tool execution |
| `CONVEX_URL` | auto (dev/prod) | Convex deployment URL |
| `NODE_ENV` | auto-detected | `development` or `production` |

### Dev vs Prod

The agent auto-detects its environment:
- **Dev**: Running via `tsx` / source files → uses `dazzling-jackal-33.convex.cloud`
- **Prod**: Running compiled JS → uses `friendly-pigeon-624.convex.cloud`

Override with `NODE_ENV=production` or `NODE_ENV=development`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run in dev mode (with `.env.local`) |
| `npm run start:prod` | Run in prod mode |
| `npm run build` | Bundle with esbuild into `dist/` |
| `npm run dev` | Run `convex dev` for backend development |
| `npm run deploy:dev` | Deploy Convex backend to dev |
| `npm run deploy:prod` | Deploy Convex backend to prod |
| `npm run seed:dev` | Seed dev database (tools & data) |
| `npm run seed:prod` | Seed prod database (tools & data) |

## Agent Tools

The LLM has access to seven tools, each with specific capabilities:

### `bash`

Execute arbitrary shell commands in the working directory. Supports timeouts (max 300s). Output is truncated to 2000 lines / 50KB. Use this for running scripts, installing dependencies, listing files, searching with grep/find, git operations, compilers, linters, and tests.

### `read`

Read the contents of a file. Supports text files. Use `offset` (1-indexed line number) and `limit` (max lines) for large files. When you need the full file, continue with offset until complete.

### `edit`

Perform precise file edits using exact-text replacement. Every `oldText` must match exactly once in the file (uniqueness enforced to prevent ambiguity). For multiple edits to the same file, group them into a single call. Keep `oldText` as small as possible while still being unique — do not pad with large unchanged regions. Can also create new files if `oldText` is empty (single edit only).

### `write`

Create new files or completely overwrite existing ones. Automatically creates parent directories. Use this only for new files or complete rewrites, not for small edits (use `edit` instead).

### `ls`

List directory contents. Shows files and directories with sizes, sorted (dirs first, then files alphabetically). Skips hidden directories and common large folders (node_modules, .git, dist, etc.).

### `find`

Find files by name. Supports fuzzy matching (e.g. "agentloop" matches "agent-loop.ts") and glob patterns (e.g. "*.ts"). Skips hidden dirs and common large directories (node_modules, .git, dist, etc.).

### `grep`

Search file contents with regex. Returns matching file paths with line numbers and content. Skips binary files and files over 500KB. Supports file glob filtering (e.g. `*.ts`).

## Security

- **API keys** are encrypted with AES-256-GCM using a key derived from your machine's hostname and username. Stored at `~/.ponytail/key.enc`.
- **No telemetry.** ponytail does not phone home (except to your configured Convex deployment and the DeepSeek API).
- **Tool sandboxing** is minimal — the agent runs commands in your working directory. Use with trusted code only.

## Backend (Convex)

ponytail uses Convex as a persistent backend to store:

- **Sessions** — conversation metadata (title, model, system prompt, tool names)
- **Messages** — user, assistant, and tool result messages with timestamps and usage data
- **Tools** — user-extensible custom tool definitions (built-in or custom)
- **Usage** — per-session, per-day token counts with upsert aggregation

The schema is defined in `convex/convex/schema.ts` and the API in `convex/convex/sessions.ts`.

To deploy your own Convex backend:

```bash
cd convex
npx convex dev       # local development
npx convex deploy    # production deployment
```

## License

MIT
