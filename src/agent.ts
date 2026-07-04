import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { TOOL_DEFS, executeTool } from './tools.js';
import { loadConfig } from './config.js';
import { createSpinner, Spinner } from './spinner.js';
import {
  createSession,
  appendUserMessage,
  appendAssistantMessage,
  appendToolResult,
} from './convex-client.js';

const MAX_TURNS = 500;
const MAX_OUTPUT_TOKENS = 393_216; // 384K max output tokens (DeepSeek limit)

// ── Terminal display helpers ────────────────────────────────────────

const COL = (): number => process.stdout.columns || 80;

// Gruvbox color palette
const GRUVBOX_GREEN = '\x1b[38;2;184;187;3m';   // bright green #b8bb26
const GRUVBOX_GRAY = '\x1b[38;2;146;131;116m';   // gray #928374
const GRUVBOX_RED = '\x1b[38;2;251;73;52m';      // bright red #fb4934
const GRUVBOX_FG = '\x1b[38;2;235;219;178m';     // foreground #ebdbb2
const GRUVBOX_DIM = '\x1b[38;2;102;92;84m';       // dark gray #665c54
const GRUVBOX_AQUA = '\x1b[38;2;142;192;124m';   // aqua #8ec07c
const RESET = '\x1b[0m';

/** File-oriented tools get green; bash/grep/find get grey */
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'stat']);

/** Tools whose execution lines are never shown to the user (silent) */
const SILENT_TOOLS = new Set(['diff']);

/** Build a compact tool detail string from args */
function toolDetail(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read': {
      let d = String(args.path || '?');
      if (args.offset) d += ` [L${args.offset}${args.limit ? `-${Number(args.offset) + Number(args.limit) - 1}` : '+'}]`;
      return d;
    }
    case 'write':
      return String(args.path || '?');
    case 'edit': {
      let d = String(args.path || '?');
      if (Array.isArray(args.edits)) d += ` (${args.edits.length} edit${args.edits.length !== 1 ? 's' : ''})`;
      return d;
    }
    case 'bash':
    case 'grep':
    case 'find':
    case 'ls':
      return String(args.command || args.pattern || args.path || '?');
    default:
      return JSON.stringify(args);
  }
}

/** Print a compact tool line: "  tool: detail…  ✓" with status right-aligned.
 *  Before printing, stop the spinner so the line renders clean. */
function displayToolLine(
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  spin: Spinner | null,
): void {
  // Silent tools — never show execution line
  if (SILENT_TOOLS.has(name)) return;

  // Stop spinner temporarily to print the tool line cleanly
  if (spin?.running) {
    spin.stop();
  }

  const statusIcon = ok ? '✓' : '✗';
  const statusColor = ok ? GRUVBOX_GREEN : GRUVBOX_RED;
  const toolColor = FILE_TOOLS.has(name) ? GRUVBOX_GREEN : GRUVBOX_GRAY;

  const prefix = `${toolColor}${name}${RESET}: `;
  const suffix = ` ${statusColor}${statusIcon}${RESET}`;

  let detail = toolDetail(name, args);

  process.stdout.write(`${prefix}${detail}${suffix}\n`);

  // Restart spinner after the tool line
  if (spin) {
    spin.start('Working…');
  }
}

// ── Convex helpers ──────────────────────────────────────────────────

