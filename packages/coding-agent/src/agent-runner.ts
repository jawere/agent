// @jawere/coding-agent — Display subscriber for Pi RPC agent events

import {
  createSpinner,
  type Spinner,
  writeToolLine,
  writeAssistantResponse,
  stripThinking,
} from "@jawere/tui";
import type { AgentEvent, AgentMessage } from "./pi-rpc-agent.js";

// ── Display subscriber ───────────────────────────────────────────────

/** State tracked across agent turns for terminal display */
export interface DisplayState {
  spinner: Spinner;
  /** Maps toolCallId → parsed args for tool line rendering */
  pendingToolArgs: Map<string, Record<string, unknown>>;
  /** Number of tools executed this turn */
  toolCount: number;
  /** Accumulated text from message_update events (streaming) */
  streamedText: string[];
}

/**
 * Create a subscriber that handles agent events from Pi's RPC stdout.
 *
 * Pi's AgentEvent types (defined in pi-rpc-agent.ts):
 * - turn_start → start spinner
 * - tool_execution_start → capture args for later display
 * - tool_execution_end → stop spinner, write tool line with checkmark/cross
 * - turn_end → stop spinner, render markdown assistant text (if no tools)
 * - agent_end → stop spinner
 */
export function createDisplaySubscriber(state: DisplayState) {
  return async (event: AgentEvent, _signal: AbortSignal): Promise<void> => {
    switch (event.type) {
      case "turn_start":
        state.pendingToolArgs = new Map();
        state.toolCount = 0;
        state.streamedText = [];
        state.spinner.start("Thinking…");
        break;

      case "message_update": {
        // Accumulate streaming text from assistant
        const msg = event.message;
        if (msg.role === "assistant" && msg.content) {
          const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
          for (const block of content) {
            if (block.type === "text" && block.text) {
              state.streamedText.push(block.text);
            }
          }
        }
        break;
      }

      case "tool_execution_start": {
        // Pi sends args as a parsed object. JSON-parse for belt-and-suspenders.
        let args: Record<string, unknown> = {};
        try {
          args = typeof event.args === "string"
            ? JSON.parse(event.args)
            : (event.args as Record<string, unknown>) ?? {};
        } catch {
          // keep empty args
        }
        state.pendingToolArgs.set(event.toolCallId, args);
        break;
      }

      case "tool_execution_end":
        state.spinner.stop();
        {
          const args = state.pendingToolArgs.get(event.toolCallId) ?? {};
          state.pendingToolArgs.delete(event.toolCallId);
          writeToolLine(event.toolName, args, event.isError);
          state.toolCount++;
        }
        break;

      case "turn_end":
        state.spinner.stop();
        {
          const msg = event.message;
          const hasToolCalls = event.toolResults.length > 0 || state.toolCount > 0;

          if (!hasToolCalls && msg.role === "assistant" && msg.content) {
            const content = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
            const textBlocks = content
              .filter((c: Record<string, unknown>) => c.type === "text")
              .map((c: Record<string, unknown>) => String(c.text ?? ""))
              .join("");
            const cleanText = stripThinking(textBlocks);
            if (cleanText.trim()) {
              writeAssistantResponse(cleanText);
            }
          }
        }
        break;

      case "agent_end":
        state.spinner.stop();
        break;

      // message_start/message_end/tool_execution_update/agent_start — no display action
      default:
        break;
    }
  };
}


