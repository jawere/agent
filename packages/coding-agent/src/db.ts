import { resolve, dirname } from 'path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// ── Types ───────────────────────────────────────────────────────────

export interface SessionRow {
  id: number;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface MessageRow {
  id: number;
  session_id: number;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  name: string | null;
  created_at: string;
}

// ── JSON file store ─────────────────────────────────────────────────
// Pure JS — no native dependencies, no better-sqlite3

interface StoreData {
  nextId: number;
  nextSessionId: number;
  messages: MessageRow[];
}

let storePath: string | null = null;
let store: StoreData = { nextId: 1, nextSessionId: 1, messages: [] };

function getStorePath(workDir: string): string {
  const dir = resolve(workDir, '.codebase');
  return resolve(dir, 'sessions.json');
}

function loadStore(): void {
  if (!storePath) return;
  try {
    const raw = readFileSync(storePath, 'utf-8');
    const parsed = JSON.parse(raw);
    store = {
      nextId: parsed.nextId ?? 1,
      nextSessionId: parsed.nextSessionId ?? 1,
      messages: parsed.messages ?? [],
    };
  } catch {
    // File doesn't exist or is corrupt — start fresh
    store = { nextId: 1, nextSessionId: 1, messages: [] };
  }
}

function saveStore(): void {
  if (!storePath) return;
  const dir = dirname(storePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(storePath, JSON.stringify(store), 'utf-8');
}

export function initDb(workDir: string): StoreData {
  if (storePath) return store;

  storePath = getStorePath(workDir);
  loadStore();
  return store;
}

export function closeDb(): void {
  if (storePath) {
    saveStore();
    storePath = null;
    store = { nextId: 1, nextSessionId: 1, messages: [] };
  }
}

// ── Session helpers ─────────────────────────────────────────────────

export function createSession(): number {
  if (!storePath) throw new Error('Database not initialized');
  const id = store.nextSessionId++;
  saveStore();
  return id;
}

export function listSessions(limit = 20): SessionRow[] {
  if (!storePath) return [];

  const sessionMap = new Map<number, { created_at: string; updated_at: string; count: number }>();
  for (const msg of store.messages) {
    const existing = sessionMap.get(msg.session_id);
    if (existing) {
      if (msg.created_at < existing.created_at) existing.created_at = msg.created_at;
      if (msg.created_at > existing.updated_at) existing.updated_at = msg.created_at;
      existing.count++;
    } else {
      sessionMap.set(msg.session_id, {
        created_at: msg.created_at,
        updated_at: msg.created_at,
        count: 1,
      });
    }
  }

  const sessions: SessionRow[] = [];
  for (const [id, info] of sessionMap) {
    sessions.push({ id, ...info, message_count: info.count });
  }

  // Sort by updated_at descending, take top N
  sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return sessions.slice(0, limit);
}

export function getSessionMessages(sessionId: number): ChatCompletionMessageParam[] {
  if (!storePath) return [];

  const rows = store.messages
    .filter((m) => m.session_id === sessionId)
    .sort((a, b) => a.id - b.id);

  const messages: ChatCompletionMessageParam[] = [];
  for (const row of rows) {
    const msg: Record<string, unknown> = { role: row.role };

    if (row.content !== null) {
      msg.content = row.content;
    }

    if (row.tool_calls) {
      try {
        msg.tool_calls = JSON.parse(row.tool_calls);
      } catch {
        // ignore corrupt tool_calls
      }
    }

    if (row.tool_call_id) {
      msg.tool_call_id = row.tool_call_id;
    }

    if (row.name) {
      msg.name = row.name;
    }

    messages.push(msg as unknown as ChatCompletionMessageParam);
  }

  return messages;
}

export function deleteSession(sessionId: number): boolean {
  if (!storePath) return false;
  const before = store.messages.length;
  store.messages = store.messages.filter((m) => m.session_id !== sessionId);
  const deleted = before - store.messages.length;
  if (deleted > 0) saveStore();
  return deleted > 0;
}

// ── Serialization helper ────────────────────────────────────────────

interface MessageRowParams {
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  name: string | null;
}

function serializeMessage(m: ChatCompletionMessageParam): MessageRowParams {
  const ext = m as unknown as Record<string, unknown>;
  return {
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : null,
    tool_calls: ext.tool_calls ? JSON.stringify(ext.tool_calls) : null,
    tool_call_id: (ext.tool_call_id as string) || null,
    name: (ext.name as string) || null,
  };
}

// ── Message persistence ─────────────────────────────────────────────

export function persistMessages(sessionId: number, messages: ChatCompletionMessageParam[]): void {
  if (!storePath) return;
  if (messages.length === 0) return;
  // Strip system messages from the incoming batch first
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  if (nonSystemMessages.length === 0) return;

  // Count existing non-system messages for this session
  const existingCount = store.messages.filter((m) => m.session_id === sessionId).length;

  // Only persist messages from index `existingCount` onward (in non-system array)
  const newMessages = nonSystemMessages.slice(existingCount);

  if (newMessages.length === 0) return;

  const now = new Date().toISOString();
  for (const m of newMessages) {
    const s = serializeMessage(m);
    store.messages.push({
      id: store.nextId++,
      session_id: sessionId,
      role: s.role,
      content: s.content,
      tool_calls: s.tool_calls,
      tool_call_id: s.tool_call_id,
      name: s.name,
      created_at: now,
    });
  }

  saveStore();
}

/** Replace all messages for a session (used when continuing a loaded session) */
export function replaceSessionMessages(sessionId: number, messages: ChatCompletionMessageParam[]): void {
  if (!storePath) return;

  // Delete existing messages for this session
  store.messages = store.messages.filter((m) => m.session_id !== sessionId);

  // Insert new messages
  const now = new Date().toISOString();
  for (const m of messages) {
    if (m.role === 'system') continue;
    const s = serializeMessage(m);
    store.messages.push({
      id: store.nextId++,
      session_id: sessionId,
      role: s.role,
      content: s.content,
      tool_calls: s.tool_calls,
      tool_call_id: s.tool_call_id,
      name: s.name,
      created_at: now,
    });
  }

  saveStore();
}
