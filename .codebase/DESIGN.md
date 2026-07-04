# .codebase Background Scanner — Design Draft

## Problem

Every time a user starts a conversation with the jawere agent, the agent wastes ~3-5 turns (and tokens) running `ls`, `find`, `grep`, and `read` to understand the codebase structure before it can do actual work. The user also has to explicitly tell the agent to "scan the codebase" at the start of every session.

## Solution

A **background scanner agent** runs automatically **before** the user can send their first message. It generates a structured `.codebase/tree.yaml` file with the full project tree + file summaries. The main agent then reads this file on startup, so it already "knows" the codebase without using turns or tokens.

```
┌─────────────────────────────────────────────────────────────┐
│  User launches jawere                                       │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  🔒 Prompt box LOCKED                               │   │
│  │  "Scanning codebase… ⠋ Musing…"                    │   │
│  │                                                     │   │
│  │  Background scanner agent runs:                     │   │
│  │    • ls / find / grep (read-only, fast)             │   │
│  │    • Reads key source files for summaries           │   │
│  │    • Generates .codebase/tree.yaml                  │   │
│  │    • Generates .codebase/summaries.yaml             │   │
│  │                                                     │   │
│  │  ~2-5 seconds (cached: ~0.1s)                      │   │
│  └─────────────────────────────────────────────────────┘   │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  🔓 Prompt box UNLOCKED                             │   │
│  │  System prompt includes:                            │   │
│  │    "The codebase tree is at .codebase/tree.yaml"    │   │
│  │    "Read it before taking any action."              │   │
│  │                                                     │   │
│  │  User types: "Fix the bug in auth.ts"               │   │
│  │  Agent reads .codebase/tree.yaml → knows where      │   │
│  │  auth.ts is, what it does, its dependencies         │   │
│  │  → Goes straight to work in 1 turn.                 │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Architecture

### New File: `src/scanner.ts`

```typescript
// src/scanner.ts — Background codebase scanner agent

import { loadConfig } from './config.js';
import { runAgent } from './agent.js';
import { existsSync, statSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve } from 'path';

const SCAN_INTERVAL_MS = 5 * 60 * 1000; // 5 min cache validity
const CODEBASE_DIR = '.codebase';
const TREE_FILE = '.codebase/tree.yaml';
const META_FILE = '.codebase/meta.json';

interface ScanMeta {
  scannedAt: number;
  fileCount: number;
  gitHash: string | null;
  workDir: string;
}

/**
 * Quick check: does the cache need refreshing?
 * Returns true if no cache exists or it's stale.
 */
async function cacheIsStale(workDir: string): Promise<boolean> {
  const treePath = resolve(workDir, TREE_FILE);
  const metaPath = resolve(workDir, META_FILE);

  if (!existsSync(treePath) || !existsSync(metaPath)) return true;

  // Check age
  const meta: ScanMeta = JSON.parse(await readFile(metaPath, 'utf-8'));
  if (Date.now() - meta.scannedAt > SCAN_INTERVAL_MS) return true;

  // Check git hash changed
  const currentHash = await getGitHash(workDir);
  if (currentHash && currentHash !== meta.gitHash) return true;

  return false;
}

async function getGitHash(workDir: string): Promise<string | null> {
  // Try to get current HEAD hash
  try {
    const { execSync } = await import('child_process');
    return execSync('git rev-parse HEAD', { cwd: workDir, timeout: 3000 })
      .toString().trim();
  } catch { return null; }
}

/**
 * Run the scanner agent.
 * This is a stripped-down agent run with a hardcoded mission.
 */
async function runScanner(workDir: string): Promise<void> {
  const scanPrompt = `You are a codebase scanner. Your ONLY mission:

1. Run "find . -type f" (excluding node_modules, dist, .git) to get the full tree
2. For each source file, note: path, size, line count, exports, key functions
3. Generate .codebase/tree.yaml with the complete project tree
4. Generate .codebase/meta.json with scan metadata

DO NOT edit any files. DO NOT run any bash commands beyond exploration.
ONLY use: ls, find, grep, read, write (for .codebase folder only).

The .codebase/tree.yaml format:
- Top-level: project metadata (name, version, language, type)
- "tree": nested structure mirroring filesystem, each file annotated with type + short description
- "summaries": per-file summaries with line count, exports, dependencies, 1-paragraph description

The .codebase/meta.json format:
- scannedAt: timestamp
- fileCount: number
- gitHash: string|null
- workDir: string

Start now. Be thorough but fast.`;

  // Run a mini-agent session (locked, no user interaction)
  const result = await runAgent(scanPrompt, {
    sessionId: undefined,    // don't persist scanner sessions
    title: 'background-scan',
    signal: new AbortController().signal,
  });

  return result;
}
```

### Modified File: `src/index.ts` (key changes)

```typescript
// In the main loop, before the user prompt becomes available:

import { cacheIsStale, runScanner } from './scanner.js';

// ── Inside main() ──

