# jawere — AI Coding Agent

An autonomous AI coding agent that runs in your terminal. Describe tasks in natural language, and the agent reads your codebase, edits files, writes new files, and executes shell commands — all while explaining its decisions.

Built on a monorepo of reusable packages: a multi-provider LLM layer, an agent loop engine, and a terminal UI toolkit.

## Quick Start

```bash
git clone git@github.com:jawere/agent.git
cd agent
npm install
npm run setup   # configure provider, API key, model
npm start
```

After `npm install`, the pre-commit hook is installed automatically. Tests run before every commit.

## Installation

### Prerequisites

- **Node.js 22+** (uses built-in test runner, strip-types, and watch mode)
- **npm 10+** (workspaces support)
- A terminal that supports raw mode and bracketed paste (any modern terminal emulator)

### From Source

```bash
git clone https://github.com/jawere/agent.git
cd agent
npm install        # installs dependencies + pre-commit hook
npm run setup      # interactive setup wizard
npm start          # start the REPL
```

### Global Install

```bash
npm install -g jawere
jawere --setup     # configure on first run
jawere             # start
```

### API Key

You can skip `--setup` and use environment variables instead:

```bash
export AI_API_KEY=sk-...       # works for any provider
export AI_PROVIDER=openai      # optional, defaults to deepseek
export AI_MODEL=gpt-4o         # optional, uses provider default
npm start
```

The setup wizard encrypts your key with AES-256-GCM and stores it at `~/.jawere/key.enc`. The encryption key is derived from your machine identity (hostname + username) combined with a random 256-bit pepper stored at `~/.jawere/.pepper`. No key leaves your machine.

## Usage

Start the REPL and type tasks in natural language:

```
> add dark mode toggle to settings
> fix the race condition in the WebSocket handler
> refactor the auth module to use JWT instead of sessions
> write tests for the payment processor
```

The agent autonomously:
1. Scans your codebase (cached in `.codebase/tree.yaml`)
2. Reads relevant files to understand the current state
3. Plans and executes changes (write, edit, bash commands)
4. Reports what it did and why

### REPL Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/sessions` | List past sessions |
| `/resume <id>` | Resume a past session |
| `/key` | Show API key status |
| `/setup` | Reconfigure AI provider and model |
| `/clear` | Clear screen and start a fresh session |
| `/exit`, `/quit` | Exit the REPL |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Enter | Submit prompt |
| Shift+Enter | New line (multiline input) |
| Ctrl+C | Cancel input |
| Ctrl+D | Exit (on empty line) |
| Arrow keys | Navigate within input |

## Supported Providers

| Provider | `AI_PROVIDER` value | Default model | Key env var hint |
|----------|---------------------|---------------|-----------------|
| DeepSeek | `deepseek` | deepseek-chat | `sk-` |
| OpenAI | `openai` | gpt-4o | `sk-` |
| Anthropic | `anthropic` | claude-sonnet-4-20250514 | `sk-ant-` |
| Google Gemini | `google` | gemini-2.5-pro | `gsk_` |
| Groq | `groq` | llama-3.3-70b-versatile | `gsk_` |
| xAI | `xai` | grok-3-beta | `xai-` |
| Mistral | `mistral` | mistral-large-latest | — |
| OpenRouter | `openrouter` | openai/gpt-4o | `sk-or-` |
| Custom | `custom` | gpt-4o | any |

Additional providers (AWS Bedrock, Azure, Cloudflare, GitHub Copilot, Google Vertex, Fireworks, Together) are available by setting `AI_PROVIDER` and the corresponding provider-specific environment variable. See `packages/ai/src/providers/` for the full list.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_API_KEY` | — | API key for any provider |
| `AI_PROVIDER` | deepseek | Provider ID from the table above |
| `AI_BASE_URL` | provider default | Custom API base URL |
| `AI_MODEL` | provider default | Model name override |
| `WORK_DIR` | cwd | Working directory for the agent |
| `NODE_ENV` | — | Set to `production` to run compiled JS |

Provider-specific keys also work: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.

## Tools

The agent has access to these tools:

| Tool | Description | Read-only |
|------|-------------|-----------|
| `bash` | Execute shell commands (max 300s timeout) | No |
| `read` | Read file contents with line offset/limit | Yes |
| `edit` | Exact-text replacement with uniqueness validation | No |
| `write` | Create or overwrite files (auto-creates parent dirs) | No |
| `ls` | List directory contents with sizes | Yes |
| `find` | Find files by fuzzy name or glob pattern | Yes |
| `grep` | Search file contents with regex | Yes |
| `stat` | File/directory metadata (size, lines, mod time) | Yes |
| `diff` | Git diff with staged, path, and base ref support | Yes |
| `web_search` | Search the web via DuckDuckGo | Yes |
| `docs` | Search library/framework documentation | Yes |

## Architecture

```
┌──────────────────────────────────────────┐
│                 jawere CLI               │  packages/coding-agent
│  cli.ts ──► agent-runner.ts ──► tools   │  REPL, session mgmt,
│                    │                     │  codebase scanner
└────────────────────┼─────────────────────┘
                     │
