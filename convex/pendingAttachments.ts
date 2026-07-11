import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const modalityV = v.union(
  v.literal("note"),
  v.literal("image"),
  v.literal("audio"),
  v.literal("video"),
  v.literal("file"),
);
const sourceV = v.union(
  v.literal("imessage"),
  v.literal("dashboard_upload"),
  v.literal("connector"),
);
const statusV = v.union(
  v.literal("available"),
  v.literal("cataloged"),
  v.literal("failed"),
);

function makeSearchText(args: {
  attachmentRef: string;
  filename: string;
  contentType: string;
  modality: string;
  status: string;
  sourceText?: string;
  summary?: string;
  extractedText?: string;
  transcript?: string;
  tags: string[];
}) {
  return [
    args.attachmentRef,
    args.filename,
    args.contentType,
    args.modality,
    args.status,
    args.sourceText ?? "",
    args.summary ?? "",
    args.extractedText ?? "",
    args.transcript ?? "",
    ...args.tags,
  ]
    .join(" ")
    .toLowerCase();
}

async function enrich(ctx: QueryCtx, attachment: {
  attachmentRef: string;
  conversationId: string;
  source: "imessage" | "dashboard_upload" | "connector";
  messageHandle?: string;
  storageId: Id<"_storage">;
  filename: string;
  contentType: string;
  sizeBytes: number;
  modality: "note" | "image" | "audio" | "video" | "file";
  status: "available" | "cataloged" | "failed";
  sourceText?: string;
  summary?: string;
  extractedText?: string;
  transcript?: string;
  tags: string[];
  processingModel?: string;
  processingError?: string;
  catalogItemId?: string;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    ...attachment,
    storageUrl: await ctx.storage.getUrl(attachment.storageId),
  };
}

export const upsert = mutation({
  args: {
    attachmentRef: v.string(),
    conversationId: v.string(),
    source: sourceV,
    messageHandle: v.optional(v.string()),
    storageId: v.id("_storage"),
    filename: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    modality: modalityV,
    status: v.optional(statusV),
    sourceText: v.optional(v.string()),
    summary: v.optional(v.string()),
    extractedText: v.optional(v.string()),
    transcript: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    processingModel: v.optional(v.string()),
    processingError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const status = args.status ?? (args.processingError ? "failed" : "available");
    const tags = args.tags ?? [];
    const searchText = makeSearchText({
      attachmentRef: args.attachmentRef,
      filename: args.filename,
      contentType: args.contentType,
      modality: args.modality,
      status,
      sourceText: args.sourceText,
      summary: args.summary,
      extractedText: args.extractedText,
      transcript: args.transcript,
      tags,
    });
    const existing = await ctx.db
      .query("pendingAttachments")
      .withIndex("by_attachment_ref", (q) => q.eq("attachmentRef", args.attachmentRef))
      .unique();
    const doc = {
      attachmentRef: args.attachmentRef,
      conversationId: args.conversationId,
      source: args.source,
      messageHandle: args.messageHandle,
      storageId: args.storageId,
      filename: args.filename,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      modality: args.modality,
      status,
      sourceText: args.sourceText,
      summary: args.summary,
      extractedText: args.extractedText,
      transcript: args.transcript,
      tags,
      processingModel: args.processingModel,
      processingError: args.processingError,
      searchText,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return args.attachmentRef;
    }
    await ctx.db.insert("pendingAttachments", {
      ...doc,
      createdAt: now,
    });
    return args.attachmentRef;
  },
});

export const get = query({
  args: {
    attachmentRef: v.string(),
    conversationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const attachment = await ctx.db
      .query("pendingAttachments")
      .withIndex("by_attachment_ref", (q) => q.eq("attachmentRef", args.attachmentRef))
      .unique();
    if (!attachment) return null;
    if (args.conversationId && attachment.conversationId !== args.conversationId) return null;
    return await enrich(ctx, attachment);
  },
});

export const listRecent = query({
  args: {
    conversationId: v.string(),
    status: v.optional(statusV),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 10, 50);
    const rows = args.status
      ? await ctx.db
          .query("pendingAttachments")
          .withIndex("by_conversation_and_status", (q) =>
            q.eq("conversationId", args.conversationId).eq("status", args.status!),
          )
          .order("desc")
          .take(limit)
      : await ctx.db
          .query("pendingAttachments")
          .withIndex("by_conversation_and_created_at", (q) => q.eq("conversationId", args.conversationId))
          .order("desc")
          .take(limit);
    return await Promise.all(rows.map((row) => enrich(ctx, row)));
  },
});

export const search = query({
  args: {
    conversationId: v.string(),
    query: v.string(),
    modality: v.optional(modalityV),
    status: v.optional(statusV),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 10, 50);
    const rows = await ctx.db
      .query("pendingAttachments")
      .withSearchIndex("search_pending_attachments", (q) => {
        let query = q.search("searchText", args.query.trim()).eq("conversationId", args.conversationId);
        if (args.modality) query = query.eq("modality", args.modality);
        if (args.status) query = query.eq("status", args.status);
        return query;
      })
      .take(limit);
    return await Promise.all(rows.map((row) => enrich(ctx, row)));
  },
});

export const markCataloged = mutation({
  args: {
    attachmentRef: v.string(),
    catalogItemId: v.string(),
  },
  handler: async (ctx, args) => {
    const attachment = await ctx.db
      .query("pendingAttachments")
      .withIndex("by_attachment_ref", (q) => q.eq("attachmentRef", args.attachmentRef))
      .unique();
    if (!attachment) return null;
    const status = "cataloged" as const;
    await ctx.db.patch(attachment._id, {
      status,
      catalogItemId: args.catalogItemId,
      searchText: makeSearchText({
        attachmentRef: attachment.attachmentRef,
        filename: attachment.filename,
        contentType: attachment.contentType,
        modality: attachment.modality,
        status,
        sourceText: attachment.sourceText,
        summary: attachment.summary,
        extractedText: attachment.extractedText,
        transcript: attachment.transcript,
        tags: attachment.tags,
      }),
      updatedAt: Date.now(),
    });
    return attachment._id;
  },
});
