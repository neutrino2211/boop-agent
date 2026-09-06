import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    promptId: v.string(),
    prompt: v.string(),
    integrations: v.array(v.string()),
    conversationId: v.optional(v.string()),
    notifyConversationId: v.optional(v.string()),
    runAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("scheduledPrompts", {
      ...args,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const listDue = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    return await ctx.db
      .query("scheduledPrompts")
      .withIndex("by_status_run_at", (q) =>
        q.eq("status", "pending").lte("runAt", now),
      )
      .collect();
  },
});

export const markRunning = mutation({
  args: { promptId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scheduledPrompts")
      .withIndex("by_prompt_id", (q) => q.eq("promptId", args.promptId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "running" });
    return row._id;
  },
});

export const markDone = mutation({
  args: {
    promptId: v.string(),
    result: v.string(),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scheduledPrompts")
      .withIndex("by_prompt_id", (q) => q.eq("promptId", args.promptId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      status: "completed",
      result: args.result,
      agentId: args.agentId,
    });
    return row._id;
  },
});

export const markFailed = mutation({
  args: {
    promptId: v.string(),
    error: v.string(),
    agentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scheduledPrompts")
      .withIndex("by_prompt_id", (q) => q.eq("promptId", args.promptId))
      .unique();
    if (!row) return null;
    await ctx.db.patch(row._id, {
      status: "failed",
      error: args.error,
      agentId: args.agentId,
    });
    return row._id;
  },
});

export const listByConversation = query({
  args: {
    conversationId: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("scheduledPrompts")
      .filter((q) => q.eq(q.field("conversationId"), args.conversationId))
      .order("desc")
      .collect();
    if (!args.status) return all;
    return all.filter((r) => r.status === args.status);
  },
});

export const remove = mutation({
  args: { promptId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("scheduledPrompts")
      .withIndex("by_prompt_id", (q) => q.eq("promptId", args.promptId))
      .unique();
    if (!row) return null;
    if (row.status !== "pending") return null;
    await ctx.db.delete(row._id);
    return row._id;
  },
});
