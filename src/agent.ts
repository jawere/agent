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
const MAX_OUTPUT_TOKENS = 300_000; // 300k max output tokens

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

    const response = await withRetry(() => {
      return client.chat.completions.create({
        model: config.model,
        messages,
        tools: TOOL_DEFS,
        tool_choice: 'auto',
        temperature: 0.2,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Enable thinking/reasoning — DeepSeek specific params
        ...(({
          thinking: { type: 'enabled' },
          reasoning_effort: 'max',
        } as any)),
      });
    }).catch((err) => {
      if (err.name === 'AbortError' || err.name === 'Canceled') {
        return null as any;
      }
      throw err;
    });

    // Cancelled mid-request
    if (!response) {
      spin.stop();
      const msg = '\n[Cancelled by user]';
      return { text: msg, sessionId, history: messages };
    }

    const choice = response.choices[0];
    if (!choice) {
      spin.stop();
      safeCall(
        () => appendAssistantMessage(config.convexUrl, sessionId, '(error: no response)', null),
        'appendAssistantMessage',
      );
      return { text: 'Error: No response from model.', sessionId, history: messages };
    }

    const { message } = choice;

    const usage = response.usage
      ? {
          input: response.usage.prompt_tokens || 0,
          output: response.usage.completion_tokens || 0,
          total: response.usage.total_tokens || 0,
        }
      : undefined;

    // ── Tool calls — show what commands are being executed ─────────
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCallsMeta = message.tool_calls.map((tc: any) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

      safeCall(
        () =>
          appendAssistantMessage(
            config.convexUrl,
            sessionId,
            message.content || null,
            toolCallsMeta.length > 0 ? toolCallsMeta : null,
            usage,
          ),
        'appendAssistantMessage',
      );

      messages.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.tool_calls,
      } as ChatCompletionMessageParam);

      // Execute each tool call, showing what's running
      for (const tc of message.tool_calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments);
        } catch { /* keep empty */ }

        // Update spinner to show what we're about to run
        spin.update(`Running ${tc.function.name}…`);

        const result = await executeTool(
          {
            id: tc.id,
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          },
          config.workDir,
        );

        const ok = !result.content.startsWith('Error');

        // Display the tool line (stops spinner, prints line, restarts spinner)
        displayToolLine(tc.function.name, args, ok, spin);

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
              tc.function.name,
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

    const rawText = (message as any).content || '';
    const text = stripThinking(rawText) || '(empty response)';

    safeCall(
      () => appendAssistantMessage(config.convexUrl, sessionId, text, null, usage),
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
