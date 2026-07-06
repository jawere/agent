# jawere — AI Coding Agent

Terminal-based AI coding agent. Runs as an interactive REPL — describe tasks in natural language, and the agent reads, edits, writes files, and executes shell commands autonomously.

## Quick Start

```bash
git clone git@github.com:jawere/agent.git
cd agent
npm install
npm run setup   # configure provider, API key, model
npm start
```

Or set the key via environment variable:

```bash
export AI_API_KEY=sk-...   # works for any provider
npm start
```

## Packages

This is a monorepo with 5 packages under npm workspaces:

| Package | Description |
|---------|-------------|
| **@jawere/ai** | Unified LLM provider layer (OpenAI, DeepSeek, Anthropic, Google, Azure, Bedrock, Mistral, GitHub Copilot, OpenRouter, Cloudflare, OpenAI-compatible) |
| **@jawere/agent** | Agent loop engine — stateful agent with tools, hooks, steering/follow-up queues, streaming |
| **@jawere/coding-agent** | App layer — CLI REPL, tools, sessions, codebase scanner, system prompt |
| **@jawere/tui** | Terminal UI — spinner, multiline prompt, display formatting |
| **@jawere/orchestrator** | Multi-agent orchestration (early stage) |

## Features

- **Autonomous Agent Loop** — Tool-calling loop with parallel and sequential execution, abort support, hooks
- **Multi-Provider** — DeepSeek, OpenAI, Anthropic, Google, Azure, Bedrock, Mistral, Groq, xAI, and more
- **Codebase Scanner** — Pre-scans the project on startup, generating `.codebase/tree.yaml` and `.codebase/checksums.json` so the LLM has structural context before the first prompt
- **Interactive REPL** — Multiline input (Shift+Enter), session resumption, persistent conversation history
- **Encrypted API Key** — AES-256-GCM encrypted key storage at `~/.jawere/key.enc` (pepper + machine-derived key)
- **Session Tree** — pi-compatible v3 JSONL format with branching, compaction, and labeling

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/sessions` | List past sessions |
| `/resume <id>` | Resume a past session |
| `/key` | Show API key status |
| `/setup` | Re-configure AI provider and key |
| `/clear` | Clear screen and start fresh session |
| `/exit`, `/quit` | Exit |

## Tools

The agent has access to these tools:

- `bash` — Execute shell commands with configurable timeout (max 300s)
- `read` — Read file contents with line offset/limit
- `edit` — Exact-text replacement with uniqueness validation, batched edits
- `write` — Create or overwrite files, auto-creates parent directories
- `ls` — List directory contents with sizes
- `find` — Find files by fuzzy name or glob pattern
- `grep` — Search file contents with regex, file glob filtering
- `stat` — File/directory metadata (size, line count, mod time)
- `diff` — Show git diff with support for --staged, path, base ref
- `web_search` — Search the web via DuckDuckGo
- `docs` — Search library/framework documentation

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_API_KEY` | — | API key (any provider) |
| `DEEPSEEK_API_KEY` | — | DeepSeek-specific API key |
| `OPENAI_API_KEY` | — | OpenAI-specific API key |
| `AI_PROVIDER` | `deepseek` | Provider: `deepseek`, `openai`, or `custom` |
| `AI_BASE_URL` | provider default | Custom API base URL |
| `AI_MODEL` | provider default | Model name override |
| `WORK_DIR` | `process.cwd()` | Working directory for the agent |

## Project Structure

```
├── bin/jawere.js                   # CLI entry point (npm link / global install)
├── scripts/
│   ├── build.js                    # esbuild bundler
│   └── setup.js                    # Interactive setup wizard
├── packages/
│   ├── ai/src/                     # @jawere/ai — multi-provider LLM layer
│   │   ├── types.ts                # Canonical types (Model, Message, Context, Stream)
│   │   ├── models.ts               # ModelRegistry
│   │   ├── providers/              # 11 provider implementations
│   │   ├── complete.ts             # streamSimple, completeSimple, oneShot, chat
│   │   └── event-stream.ts         # EventStream (pull-based async iterable)
│   ├── agent/src/                  # @jawere/agent — agent loop engine
│   │   ├── agent.ts                # Agent class (subscribe, prompt, steer, followUp)
│   │   ├── agent-loop.ts           # Low-level loop with tool execution (seq/parallel)
│   │   ├── types.ts                # AgentTool, AgentMessage, AgentEvent, hooks
│   │   └── proxy.ts                # streamProxy for server-based routing
│   ├── coding-agent/src/           # @jawere/coding-agent — app layer
│   │   ├── cli.ts                  # REPL main loop, command handling
│   │   ├── agent-runner.ts         # Bridges config/tools to Agent + provider
│   │   ├── agent-tools.ts          # AgentTool[] factory
│   │   ├── tools.ts                # Tool implementations (bash, read, edit, etc.)
│   │   ├── scanner.ts              # Background codebase scanner
│   │   ├── system-prompt.ts        # Agent system prompt
│   │   ├── config.ts               # Configuration loading
│   │   ├── crypto.ts               # AES-256-GCM encrypted key storage
│   │   ├── db.ts                   # Legacy JSON session store
│   │   └── session/                # pi-compatible v3 JSONL session format
│   ├── tui/src/                    # @jawere/tui — terminal UI
│   │   ├── display.ts              # Tool line formatting, assistant rendering
│   │   ├── prompt.ts               # Multiline prompt with paste support
│   │   └── spinner.ts              # Braille spinner
│   └── orchestrator/src/           # @jawere/orchestrator — multi-agent
│       ├── supervisor.ts           # Instance management
│       └── rpc-process.ts          # Child process RPC
├── tsconfig.base.json              # Shared TypeScript config
├── tsconfig.json                   # Root type-check config
└── package.json                    # Workspace root
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run in dev mode (tsx) |
| `npm run start:prod` | Run in prod mode |
| `npm run setup` | Interactive setup wizard |
| `npm run build` | Build all packages |
| `npm run check` | Type-check all packages |
| `npm run test` | Run tests (if present) |
| `npm run clean` | Clean dist directories |

## License

MIT
