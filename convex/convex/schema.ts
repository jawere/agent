import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // User-owned sessions (conversations)
  sessions: defineTable({
    title: v.string(),
    model: v.string(),
    systemPrompt: v.string(),
    toolNames: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    // Clerk user ID (auth placeholder for now)
    userId: v.optional(v.string()),
  }).index("by_updated", ["updatedAt"]),

  // Individual messages in a session
  messages: defineTable({
    sessionId: v.id("sessions"),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("toolResult")),
    content: v.array(
      v.object({
        type: v.string(),
        text: v.optional(v.string()),
        id: v.optional(v.string()),
        name: v.optional(v.string()),
        arguments: v.optional(v.any()),
        toolCallId: v.optional(v.string()),
        content: v.optional(v.string()),
      })
    ),
    timestamp: v.number(),
    stopReason: v.optional(v.string()),
    toolCallId: v.optional(v.string()),
    toolName: v.optional(v.string()),
    isError: v.optional(v.boolean()),
    usage: v.optional(
      v.object({
        input: v.number(),
        output: v.number(),
        total: v.number(),
      })
    ),
  }).index("by_session", ["sessionId"]),

  // Custom tool definitions (user-extensible tools)
  tools: defineTable({
    name: v.string(),
    description: v.string(),
    parameters: v.any(), // JSON Schema
    isBuiltin: v.boolean(),
    createdBy: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_name", ["name"]),

  // Usage tracking per session/day
  usage: defineTable({
    sessionId: v.id("sessions"),
    date: v.string(), // YYYY-MM-DD
    model: v.string(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    totalTokens: v.number(),
  }).index("by_session_date", ["sessionId", "date"]),
});