// === Phase 1: Background scan (prompt locked) ===
const spinner = startScanSpinner('Scanning codebase…');
try {
  if (await cacheIsStale(config.workDir)) {
    await runScanner(config.workDir);
  }
} catch (err) {
  // Scan failed — agent will just scan manually like before
  console.log(`${G_GRAY}[scan skipped: ${err.message}]${R}`);
}
spinner.stop();

// Add hint to system prompt
const ENHANCED_SYSTEM_PROMPT = SYSTEM_PROMPT + `
## Codebase Context
The project tree and file summaries are available at:
  - .codebase/tree.yaml  (full tree + per-file summaries)
  - .codebase/meta.json  (scan metadata)

**CRITICAL**: Before taking any action, read .codebase/tree.yaml first.
This saves you turns and gives you instant context about the project structure.`;

// === Phase 2: Prompt unlocked ===
// ... rest of the REPL loop as before ...
```

### Modified File: `src/system-prompt.ts`

```typescript
export const SYSTEM_PROMPT = `You are an expert coding agent...

## Codebase Context
A pre-scan of the project is available. Before doing anything else:
1. Read .codebase/tree.yaml to understand the project structure
2. Read .codebase/meta.json for scan metadata
3. Use this knowledge to navigate efficiently — don't re-scan what's already documented

... rest of existing rules ...`;
```

## How It Works Step-by-Step

### 1. User launches `jawere`
```
$ jawere
```

### 2. Prompt box is LOCKED
- Terminal shows: `Scanning codebase… ⠋ Cogitating…`
- The user cannot type anything yet
- A short timeout (max 15s) prevents hangs on huge repos

### 3. Scanner agent runs
Uses the **same agent loop** (`runAgent` from `agent.ts`) but with:
- A hardcoded scan mission prompt
- No Convex session persistence (no noise in session history)
- Read-only mode enforced via system prompt (no edit/write except to `.codebase/`)
- Lower max turns (20 instead of 500) to cap token spend

The scanner:
1. Runs `find` to get all files
2. Runs `ls` on key directories
3. Reads source file headers (first 50 lines) for exports/signatures
4. Generates `tree.yaml` with full annotated tree
5. Generates `meta.json` with timestamp + git hash

### 4. Cache check
On subsequent launches:
- If `< 5 min since last scan AND git HEAD unchanged` → **skip scan** (0.1s)
- If git hash changed → rescan
- If > 5 min → rescan (pick up external file changes)

### 5. Prompt box UNLOCKED
- User can now type
- System prompt tells the agent about `.codebase/tree.yaml`
- Agent's first action should be `read .codebase/tree.yaml` (1 turn, ~0 tokens for exploration)

### 6. Agent uses the cache
- First turn: `read .codebase/tree.yaml` → instant context
- Second turn: already working on the user's actual request

## Token Savings Estimate

| Scenario | Without Scanner | With Scanner |
|----------|-----------------|--------------|
| Agent exploration turns | 3-5 turns | 1 turn (read cache) |
| Tokens spent exploring | ~2000-5000 input tokens | ~500 input tokens (reading YAML) |
| Time to first useful action | 10-20 seconds | 2-5 seconds |
| User wait before typing | 0s (instant) | 2-5s (one-time scan) |
| Subsequent sessions (cached) | re-scan every time | 0.1s, no re-scan |

For a repo this size (jawere, ~50 source files), the scanner uses:
- ~5 tool calls (1 find, 2-3 reads, 1 write)
- ~3000 tokens total
- ~3-5 seconds

## Files to Create

| File | Purpose |
|------|---------|
| `.codebase/tree.yaml` | Annotated project tree + summaries (generated) |
| `.codebase/meta.json` | Scan metadata (generated) |
| `src/scanner.ts` | Scanner agent implementation |
| `.codebase/.gitignore` | Ignore meta.json (it's machine-specific) |

## Files to Modify

| File | Change |
|------|--------|
| `src/index.ts` | Add scanner phase before prompt loop, enhance system prompt |
| `src/system-prompt.ts` | Add codebase context section pointing to `.codebase/tree.yaml` |
| `.gitignore` | Add `.codebase/meta.json` (generated cache file) |

## Edge Cases & Safety

1. **Huge repos (10k+ files)**: Scanner capped at 500 files, depth 8. Truncation noted in YAML.
2. **No git repo**: Fall back to timestamp-only cache invalidation (5 min TTL).
3. **Scanner fails**: Gracefully degrade — prompt opens anyway, agent scans manually like before.
4. **User interrupts scan**: Ctrl+C skips scan, prompt unlocks immediately.
5. **Read-only guarantee**: Scanner system prompt forbids edits outside `.codebase/`. The tool implementations don't enforce this, but the prompt strongly constrains it.
6. **Convex sessions**: Scanner runs with `sessionId: undefined` so it never pollutes the session list.

## Future Enhancements

- **`.codebase/deps.yaml`**: Dependency graph between files
- **`.codebase/symbols.yaml`**: Full symbol/export index (functions, classes, types)
- **Watch mode**: `inotify`/`fswatch` to auto-refresh cache on file changes
- **User-triggered rescan**: `/rescan` command to force refresh
- **Partial scans**: Only scan changed files (using git diff)
- **Embedding cache**: Pre-compute embeddings of file summaries for semantic search