┌────────────────────┼─────────────────────┐
│              @jawere/agent               │  packages/agent
│   Agent class ──► agent-loop.ts          │  Stateful agent, tool
│   hooks, steering, streaming             │  execution (seq/parallel)
└────────────────────┼─────────────────────┘
                     │
┌────────────────────┼─────────────────────┐
│                @jawere/ai                │  packages/ai
│   12 providers ──► ModelRegistry         │  Unified LLM API,
│   EventStream, token utils, retry        │  key resolution
└──────────────────────────────────────────┘
```

### Packages

| Package | Purpose |
|---------|---------|
| **@jawere/ai** | Multi-provider LLM abstraction with 12+ provider implementations, key resolution from env vars/files/commands/keychain, token estimation, and retry logic |
| **@jawere/agent** | Agent loop engine with streaming, tool execution (sequential/parallel), lifecycle hooks, steering and follow-up message queues, and abort support |
| **@jawere/coding-agent** | Application layer: CLI REPL, tool implementations, codebase scanner (generates `.codebase/tree.yaml`), session persistence, and encrypted key storage |
| **@jawere/tui** | Terminal UI components: Gruvbox-themed display formatter, multiline prompt with paste support, and braille spinner |


## Development

### Setup

```bash
git clone https://github.com/jawere/agent.git
cd agent
npm install       # installs deps + pre-commit hook
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Run in dev mode (tsx, auto-restart) |
| `npm run start:prod` | Run compiled JS |
| `npm run setup` | Interactive provider/key/model setup |
| `npm run build` | Build all packages |
| `npm run check` | Type-check all packages |
| `npm test` | Run all tests (122 tests across 5 packages) |
| `npm run clean` | Remove build artifacts |

### Project Structure

```
.
├── packages/
│   ├── ai/src/             # Provider layer + LLM types
│   │   ├── providers/      # 12 provider implementations
│   │   ├── models.ts       # ModelRegistry
│   │   ├── complete.ts     # High-level API (streamSimple, oneShot, chat)
│   │   ├── api-keys.ts     # Dynamic key resolution ($VAR, !cmd, file:, keychain:)
│   │   └── *.test.ts       # 64 tests
│   ├── agent/src/          # Agent loop engine
│   │   ├── agent.ts        # Agent class (subscribe, prompt, steer, followUp)
│   │   ├── agent-loop.ts   # Low-level tool-calling loop
│   │   └── *.test.ts       # 2 tests
│   ├── coding-agent/src/   # CLI + tools + scanner
│   │   ├── cli.ts          # REPL main loop
│   │   ├── tools.ts        # 11 tool implementations
│   │   ├── scanner.ts      # Background codebase scanner
│   │   └── *.test.ts       # 22 tests (crypto + db)
│   ├── tui/src/            # Terminal UI
│   │   ├── display.ts      # Gruvbox-themed output formatting
│   │   ├── prompt.ts       # Multiline input with paste detection
│   │   └── *.test.ts       # 19 tests


├── scripts/
│   ├── pre-commit          # Runs tests before each commit
│   └── build.js            # esbuild bundler
├── tsconfig.base.json      # Shared TypeScript config
└── package.json            # Workspace root
```

### Testing

Tests use Node's built-in `node:test` runner and `node:assert/strict`. No external test framework required.

```bash
npm test                    # run all workspace tests
npm test -w @jawere/ai      # run tests for one package
node --test --watch -w @jawere/ai  # watch mode for one package
```

Test files live alongside source: `packages/*/src/*.test.ts`.

A pre-commit hook runs `npm test` on every commit. Install it manually with:

```bash
npm run precommit:install
```

## License

MIT
