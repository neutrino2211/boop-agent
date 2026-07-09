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
  v.literal("draft"),
  v.literal("processing"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("synced"),
);
const notesSyncStatusV = v.union(
  v.literal("not_synced"),
  v.literal("syncing"),
  v.literal("synced"),
  v.literal("failed"),
);

const LIST_LIMIT = 100;
const SCAN_LIMIT = 500;

function makeSearchText(args: {
  title: string;
  summary: string;
  modality: string;
  source: string;
  status: string;
  tags: string[];
  extractedText?: string;
  transcript?: string;
}) {
  return [
    args.title,
    args.summary,
    args.modality,
    args.source,
    args.status,
    ...args.tags,
    args.extractedText ?? "",
    args.transcript ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function makeCatalogItemId() {
  return `cat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeCatalogAssetId() {
  return `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const createItem = mutation({
  args: {
    itemId: v.optional(v.string()),
    title: v.string(),
    summary: v.string(),
    modality: modalityV,
    source: sourceV,
    status: v.optional(statusV),
    tags: v.optional(v.array(v.string())),
    collectionIds: v.optional(v.array(v.string())),
    sourceConversationId: v.optional(v.string()),
    sourceMessageHandle: v.optional(v.string()),
    processingModel: v.optional(v.string()),
    extractedText: v.optional(v.string()),
    transcript: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const itemId = args.itemId ?? makeCatalogItemId();
    const status = args.status ?? "draft";
    const tags = args.tags ?? [];
    const collectionIds = args.collectionIds ?? [];
    const processingModel = args.processingModel ?? "unconfigured";
    const existing = await ctx.db
      .query("catalogItems")
      .withIndex("by_item_id", (q) => q.eq("itemId", itemId))
      .unique();
    const doc = {
      itemId,
      title: args.title,
      summary: args.summary,
      modality: args.modality,
      source: args.source,
      status,
      tags,
      collectionIds,
      searchText: makeSearchText({
        title: args.title,
        summary: args.summary,
        modality: args.modality,
        source: args.source,
        status,
        tags,
        extractedText: args.extractedText,
        transcript: args.transcript,
      }),
      sourceConversationId: args.sourceConversationId,
      sourceMessageHandle: args.sourceMessageHandle,
      notesSyncStatus: "not_synced" as const,
      processingModel,
      extractedText: args.extractedText,
      transcript: args.transcript,
      createdAt: now,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...doc,
        createdAt: existing.createdAt,
      });
      return itemId;
    }
    await ctx.db.insert("catalogItems", doc);
    await ctx.db.insert("catalogEvents", {
      itemId,
      eventType: "catalog.item_created",
      data: JSON.stringify({ source: args.source, modality: args.modality }),
      createdAt: now,
    });
    return itemId;
  },
});

export const updateMetadata = mutation({
  args: {
    itemId: v.string(),
    title: v.optional(v.string()),
    summary: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    collectionIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("catalogItems")
      .withIndex("by_item_id", (q) => q.eq("itemId", args.itemId))
      .unique();
    if (!existing) return null;
    const title = args.title ?? existing.title;
    const summary = args.summary ?? existing.summary;
    const tags = args.tags ?? existing.tags;
    const collectionIds = args.collectionIds ?? existing.collectionIds;
    await ctx.db.patch(existing._id, {
      title,
      summary,
      tags,
      collectionIds,
      searchText: makeSearchText({
        title,
        summary,
        modality: existing.modality,
        source: existing.source,
        status: existing.status,
        tags,
        extractedText: existing.extractedText,
        transcript: existing.transcript,
      }),
      updatedAt: Date.now(),
    });
    return existing._id;
  },
});

export const setProcessing = mutation({
  args: {
    itemId: v.string(),
    status: statusV,
    processingModel: v.optional(v.string()),
    processingError: v.optional(v.string()),
    extractedText: v.optional(v.string()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("catalogItems")
      .withIndex("by_item_id", (q) => q.eq("itemId", args.itemId))
      .unique();
    if (!existing) return null;
    const title = existing.title;
    const summary = args.summary ?? existing.summary;
    const tags = args.tags ?? existing.tags;
    const extractedText = args.extractedText ?? existing.extractedText;
    const transcript = args.transcript ?? existing.transcript;
    await ctx.db.patch(existing._id, {
      status: args.status,
      processingModel: args.processingModel ?? existing.processingModel,
      processingError: args.processingError,
      extractedText,
      transcript,
      summary,
      tags,
      searchText: makeSearchText({
        title,
        summary,
        modality: existing.modality,
        source: existing.source,
        status: args.status,
        tags,
        extractedText,
        transcript,
      }),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("catalogEvents", {
      itemId: args.itemId,
      eventType: "catalog.processing_set",
      data: JSON.stringify({ status: args.status, model: args.processingModel }),
      createdAt: Date.now(),
    });
    return existing._id;
  },
});

export const setNotesSync = mutation({
  args: {
    itemId: v.string(),
    notesSyncStatus: notesSyncStatusV,
    syncedNoteId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("catalogItems")
      .withIndex("by_item_id", (q) => q.eq("itemId", args.itemId))
      .unique();
    if (!existing) return null;
    const status = args.notesSyncStatus === "synced" ? "synced" : existing.status;
    await ctx.db.patch(existing._id, {
      notesSyncStatus: args.notesSyncStatus,
      syncedNoteId: args.syncedNoteId ?? existing.syncedNoteId,
      status,
      searchText: makeSearchText({
        title: existing.title,
        summary: existing.summary,
        modality: existing.modality,
        source: existing.source,
        status,
        tags: existing.tags,
        extractedText: existing.extractedText,
        transcript: existing.transcript,
      }),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("catalogEvents", {
      itemId: args.itemId,
      eventType: "catalog.notes_sync_set",
      data: JSON.stringify({
        notesSyncStatus: args.notesSyncStatus,
        syncedNoteId: args.syncedNoteId,
        error: args.error,
      }),
      createdAt: Date.now(),
    });
    return existing._id;
  },
});

export const addAsset = mutation({
  args: {
    itemId: v.string(),
    assetId: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    filename: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
    thumbnailUrl: v.optional(v.string()),
    durationMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const assetId = args.assetId ?? makeCatalogAssetId();
    const existing = await ctx.db
      .query("catalogAssets")
      .withIndex("by_asset_id", (q) => q.eq("assetId", assetId))
      .unique();
    const doc = {
      assetId,
      itemId: args.itemId,
      storageId: args.storageId,
      filename: args.filename,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      thumbnailUrl: args.thumbnailUrl,
      durationMs: args.durationMs,
      createdAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, doc);
      return assetId;
    }
    await ctx.db.insert("catalogAssets", doc);
    await ctx.db.insert("catalogEvents", {
      itemId: args.itemId,
      eventType: "catalog.asset_added",
      data: JSON.stringify({ filename: args.filename, contentType: args.contentType }),
      createdAt: now,
    });
    return assetId;
  },
});

export const upsertCollection = mutation({
  args: {
    collectionId: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("catalogCollections")
      .withIndex("by_collection_id", (q) => q.eq("collectionId", args.collectionId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        color: args.color ?? existing.color,
        updatedAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("catalogCollections", {
      collectionId: args.collectionId,
      name: args.name,
      color: args.color ?? "slate",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listCollections = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("catalogCollections").order("desc").take(200);
  },
});

type AssetResult = {
  id: string;
  assetId: string;
  itemId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageId?: Id<"_storage">;
  storageUrl: string | null;
  thumbnailUrl?: string;
  durationMs?: number;
  createdAt: number;
};

async function assetsForItem(ctx: QueryCtx, itemId: string): Promise<AssetResult[]> {
  const assets = await ctx.db
    .query("catalogAssets")
    .withIndex("by_item_id", (q) => q.eq("itemId", itemId))
    .order("desc")
    .take(20);
  return await Promise.all(
    assets.map(async (asset) => ({
      id: asset.assetId,
      assetId: asset.assetId,
      itemId: asset.itemId,
      filename: asset.filename,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      storageId: asset.storageId,
      storageUrl: asset.storageId ? await ctx.storage.getUrl(asset.storageId) : null,
      thumbnailUrl: asset.thumbnailUrl,
      durationMs: asset.durationMs,
      createdAt: asset.createdAt,
    })),
  );
}

function itemMatches(args: {
  item: {
    modality: string;
    source: string;
    status: string;
    searchText: string;
  };
  modality?: string;
  source?: string;
  status?: string;
  query?: string;
}) {
  if (args.modality && args.item.modality !== args.modality) return false;
  if (args.source && args.item.source !== args.source) return false;
  if (args.status && args.item.status !== args.status) return false;
  if (args.query && !args.item.searchText.includes(args.query.toLowerCase())) return false;
  return true;
}

function toCatalogItem(item: {
  itemId: string;
  title: string;
  summary: string;
  modality: string;
  source: string;
  status: string;
  tags: string[];
  collectionIds: string[];
  createdAt: number;
  updatedAt: number;
  syncedNoteId?: string;
  notesSyncStatus: string;
  processingModel: string;
  processingError?: string;
  extractedText?: string;
  transcript?: string;
}) {
  return {
    id: item.itemId,
    itemId: item.itemId,
    title: item.title,
    summary: item.summary,
    modality: item.modality,
    source: item.source,
    status: item.status,
    tags: item.tags,
    collectionIds: item.collectionIds,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    syncedNoteId: item.syncedNoteId,
    notesSyncStatus: item.notesSyncStatus,
    processing: {
      status: item.status,
      model: item.processingModel,
      error: item.processingError,
      extractedText: item.extractedText,
      transcript: item.transcript,
    },
  };
}

export const list = query({
  args: {
    query: v.optional(v.string()),
    modality: v.optional(modalityV),
    status: v.optional(statusV),
    source: v.optional(sourceV),
    sort: v.optional(v.union(
      v.literal("newest"),
      v.literal("oldest"),
      v.literal("title"),
      v.literal("updated"),
    )),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? LIST_LIMIT, LIST_LIMIT);
    let rows;
    if (args.query?.trim()) {
      rows = await ctx.db
        .query("catalogItems")
        .withSearchIndex("search_catalog", (q) => {
          let query = q.search("searchText", args.query!.trim());
          if (args.status) query = query.eq("status", args.status);
          if (args.modality) query = query.eq("modality", args.modality);
          if (args.source) query = query.eq("source", args.source);
          return query;
        })
        .take(limit);
    } else if (args.status) {
      rows = await ctx.db
        .query("catalogItems")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .order(args.sort === "oldest" ? "asc" : "desc")
        .take(SCAN_LIMIT);
    } else if (args.modality) {
      rows = await ctx.db
        .query("catalogItems")
        .withIndex("by_modality", (q) => q.eq("modality", args.modality!))
        .order(args.sort === "oldest" ? "asc" : "desc")
        .take(SCAN_LIMIT);
    } else if (args.source) {
      rows = await ctx.db
        .query("catalogItems")
        .withIndex("by_source", (q) => q.eq("source", args.source!))
        .order(args.sort === "oldest" ? "asc" : "desc")
        .take(SCAN_LIMIT);
    } else {
      rows = await ctx.db
        .query("catalogItems")
        .withIndex("by_updated_at")
        .order(args.sort === "oldest" ? "asc" : "desc")
        .take(SCAN_LIMIT);
    }

    const filtered = rows
      .filter((item) =>
        itemMatches({
          item,
          modality: args.modality,
          source: args.source,
          status: args.status,
          query: args.query,
        }),
      )
      .sort((a, b) => {
        if (args.sort === "title") return a.title.localeCompare(b.title);
        if (args.sort === "oldest") return a.createdAt - b.createdAt;
        if (args.sort === "updated") return b.updatedAt - a.updatedAt;
        return b.createdAt - a.createdAt;
      })
      .slice(0, limit);

    return await Promise.all(
      filtered.map(async (item) => {
        const assets = await assetsForItem(ctx, item.itemId);
        return {
          ...toCatalogItem(item),
          assetIds: assets.map((asset) => asset.assetId),
          assets,
        };
      }),
    );
  },
});

export const get = query({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("catalogItems")
      .withIndex("by_item_id", (q) => q.eq("itemId", args.itemId))
      .unique();
    if (!item) return null;
    const assets = await assetsForItem(ctx, item.itemId);
    return {
      ...toCatalogItem(item),
      assetIds: assets.map((asset) => asset.assetId),
      assets,
    };
  },
});

export const getAsset = query({
  args: { assetId: v.string() },
  handler: async (ctx, args) => {
    const asset = await ctx.db
      .query("catalogAssets")
      .withIndex("by_asset_id", (q) => q.eq("assetId", args.assetId))
      .unique();
    if (!asset) return null;
    return {
      id: asset.assetId,
      assetId: asset.assetId,
      itemId: asset.itemId,
      filename: asset.filename,
      contentType: asset.contentType,
      sizeBytes: asset.sizeBytes,
      storageId: asset.storageId,
      storageUrl: asset.storageId ? await ctx.storage.getUrl(asset.storageId) : null,
      thumbnailUrl: asset.thumbnailUrl,
      durationMs: asset.durationMs,
      createdAt: asset.createdAt,
    };
  },
});

export const metrics = query({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.db.query("catalogItems").withIndex("by_updated_at").order("desc").take(5000);
    const count = (pick: (item: (typeof items)[number]) => boolean) =>
      items.reduce((total, item) => total + (pick(item) ? 1 : 0), 0);
    return {
      total: items.length,
      synced: count((item) => item.status === "synced"),
      failed: count((item) => item.status === "failed"),
      processing: count((item) => item.status === "processing"),
      draft: count((item) => item.status === "draft"),
      media: count((item) => item.modality !== "note"),
      byModality: {
        note: count((item) => item.modality === "note"),
        image: count((item) => item.modality === "image"),
        audio: count((item) => item.modality === "audio"),
        video: count((item) => item.modality === "video"),
        file: count((item) => item.modality === "file"),
      },
      truncated: items.length === 5000,
    };
  },
});

export const remove = mutation({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    const item = await ctx.db
      .query("catalogItems")
      .withIndex("by_item_id", (q) => q.eq("itemId", args.itemId))
      .unique();
    if (!item) return false;
    const assets = await ctx.db
      .query("catalogAssets")
      .withIndex("by_item_id", (q) => q.eq("itemId", args.itemId))
      .take(100);
    for (const asset of assets) {
      if (asset.storageId) await ctx.storage.delete(asset.storageId as Id<"_storage">);
      await ctx.db.delete(asset._id);
    }
    await ctx.db.delete(item._id);
    await ctx.db.insert("catalogEvents", {
      itemId: args.itemId,
      eventType: "catalog.item_removed",
      data: "{}",
      createdAt: Date.now(),
    });
    return true;
  },
});
