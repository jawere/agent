import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { api } from "./_generated/api";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Get all sessions ordered by most recent activity */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("sessions").order("desc").take(100);
  },
});

/** Get a single session with all its messages */
export const get = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .order("asc")
      .collect();
    return { ...session, messages };
  },
});

/** Get aggregated usage for a session */
export const getUsage = query({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("usage")
      .withIndex("by_session_date", (q) => q.eq("sessionId", args.sessionId))
      .collect();
  },
});

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Create a new session */
export const create = mutation({
  args: {
    title: v.string(),
    model: v.string(),
    systemPrompt: v.string(),
    toolNames: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("sessions", {
      title: args.title,
      model: args.model,
      systemPrompt: args.systemPrompt,
      toolNames: args.toolNames,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Append a message to a session */
export const appendMessage = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    // Insert the message
    const msgId = await ctx.db.insert("messages", {
      sessionId: args.sessionId,
      role: args.role,
      content: args.content,
      timestamp: args.timestamp,
      stopReason: args.stopReason,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      isError: args.isError,
      usage: args.usage,
    });

    // Update session timestamp
    await ctx.db.patch(args.sessionId, { updatedAt: Date.now() });

    // Track usage if present
    if (args.usage && args.usage.total > 0) {
      const date = new Date(args.timestamp).toISOString().slice(0, 10);
      const session = await ctx.db.get(args.sessionId);

      // Upsert: check if a usage row already exists for this session+date
      const existing = await ctx.db
        .query("usage")
        .withIndex("by_session_date", (q) =>
          q.eq("sessionId", args.sessionId).eq("date", date)
        )
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          inputTokens: existing.inputTokens + args.usage.input,
          outputTokens: existing.outputTokens + args.usage.output,
          totalTokens: existing.totalTokens + args.usage.total,
        });
      } else {
        await ctx.db.insert("usage", {
          sessionId: args.sessionId,
          date,
          model: session?.model ?? "unknown",
          inputTokens: args.usage.input,
          outputTokens: args.usage.output,
          totalTokens: args.usage.total,
        });
      }
    }

    return msgId;
  },
});

/** Delete a session and all its messages/usage */
export const remove = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    for (const msg of messages) {
      await ctx.db.delete(msg._id);
    }
    const usageRows = await ctx.db
      .query("usage")
      .withIndex("by_session_date", (q) => q.eq("sessionId", args.sessionId))
      .collect();
    for (const row of usageRows) {
      await ctx.db.delete(row._id);
    }
    await ctx.db.delete(args.sessionId);
  },
});
