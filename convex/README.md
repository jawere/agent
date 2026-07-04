# jawere — Convex Backend

This directory contains the [Convex](https://convex.dev) backend for **jawere**, the AI coding agent. It provides persistent storage for sessions, messages, custom tool definitions, and token usage tracking.

## What it does

The Convex backend stores every conversation (session) that the jawere agent runs. Each session contains the full history of user messages, assistant responses, tool calls, and tool results — all with timestamps and token usage data. This allows you to resume any session later with `/load <id>`.

## Schema

The database schema is defined in `convex/schema.ts` and consists of four tables:

### `sessions`
Conversation metadata.

| Field | Type | Description |
|-------|------|-------------|
| `title` | `string` | Session title (derived from first user message) |
| `model` | `string` | Model name used (e.g., `deepseek-chat`) |
| `systemPrompt` | `string` | System prompt used for the session |
| `toolNames` | `array<string>` | Tool names available to the agent |
| `createdAt` | `number` | Unix timestamp of creation |
| `updatedAt` | `number` | Unix timestamp of last update |
| `userId` | `string?` | Clerk user ID (auth placeholder) |

Index: `by_updated` (descending by `updatedAt`)

### `messages`
Individual messages within a session.

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `id("sessions")` | Parent session ID |
| `role` | `"user" \| "assistant" \| "toolResult"` | Message role |
| `content` | `array<object>` | Message content blocks (text, tool_call, tool_result) |
| `timestamp` | `number` | Unix timestamp |
| `stopReason` | `string?` | Reason the assistant stopped |
| `toolCallId` | `string?` | Tool call ID (for tool results) |
| `toolName` | `string?` | Tool name (for tool results) |
| `isError` | `boolean?` | Whether the tool result is an error |
| `usage` | `object?` | Token usage (input, output, total) |

Index: `by_session` (ascending by `sessionId`)

### `tools`
Custom tool definitions that extend the agent's capabilities.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Tool name |
| `description` | `string` | Tool description |
| `parameters` | `any` | JSON Schema for parameters |
| `isBuiltin` | `boolean` | Whether this is a built-in tool |
| `createdBy` | `string?` | Creator identifier |
| `createdAt` | `number` | Unix timestamp |

Index: `by_name` (by `name`)

### `usage`
Aggregated token usage per session per day.

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | `id("sessions")` | Parent session ID |
| `date` | `string` | Date in YYYY-MM-DD format |
| `model` | `string` | Model name |
| `inputTokens` | `number` | Cumulative input tokens |
| `outputTokens` | `number` | Cumulative output tokens |
| `totalTokens` | `number` | Cumulative total tokens |

Index: `by_session_date` (by `sessionId` + `date`)

## API

### Queries

| Mutation | Description |
|----------|-------------|
| `sessions:list` | Get the 100 most recent sessions |
| `sessions:get` | Get a single session with all its messages |
| `sessions:getUsage` | Get usage records for a session |

### Mutations

| Mutation | Description |
|----------|-------------|
| `sessions:create` | Create a new session |
| `sessions:appendMessage` | Append a message (user, assistant, or tool result) with automatic usage tracking and session timestamp update |
| `sessions:remove` | Delete a session and all associated messages and usage records |

## Deployment

Two Convex deployments are configured:

| Environment | URL | Config File |
|-------------|-----|-------------|
| **Dev** | `https://dazzling-jackal-33.convex.cloud` | `.env.local` |
| **Prod** | `https://friendly-pigeon-624.convex.cloud` | `.env.prod` |

### Commands

```bash
# Local development (runs a local Convex backend)
npx convex dev

# Deploy to dev
npx convex deploy --env-file .env.local

# Deploy to prod
npx convex deploy --env-file .env.prod

# Seed built-in tools into dev
CONVEX_URL=https://dazzling-jackal-33.convex.cloud npx tsx scripts/seed.ts

# Seed built-in tools into prod
CONVEX_URL=https://friendly-pigeon-624.convex.cloud npx tsx scripts/seed.ts
```

## Files

| File | Description |
|------|-------------|
| `convex/schema.ts` | Database schema definition |
| `convex/sessions.ts` | Session and message CRUD operations |
| `convex/chat.ts` | Streaming and sync chat endpoints (proxies to DeepSeek) |
| `convex/http.ts` | HTTP router — registers `/api/chat` and `/api/chat-sync` routes |
| `convex/tools.ts` | Custom tool definitions — register, list, search, and remove tools |
| `convex/seed.ts` | Internal mutation to seed built-in tools |
| `scripts/seed.ts` | CLI script to seed tools via Convex HTTP API |
| `scripts/build.js` | esbuild bundler for the agent CLI |
| `convex.json` | Convex project configuration |
| `.env.local` | Dev environment variables |
| `.env.prod` | Prod environment variables |
