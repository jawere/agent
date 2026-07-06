// @jawere/coding-agent — Session class (tree-based session management)

import type { AgentMessage } from "@jawere/agent";
import type {
  SessionStorage,
  SessionMetadata,
  SessionTreeEntry,
  SessionContext,
  MessageEntry,
  ThinkingLevelChangeEntry,
  ModelChangeEntry,
  CompactionEntry,
  BranchSummaryEntry,
  CustomEntry,
  CustomMessageEntry,
  LabelEntry,
  SessionInfoEntry,
} from "./types.js";
import { SessionError } from "./types.js";

// ── Context builder ──────────────────────────────────────────────────

function appendMessage(messages: AgentMessage[], entry: SessionTreeEntry): void {
  if (entry.type === "message") {
    messages.push((entry as MessageEntry).message as AgentMessage);
  } else if (entry.type === "custom_message") {
    const cm = entry as CustomMessageEntry;
    messages.push({
      role: "user",
      content: typeof cm.content === "string"
        ? [{ type: "text", text: cm.content }]
        : cm.content,
      // @ts-ignore — custom metadata fields
      custom_type: cm.customType,
      display: cm.display,
    } as any);
  } else if (entry.type === "branch_summary") {
    const bs = entry as BranchSummaryEntry;
    if (bs.summary) {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `[Branch summary: ${bs.summary}]` }],
      } as AgentMessage);
    }
  }
}

export function buildSessionContext(pathEntries: SessionTreeEntry[]): SessionContext {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  let compaction: CompactionEntry | null = null;

  for (const entry of pathEntries) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = (entry as ThinkingLevelChangeEntry).thinkingLevel;
    } else if (entry.type === "model_change") {
      const mc = entry as ModelChangeEntry;
      model = { provider: mc.provider, modelId: mc.modelId };
    } else if (entry.type === "message" && (entry as MessageEntry).message.role === "assistant") {
      const msg = (entry as MessageEntry).message as any;
      if (msg.model) {
        model = { provider: msg.provider ?? "", modelId: msg.model };
      }
    } else if (entry.type === "compaction") {
      compaction = entry as CompactionEntry;
    }
  }

  const messages: AgentMessage[] = [];

  if (compaction) {
    // Push compaction summary
    messages.push({
      role: "user",
      content: [{ type: "text", text: `[Compaction summary: ${compaction.summary}]` }],
    } as AgentMessage);

    const compactionIdx = pathEntries.findIndex(
      (e) => e.type === "compaction" && e.id === compaction!.id,
    );

    // Walk entries: skip pre-compaction entries until firstKeptEntryId
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = pathEntries[i]!;
      if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) appendMessage(messages, entry);
    }

    // Everything after compaction is included
    for (let i = compactionIdx + 1; i < pathEntries.length; i++) {
      appendMessage(messages, pathEntries[i]!);
    }
  } else {
    for (const entry of pathEntries) {
      appendMessage(messages, entry);
    }
  }

  return { messages, thinkingLevel, model };
}

// ── Session class ────────────────────────────────────────────────────

export class Session<TMetadata extends SessionMetadata = SessionMetadata> {
  private storage: SessionStorage<TMetadata>;

  constructor(storage: SessionStorage<TMetadata>) {
    this.storage = storage;
  }

  // ── Accessors ───────────────────────────────────────────────────

  getMetadata(): Promise<TMetadata> {
    return this.storage.getMetadata();
  }

  getStorage(): SessionStorage<TMetadata> {
    return this.storage;
  }

  getLeafId(): Promise<string | null> {
    return this.storage.getLeafId();
  }

  getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    return this.storage.getEntry(id);
  }

  getEntries(): Promise<SessionTreeEntry[]> {
    return this.storage.getEntries();
  }

  /** Get the full branch (path from root to current leaf). */
  async getBranch(fromId?: string): Promise<SessionTreeEntry[]> {
    const leafId = fromId ?? (await this.storage.getLeafId());
    return this.storage.getPathToRoot(leafId);
  }

  /** Build model-visible context from the current branch. */
  async buildContext(): Promise<SessionContext> {
    return buildSessionContext(await this.getBranch());
  }

  getLabel(id: string): Promise<string | undefined> {
    return this.storage.getLabel(id);
  }

  async getSessionName(): Promise<string | undefined> {
    const entries = await this.storage.findEntries("session_info");
    return (entries[entries.length - 1] as SessionInfoEntry)?.name?.trim() || undefined;
  }

  // ── Append helpers ──────────────────────────────────────────────

  private async appendTypedEntry<TEntry extends SessionTreeEntry>(entry: TEntry): Promise<string> {
    await this.storage.appendEntry(entry);
    return entry.id;
  }

  async appendMessage(message: AgentMessage): Promise<string> {
    return this.appendTypedEntry({
      type: "message",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      message,
    } as MessageEntry);
  }

  async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
    return this.appendTypedEntry({
      type: "thinking_level_change",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      thinkingLevel,
    } as ThinkingLevelChangeEntry);
  }

  async appendModelChange(provider: string, modelId: string): Promise<string> {
    return this.appendTypedEntry({
      type: "model_change",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    } as ModelChangeEntry);
  }

  async appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
  ): Promise<string> {
    return this.appendTypedEntry({
      type: "compaction",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
    } as CompactionEntry<T>);
  }

  async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
    return this.appendTypedEntry({
      type: "custom",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      customType,
      data,
    } as CustomEntry);
  }

  async appendLabel(targetId: string, label: string | undefined): Promise<string> {
    if (!(await this.storage.getEntry(targetId))) {
      throw new SessionError("not_found", `Entry ${targetId} not found`);
    }
    return this.appendTypedEntry({
      type: "label",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      targetId,
      label,
    } as LabelEntry);
  }

  async appendSessionName(name: string): Promise<string> {
    const sanitized = name.replace(/[\r\n]+/g, " ").trim();
    return this.appendTypedEntry({
      type: "session_info",
      id: await this.storage.createEntryId(),
      parentId: await this.storage.getLeafId(),
      timestamp: new Date().toISOString(),
      name: sanitized,
    } as SessionInfoEntry);
  }

  // ── Tree navigation ─────────────────────────────────────────────

  /**
   * Move the session's current position to a different entry.
   * Optionally provide a summary of the branch being left.
   */
  async moveTo(
    entryId: string | null,
    summary?: { summary: string; details?: unknown },
  ): Promise<string | undefined> {
    if (entryId !== null && !(await this.storage.getEntry(entryId))) {
      throw new SessionError("not_found", `Entry ${entryId} not found`);
    }
    await this.storage.setLeafId(entryId);
    if (!summary) return undefined;
    return this.appendTypedEntry({
      type: "branch_summary",
      id: await this.storage.createEntryId(),
      parentId: entryId,
      timestamp: new Date().toISOString(),
      fromId: entryId ?? "root",
      summary: summary.summary,
      details: summary.details,
    } as BranchSummaryEntry);
  }
}
