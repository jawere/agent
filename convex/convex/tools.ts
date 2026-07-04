import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** List all custom tools */
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tools").collect();
  },
});

/** Get a tool by name */
export const getByName = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
  },
});

/** Register a new custom tool */
export const register = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    parameters: v.any(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (existing) {
      // Update existing
      await ctx.db.patch(existing._id, {
        description: args.description,
        parameters: args.parameters,
      });
      return existing._id;
    }
    return await ctx.db.insert("tools", {
      name: args.name,
      description: args.description,
      parameters: args.parameters,
      isBuiltin: false,
      createdAt: Date.now(),
    });
  },
});

/** Remove a custom tool */
export const remove = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const tool = await ctx.db
      .query("tools")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .first();
    if (tool && !tool.isBuiltin) {
      await ctx.db.delete(tool._id);
    }
  },
});
