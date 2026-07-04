// ── Types ───────────────────────────────────────────────────────────

export interface SessionInfo {
  _id: string;
  _creationTime: number;
  title: string;
  model: string;
  systemPrompt: string;
  toolNames: string[];
  createdAt: number;
  updatedAt: number;
}

export interface MessageContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  toolCallId?: string;
  content?: string;
}

// ── Convex HTTP helpers ─────────────────────────────────────────────

async function convexMutation(
  convexUrl: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${convexUrl}/api/mutation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: name, format: 'json', args }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Convex mutation ${name} failed (${res.status}): ${err}`);
  }
  const json = await res.json();
  if (json.status === 'error') {
    throw new Error(`Convex mutation ${name} error: ${json.errorMessage || JSON.stringify(json)}`);
  }
  // Convex wraps results in { status: "success", value: ... }
  return json.value;
}

async function convexQuery(
  convexUrl: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const res = await fetch(`${convexUrl}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: name, format: 'json', args }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Convex query ${name} failed (${res.status}): ${err}`);
  }
  const json = await res.json();
  if (json.status === 'error') {
    throw new Error(`Convex query ${name} error: ${json.errorMessage || JSON.stringify(json)}`);
  }
  // Convex wraps results in { status: "success", value: ... }
  return json.value;
}

// ── Session operations ──────────────────────────────────────────────

/** Create a new session in Convex. Returns the session ID. */
export async function createSession(
  convexUrl: string,
  title: string,
  model: string,
  systemPrompt: string,
  toolNames: string[],
): Promise<string> {
  return convexMutation(convexUrl, 'sessions:create', {
    title,
    model,
    systemPrompt,
    toolNames,
  });
}

/** Append a user message to the session */
export async function appendUserMessage(
  convexUrl: string,
  sessionId: string,
  text: string,
): Promise<string> {
  return convexMutation(convexUrl, 'sessions:appendMessage', {
    sessionId,
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  });
}

/** Append an assistant message (with optional tool calls and usage) */
export async function appendAssistantMessage(
  convexUrl: string,
  sessionId: string,
  text: string | null,
  toolCalls: Array<{ id: string; name: string; arguments: string }> | null,
  usage?: { input: number; output: number; total: number },
): Promise<string> {
  const content: MessageContent[] = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  if (toolCalls) {
    for (const tc of toolCalls) {
      content.push({
        type: 'tool_call',
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      });
    }
  }
  return convexMutation(convexUrl, 'sessions:appendMessage', {
    sessionId,
    role: 'assistant',
    content,
    timestamp: Date.now(),
    usage,
  });
}

/** Append a tool result message */
export async function appendToolResult(
  convexUrl: string,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  result: string,
  isError: boolean,
): Promise<string> {
  return convexMutation(convexUrl, 'sessions:appendMessage', {
    sessionId,
    role: 'toolResult',
    content: [{ type: 'tool_result', toolCallId, content: result }],
    toolCallId,
    toolName,
    isError,
    timestamp: Date.now(),
  });
}

/** List recent sessions */
export async function listSessions(convexUrl: string): Promise<SessionInfo[]> {
  return convexQuery(convexUrl, 'sessions:list', {});
}

/** Get a full session with messages */
export async function getSession(
  convexUrl: string,
  sessionId: string,
): Promise<(SessionInfo & { messages: any[] }) | null> {
  return convexQuery(convexUrl, 'sessions:get', { sessionId });
}
