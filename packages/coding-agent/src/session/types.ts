// @jawere/coding-agent — Session tree entry types
// JSONL session format version 3 (pi-compatible)

import type { AgentMessage } from "@jawere/agent";

// ── Error types ──────────────────────────────────────────────────────

export class SessionError extends Error {
  public code: string;

  constructor(code: string, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionError";
    this.code = code;
  }
}

// ── Entry base ───────────────────────────────────────────────────────

export interface SessionTreeEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

// ── Entry types ──────────────────────────────────────────────────────

export interface MessageEntry extends SessionTreeEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionTreeEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionTreeEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionTreeEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionTreeEntryBase {
  type: "custom";
  customType: string;
  data?: T;
}

export interface CustomMessageEntry<T = unknown> extends SessionTreeEntryBase {
  type: "custom_message";
  customType: string;
  content: string | any[];
  details?: T;
  display: boolean;
}

export interface LabelEntry extends SessionTreeEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionTreeEntryBase {
  type: "session_info";
  name?: string;
}

/** Internal-only: tracks the current leaf position. Never exposed to the model. */
export interface LeafEntry extends SessionTreeEntryBase {
  type: "leaf";
  targetId: string | null;
}

// ── Union type ───────────────────────────────────────────────────────

export type SessionTreeEntry =
  | MessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry
  | LeafEntry;

// ── Metadata ─────────────────────────────────────────────────────────

export interface SessionMetadata {
  id: string;
  createdAt: string;
  /** Display name set via session info entries */
  name?: string;
  /** Message count */
  messageCount?: number;
}

export interface JsonlSessionMetadata extends SessionMetadata {
  cwd: string;
  path: string;
  parentSessionPath?: string;
}

// ── Session context (model-visible) ──────────────────────────────────

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

// ── Storage interface ────────────────────────────────────────────────

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLeafId(): Promise<string | null>;
  setLeafId(leafId: string | null): Promise<void>;
  createEntryId(): Promise<string>;
  appendEntry(entry: SessionTreeEntry): Promise<void>;
  getEntry(id: string): Promise<SessionTreeEntry | undefined>;
  getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
  getEntries(): Promise<SessionTreeEntry[]>;
  getLabel(id: string): Promise<string | undefined>;
  findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType,
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
}

// ── JSONL header ─────────────────────────────────────────────────────

export interface SessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}
