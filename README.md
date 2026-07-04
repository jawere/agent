# jawere — AI Coding Agent

Terminal-based AI coding assistant powered by DeepSeek. Runs as an interactive REPL — describe tasks in natural language, and the agent reads, edits, writes, and executes shell commands autonomously.

## Features

- **Autonomous Agent Loop** — Tool-calling loop (up to 500 turns) with seven filesystem tools
- **Codebase Scanner** — Pre-scans the project on startup, generating `.codebase/tree.yaml` and `.codebase/meta.json` so the LLM has structural context before the first prompt
- **Interactive REPL** — Multiline input (Shift+Enter), session resumption, and persistent conversation history backed by Convex
- **Encrypted API Key** — AES-256-GCM encrypted key storage at `~/.jawere/key.enc`
- **Session Persistence** — Full message history, tool calls, and token usage stored in Convex
- **Dual Environment** — Dev/prod modes with separate Convex deployments

## Quick Start

```bash
git clone git@github.com:jawere/agent.git
cd agent
npm install
npx tsx src/index.ts --setup   # one-time API key setup
npm start
```

Or set the key via environment variable:

```bash
export DEEPSEEK_API_KEY=sk-...
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/sessions` | List recent Convex sessions |
| `/load <id>` | Resume a previous session |
| `/key` | Show API key status |
| `/setup` | Re-enter and save API key |
| `/clear` | Clear screen and start fresh |
| `/exit`, `/quit` | Exit |

## Tools

The LLM has access to seven filesystem tools:

- `bash` — Execute shell commands with configurable timeout (max 300s). Output truncated at 2000 lines / 50KB.
- `read` — Read file contents with line offset/limit for large files.
- `edit` — Precise exact-text replacement with uniqueness validation. Supports batched edits.
- `write` — Create or overwrite files. Auto-creates parent directories.
- `ls` — List directory contents with sizes.
- `find` — Find files by fuzzy name or glob pattern. Skips hidden dirs and node_modules.
- `grep` — Search file contents with regex. Supports file glob filtering.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | DeepSeek API key |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Model name |
| `WORK_DIR` | `process.cwd()` | Working directory |
| `CONVEX_URL` | auto | Convex deployment URL |
| `NODE_ENV` | auto-detected | `development` or `production` |

## Project Structure

```
├── bin/jawere.js              # CLI entry point (global install)
├── src/
│   ├── index.ts               # REPL main loop, command handling
│   ├── agent.ts               # Agent loop: LLM calls + tool execution
│   ├── config.ts              # Configuration (env, key, mode)
│   ├── tools.ts               # Tool definitions & implementations
│   ├── convex-client.ts       # HTTP client for Convex backend
│   ├── crypto.ts              # Encrypted API key storage (AES-256-GCM)
│   ├── scanner.ts             # Codebase pre-scanner (.codebase/)
│   ├── spinner.ts             # Terminal spinner animations
│   └── system-prompt.ts       # System prompt template
├── convex/                    # Convex backend (schema, mutations, queries)
├── scripts/build.js           # esbuild bundler
├── dist/                      # Compiled output
├── package.json
└── tsconfig.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run in dev mode |
| `npm run start:prod` | Run in prod mode |
| `npm run build` | Bundle with esbuild |
| `npm run dev` | Run `convex dev` for backend |
| `npm run deploy:dev` | Deploy Convex backend (dev) |
| `npm run deploy:prod` | Deploy Convex backend (prod) |
| `npm run seed:dev` | Seed dev database |
| `npm run seed:prod` | Seed prod database |

## License

MIT
