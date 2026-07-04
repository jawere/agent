import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

// ── Deserialized message row (tool_calls stored as JSON string) ──
interface DeserializedMessage {
  role: string;
  content?: string | null;
  tool_calls?: string | null;
  tool_call_id?: string | null;
  name?: string | null;
}

// ── Types ───────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  name: string | null;
}

// ── Database ────────────────────────────────────────────────────────

let db: Database.Database | null = null;

function getDbPath(workDir: string): string {
  const dir = resolve(workDir, '.codebase');
  return resolve(dir, 'sessions.db');
}

export function initDb(workDir: string): Database.Database {
  if (db) return db;

  const dbPath = getDbPath(workDir);
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      name TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, id);
  `);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Session helpers ─────────────────────────────────────────────────

export function createSession(): string {
  if (!db) throw new Error('Database not initialized');
  const id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return id;
}

export function listSessions(limit = 20): SessionRow[] {
  if (!db) return [];
  const rows = db.prepare(`
    SELECT
      session_id AS id,
      MIN(created_at) AS created_at,
      MAX(created_at) AS updated_at,
      COUNT(*) AS message_count
    FROM messages
    GROUP BY session_id
    ORDER BY MAX(created_at) DESC
    LIMIT ?
  `).all(limit) as SessionRow[];
  return rows;
}

export function getSessionMessages(sessionId: string): ChatCompletionMessageParam[] {
  if (!db) return [];
  const rows = db.prepare(`
    SELECT role, content, tool_calls, tool_call_id, name
    FROM messages
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(sessionId) as MessageRow[];

  const messages: ChatCompletionMessageParam[] = [];
  for (const row of rows) {
    const msg: DeserializedMessage = { role: row.role };

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

    messages.push(msg as ChatCompletionMessageParam);
  }

  return messages;
}

export function deleteSession(sessionId: string): boolean {
  if (!db) return false;
  const result = db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  return result.changes > 0;
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

export function persistMessages(sessionId: string, messages: ChatCompletionMessageParam[]): void {
  if (!db) return;
  if (messages.length === 0) return;
  if (messages[0]?.role === 'system') return; // system prompt isn't persisted

  // Get the current count for this session to know which messages are new
  const existingCount = (db.prepare(
    'SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?'
  ).get(sessionId) as { cnt: number })?.cnt || 0;

  // Only persist messages from index `existingCount` onward (exclude system prompt offset)
  // The messages array includes system prompt as [0], so new messages start at index 1 + existingCount
  const startIdx = existingCount + 1; // +1 to skip system prompt already counted

  const insert = db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const batchInsert = db.transaction((msgs: ChatCompletionMessageParam[]) => {
    for (const m of msgs) {
      if (m.role === 'system') continue;
      const s = serializeMessage(m);
      insert.run(sessionId, s.role, s.content, s.tool_calls, s.tool_call_id, s.name);
    }
  });

  // Only persist new messages (those after startIdx)
  const newMessages = messages.slice(startIdx);
  if (newMessages.length > 0) {
    batchInsert(newMessages);
  }
}

/** Replace all messages for a session (used when continuing a loaded session) */
export function replaceSessionMessages(sessionId: string, messages: ChatCompletionMessageParam[]): void {
  if (!db) return;
  const del = db.prepare('DELETE FROM messages WHERE session_id = ?');
  const insert = db.prepare(`
    INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const writeAll = db.transaction((msgs: ChatCompletionMessageParam[]) => {
    del.run(sessionId);
    for (const m of msgs) {
      if (m.role === 'system') continue;
      const s = serializeMessage(m);
      insert.run(sessionId, s.role, s.content, s.tool_calls, s.tool_call_id, s.name);
    }
  });

  writeAll(messages);
}