async function safeCall<T>(fn: () => Promise<T>, label: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

// ── API retry with exponential backoff ─────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (err.name === 'AbortError' || err.name === 'Canceled') throw err;
      if (i < maxRetries && (err.status === 429 || err.status >= 500)) {
        const delay = baseDelay * Math.pow(2, i) + Math.random() * 1000;
        process.stderr.write(`${GRUVBOX_GRAY}[retry ${i + 1}/${maxRetries}] ${err.status || 'error'}, waiting ${(delay / 1000).toFixed(1)}s...${RESET}\n`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// ── Types ───────────────────────────────────────────────────────────

export interface AgentOptions {
  sessionId?: string;
  title?: string;
  history?: ChatCompletionMessageParam[];
  signal?: AbortSignal;
}

export interface AgentResult {
  text: string;
  sessionId: string;
  history: ChatCompletionMessageParam[];
}

// ── Response formatting ─────────────────────────────────────────────

function stripThinking(text: string): string {
  let cleaned = text.replace(/<thinking[^>]*>[\s\S]*?<\/thinking>/gi, '');
  cleaned = cleaned.replace(/<\/think>[\s\S]*?<\/think>/g, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned.trim();
}

/** Print the assistant's FINAL response — the summary shown when all work is done. */
export function printAssistantResponse(text: string): void {
  const cols = COL();

  const FG = '\x1b[38;2;235;219;178m';    // #ebdbb2
  const YELLOW = '\x1b[38;2;250;189;47m';   // #fabd2f
  const BLUE = '\x1b[38;2;131;165;152m';    // #83a598
  const GRAY = '\x1b[38;2;146;131;116m';    // #928374
  const DIM = '\x1b[38;2;102;92;84m';       // #665c54
  const CODE = '\x1b[38;2;213;196;161m';    // #d5c4a1
  const AQUA = '\x1b[38;2;142;192;124m';    // #8ec07c
  const RESET2 = '\x1b[0m';

  const pathRe = /\b(?:\.?\/?[\w.-]+)+\/[\w.-]+(?:\/[\w.-]+)*(?:\.\w+)?\b/;

  const sep = DIM + '─'.repeat(Math.min(cols - 2, 60)) + RESET2;
  console.log('');
  console.log(sep);

  const lines = text.split('\n');
  for (const line of lines) {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '');

    if (stripped.trim() === '') {
      console.log('');
      continue;
    }

    if (/^[─═━]{3,}/.test(stripped.trim()) && stripped.trim().length > 3) {
      console.log(DIM + line + RESET2);
      continue;
    }

    if (/^\s*─+\s*.+\s*─+\s*$/.test(stripped)) {
      console.log(YELLOW + line + RESET2);
      continue;
    }

    let baseColor = FG;
    let bulletMarker = '';
    let bulletRest = '';
    let bulletPrefix = '';

    const bulletMatch = stripped.match(/^(\s*)([•\-]|\d+\.)(\s)/);
    if (bulletMatch) {
      bulletPrefix = line.slice(0, bulletMatch[1].length);
      bulletMarker = line.slice(bulletMatch[1].length, bulletMatch[1].length + bulletMatch[2].length);
      bulletRest = line.slice(bulletMatch[1].length + bulletMatch[2].length);
    } else if (/^ {2,}(?!•|-|\d+\.)(\S)/.test(stripped)) {
      baseColor = CODE;
    }

    const content = bulletMatch ? bulletRest : line;

    if (pathRe.test(stripped)) {
      let colored = '';
      let lastIdx = 0;
      let match: RegExpExecArray | null;
      const re = new RegExp(pathRe.source, 'g');
      while ((match = re.exec(content)) !== null) {
        colored += content.slice(lastIdx, match.index) + BLUE + match[0] + RESET2;
        lastIdx = match.index + match[0].length;
      }
      colored += content.slice(lastIdx);

      if (bulletMatch) {
        console.log(bulletPrefix + AQUA + bulletMarker + RESET2 + baseColor + colored + RESET2);
      } else {
        console.log(baseColor + colored + RESET2);
      }
    } else if (bulletMatch) {
      console.log(bulletPrefix + AQUA + bulletMarker + RESET2 + baseColor + bulletRest + RESET2);
    } else {
      console.log(baseColor + line + RESET2);
    }
  }

  console.log(sep);
  console.log('');
}

// ── Agent loop ──────────────────────────────────────────────────────

export async function runAgent(
  userMessage: string,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const config = await loadConfig();

  if (!config.apiKey) {
    throw new Error(
      'No API key configured. Run with --setup to save your DeepSeek API key, or set DEEPSEEK_API_KEY env var.',
    );
  }

  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });

  const toolNames = TOOL_DEFS.map((t) => t.function.name);

  // Create or resume Convex session (best-effort)
  let sessionId = options.sessionId || 'local';
  const hasRealSession = sessionId !== 'local';
  const isNewSession = !options.sessionId;
  if (isNewSession) {
    const created = await safeCall(
      () =>
        createSession(
          config.convexUrl,
          options.title || userMessage.slice(0, 100),
          config.model,
          SYSTEM_PROMPT,
          toolNames,
        ),
      'createSession',
    );
    if (created) sessionId = created;
  }

  if (hasRealSession || sessionId !== 'local') {
    safeCall(() => appendUserMessage(config.convexUrl, sessionId, userMessage), 'appendUserMessage');
  }

  // Build message array: system prompt + existing history + new user message
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  if (options.history && options.history.length > 0) {
    for (const m of options.history) {
      if (m.role !== 'system') {
        messages.push(m);
      }
    }
  }

  messages.push({ role: 'user', content: userMessage });

  // ── Spinner for the agent loop ─────────────────────────────────
  const spin = createSpinner();
  spin.start('Thinking…');

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Check for cancellation (Ctrl+C)
    if (options.signal?.aborted) {
      spin.stop();
      const msg = '\n[Cancelled by user]';
      process.stderr.write(`${msg}\n`);
      return { text: msg, sessionId, history: messages };
    }

    // Update spinner message before API call
    spin.update('Thinking…');

    // ── Streaming API call — accumulate silently, only show final response ──
    let streamedContent = '';
    const streamedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let streamUsage: { input: number; output: number; total: number } | undefined;

    try {
      const stream: AsyncIterable<any> = await withRetry(async () => {
        return client.chat.completions.create({
          model: config.model,
          messages,
          tools: TOOL_DEFS,
          tool_choice: 'auto',
          temperature: 0.2,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
          stream_options: { include_usage: true },
          // Enable thinking/reasoning — DeepSeek specific params
          ...(({
            thinking: { type: 'enabled' },
            reasoning_effort: 'max',
          } as any)),
        }) as unknown as AsyncIterable<any>;
      }) as AsyncIterable<any>;

      for await (const chunk of stream) {
        // Check cancellation mid-stream
        if (options.signal?.aborted) break;

        const delta = (chunk as any).choices?.[0]?.delta;
        if (!delta) {
          // Usage chunk (final chunk with stream_options.include_usage)
          if ((chunk as any).usage) {
            streamUsage = {
              input: (chunk as any).usage.prompt_tokens || 0,
              output: (chunk as any).usage.completion_tokens || 0,
              total: (chunk as any).usage.total_tokens || 0,
            };
          }
          continue;
        }

        // Accumulate text content (silently — not shown to user)
        if (delta.content) {
          streamedContent += delta.content;
        }

        // Accumulate tool calls (they come in fragments across chunks)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!streamedToolCalls.has(idx)) {
              streamedToolCalls.set(idx, { id: '', name: '', arguments: '' });
            }
            const entry = streamedToolCalls.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }

        // Update spinner occasionally (not on every chunk to avoid flicker)
        spin.update('Thinking…');
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'Canceled') {
        spin.stop();
        const msg = '\n[Cancelled by user]';
        return { text: msg, sessionId, history: messages };
      }
      throw err;
    }

    // Cancelled mid-stream
    if (options.signal?.aborted) {
      spin.stop();
      const msg = '\n[Cancelled by user]';
      return { text: msg, sessionId, history: messages };
    }

    const hasToolCalls = streamedToolCalls.size > 0;

    // ── Tool calls — show what commands are being executed ─────────
    if (hasToolCalls) {
      // Convert Map to array in index order
      const toolCallArray = Array.from(streamedToolCalls.entries())
        .sort(([a], [b]) => a - b)
        .map(([_, tc]) => tc);

      const toolCallsMeta = toolCallArray.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }));

      safeCall(
        () =>
          appendAssistantMessage(
            config.convexUrl,
            sessionId,
            streamedContent || null,
            toolCallsMeta.length > 0 ? toolCallsMeta : null,
            streamUsage,
          ),
        'appendAssistantMessage',
      );

      // Build tool_calls in OpenAI format for history
      const openaiToolCalls = toolCallArray.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));

      messages.push({
        role: 'assistant',
        content: streamedContent || null,
        tool_calls: openaiToolCalls,
      } as ChatCompletionMessageParam);

      // Execute each tool call, showing what's running
      for (const tc of toolCallArray) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch { /* keep empty */ }

        // Update spinner to show what we're about to run
        spin.update(`Running ${tc.name}…`);

        const result = await executeTool(
          {
            id: tc.id,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          },
          config.workDir,
        );

        const ok = !result.content.startsWith('Error');

        // Display the tool line (stops spinner, prints line, restarts spinner)
        // Silent tools (e.g. diff) are suppressed inside displayToolLine
        displayToolLine(tc.name, args, ok, spin);

        messages.push({
          role: 'tool',
          tool_call_id: result.tool_call_id,
          content: result.content,
        } as unknown as ChatCompletionMessageParam);

        const isError = !ok;
        safeCall(
          () =>
            appendToolResult(
              config.convexUrl,
              sessionId,
              result.tool_call_id,
              tc.name,
              result.content,
              isError,
            ),
          'appendToolResult',
        );
      }

      // Continue loop to next API call (spinner still running)
      continue;
    }

    // ── Final text response — the summary ──────────────────────────
    spin.stop();

    const text = stripThinking(streamedContent) || '(empty response)';

    safeCall(
      () => appendAssistantMessage(config.convexUrl, sessionId, text, null, streamUsage),
      'appendAssistantMessage',
    );

    // Print a blank line then the final summary
    console.log('');
    printAssistantResponse(text);

    return { text, sessionId, history: messages };
  }

  // Max turns reached
  spin.stop();
  const msg = 'Agent reached maximum turns without completing the task.';
  safeCall(() => appendAssistantMessage(config.convexUrl, sessionId, msg, null), 'appendAssistantMessage');
  return { text: msg, sessionId, history: messages };
}
