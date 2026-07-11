import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createSdkMcpServer, tool } from "./agent-sdk.js";
import { getCatalogModel, listCatalogModels, setCatalogModel, type CatalogModality } from "./catalog-models.js";
import { processCatalogItem } from "./catalog-processing.js";
import { createCatalogItemWithOptionalAsset } from "./catalog-routes.js";
import {
  deleteCatalogItem,
  deleteCatalogItemTriliumNote,
  deleteTriliumNote,
  syncCatalogItemToTrilium,
} from "./trilium.js";

const modalityEnum = z.enum(["note", "image", "audio", "video", "file"]);
const sourceEnum = z.enum(["imessage", "dashboard_upload", "connector"]);
const statusEnum = z.enum(["draft", "processing", "ready", "failed", "synced"]);
const attachmentStatusEnum = z.enum(["available", "cataloged", "failed"]);
const sortEnum = z.enum(["newest", "oldest", "title", "updated"]);

function text(content: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof content === "string" ? content : JSON.stringify(content, null, 2),
      },
    ],
  };
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || filename;
}

export function createNotesMcp(conversationId?: string) {
  return createSdkMcpServer({
    name: "boop-notes",
    version: "0.1.0",
    tools: [
      tool(
        "catalog_item",
        "Create a catalog item for a note, idea, link, or text description the user explicitly asked to save/catalog. Do not use this for raw images, audio, video, or files; those must come through an upload or inbound attachment path so an asset URL/storage object exists.",
        {
          title: z.string().describe("Short useful title."),
          summary: z.string().describe("Concise summary of what is being cataloged."),
          modality: modalityEnum.default("note"),
          source: sourceEnum.optional().default("imessage"),
          tags: z.array(z.string()).optional().default([]),
          collectionIds: z.array(z.string()).optional().default([]),
          extractedText: z.string().optional(),
          transcript: z.string().optional(),
          processNow: z.boolean().optional().default(true),
        },
        async (args) => {
          if (args.modality !== "note") {
            return text({
              error:
                "catalog_item cannot create media entries without an attached asset. " +
                "Use modality 'note' for a text description, or rely on the dashboard/iMessage upload path for raw media.",
              requestedModality: args.modality,
            });
          }
          const model = await getCatalogModel(args.modality as CatalogModality);
          const itemId = await convex.mutation(api.catalog.createItem, {
            title: args.title,
            summary: args.summary,
            modality: args.modality,
            source: args.source,
            status: args.processNow ? "processing" : "draft",
            tags: args.tags,
            collectionIds: args.collectionIds,
            sourceConversationId: conversationId,
            processingModel: model,
            extractedText: args.extractedText,
            transcript: args.transcript,
          });
          if (args.processNow) {
            processCatalogItem(itemId).catch((err) =>
              console.error("[notes-tool] processCatalogItem failed", err),
            );
          }
          return text({ itemId, status: args.processNow ? "processing" : "draft", model });
        },
      ),
      tool(
        "catalog_attachment",
        "Create an asset-backed catalog item from a pending inbound iMessage attachment. Use this when the user explicitly asks to save/catalog/organize an attachment and the message context includes an attachmentRef like att_...",
        {
          attachmentRef: z
            .string()
            .optional()
            .describe("Attachment ref from the message context, e.g. att_mabc123_xxxxxxxx. If omitted, uses the only recent attachment in this conversation."),
          title: z.string().optional().describe("Optional title override."),
          summary: z.string().optional().describe("Optional summary override."),
          tags: z.array(z.string()).optional().default([]),
          collectionIds: z.array(z.string()).optional().default([]),
          syncToNotes: z.boolean().optional().default(false),
        },
        async (args) => {
          if (!conversationId) {
            return text({ error: "catalog_attachment requires a conversation context" });
          }
          let attachment = null;
          if (args.attachmentRef) {
            attachment = await convex.query(api.pendingAttachments.get, {
              attachmentRef: args.attachmentRef,
              conversationId,
            });
          } else {
            const recent = await convex.query(api.pendingAttachments.listRecent, {
              conversationId,
              status: "available",
              limit: 2,
            });
            attachment = recent.length === 1 ? recent[0] : null;
          }
          if (!attachment) {
            const recent = await convex.query(api.pendingAttachments.listRecent, {
              conversationId,
              limit: 10,
            });
            return text({
              error:
                args.attachmentRef
                  ? `Attachment not found or expired: ${args.attachmentRef}`
                  : "No unambiguous recent attachment found. Pass attachmentRef from the message context.",
              recentAttachments: recent.map((item) => ({
                attachmentRef: item.attachmentRef,
                filename: item.filename,
                contentType: item.contentType,
                summary: item.summary,
                transcript: item.transcript,
                status: item.status,
                createdAt: item.createdAt,
              })),
            });
          }
          if (attachment.status === "cataloged" && attachment.catalogItemId) {
            return text({
              itemId: attachment.catalogItemId,
              attachmentRef: attachment.attachmentRef,
              filename: attachment.filename,
              modality: attachment.modality,
              status: "already_cataloged",
            });
          }
          const modality = attachment.modality as CatalogModality;
          const item = (await createCatalogItemWithOptionalAsset({
            title: args.title?.trim() || titleFromFilename(attachment.filename),
            summary:
              args.summary?.trim() ||
              attachment.summary ||
              attachment.sourceText ||
              `${attachment.filename} sent via iMessage.`,
            modality,
            source: "imessage",
            status: attachment.status === "available" ? "ready" : "processing",
            tags: [
              "imessage",
              modality,
              ...((attachment.tags ?? []).filter((tag) => tag !== "imessage" && tag !== modality)),
              ...(args.tags ?? []),
            ],
            collectionIds: args.collectionIds,
            sourceConversationId: conversationId,
            sourceMessageHandle: attachment.messageHandle,
            extractedText: attachment.extractedText,
            transcript: attachment.transcript,
            processNow: attachment.status !== "available",
            asset: {
              storageId: attachment.storageId,
              filename: attachment.filename,
              contentType: attachment.contentType,
              sizeBytes: attachment.sizeBytes,
            },
          })) as { itemId?: string; id?: string; notesSyncStatus?: string } | null;
          const itemId = item?.itemId ?? item?.id;
          if (itemId) {
            await convex.mutation(api.pendingAttachments.markCataloged, {
              attachmentRef: attachment.attachmentRef,
              catalogItemId: itemId,
            });
          }
          let noteId: string | undefined;
          if (args.syncToNotes && itemId) {
            noteId = await syncCatalogItemToTrilium(itemId);
          }
          return text({
            itemId,
            attachmentRef: attachment.attachmentRef,
            filename: attachment.filename,
            modality,
            notesSyncStatus: noteId ? "synced" : item?.notesSyncStatus,
            noteId,
          });
        },
      ),
      tool(
        "search_attachments",
        "Search or list pending inbound attachments by transcript, description, filename, modality, or status. Use this when the user asks to save/find/reference something they sent earlier but does not provide the attachmentRef.",
        {
          query: z.string().optional(),
          modality: modalityEnum.optional(),
          status: attachmentStatusEnum.optional(),
          limit: z.number().int().min(1).max(50).optional().default(10),
        },
        async (args) => {
          if (!conversationId) return text({ error: "search_attachments requires a conversation context" });
          const results = args.query?.trim()
            ? await convex.query(api.pendingAttachments.search, {
                conversationId,
                query: args.query,
                modality: args.modality,
                status: args.status,
                limit: args.limit,
              })
            : await convex.query(api.pendingAttachments.listRecent, {
                conversationId,
                status: args.status,
                limit: args.limit,
              });
          return text(
            results.map((item) => ({
              attachmentRef: item.attachmentRef,
              filename: item.filename,
              contentType: item.contentType,
              modality: item.modality,
              status: item.status,
              summary: item.summary,
              extractedText: item.extractedText,
              transcript: item.transcript,
              tags: item.tags,
              catalogItemId: item.catalogItemId,
              createdAt: item.createdAt,
            })),
          );
        },
      ),
      tool(
        "search_catalog",
        "Search or list cataloged notes and media. Use this when the user asks what they have saved, wants to find an image/video/audio/note, or asks about catalog contents.",
        {
          query: z.string().optional(),
          modality: modalityEnum.optional(),
          status: statusEnum.optional(),
          source: sourceEnum.optional(),
          sort: sortEnum.optional().default("updated"),
          limit: z.number().int().min(1).max(50).optional().default(10),
        },
        async (args) => {
          const results = await convex.query(api.catalog.list, args);
          return text(results);
        },
      ),
      tool(
        "update_catalog_item",
        "Update title, summary, tags, or collections for an existing catalog item.",
        {
          itemId: z.string(),
          title: z.string().optional(),
          summary: z.string().optional(),
          tags: z.array(z.string()).optional(),
          collectionIds: z.array(z.string()).optional(),
        },
        async (args) => {
          const updated = await convex.mutation(api.catalog.updateMetadata, args);
          return text({ updated: Boolean(updated), itemId: args.itemId });
        },
      ),
      tool(
        "retry_catalog_processing",
        "Retry metadata/OCR/transcript processing for a catalog item using its modality-specific model.",
        { itemId: z.string() },
        async ({ itemId }) => {
          processCatalogItem(itemId).catch((err) =>
            console.error("[notes-tool] retry_catalog_processing failed", err),
          );
          return text({ itemId, started: true });
        },
      ),
      tool(
        "sync_to_notes",
        "Sync a catalog item to the configured Trilium Notes backend. Use when the user asks to send/save/sync a cataloged thing to notes.",
        { itemId: z.string() },
        async ({ itemId }) => {
          const noteId = await syncCatalogItemToTrilium(itemId);
          return text({ itemId, noteId, notesSyncStatus: "synced" });
        },
      ),
      tool(
        "delete_catalog_item",
        "Delete a catalog item and its stored catalog assets after the user explicitly asks to delete/remove it. Set deleteSyncedNote true only when the user also asks to delete the synced Trilium note.",
        {
          itemId: z.string(),
          deleteSyncedNote: z.boolean().optional().default(false),
        },
        async ({ itemId, deleteSyncedNote }) => {
          return text(await deleteCatalogItem(itemId, { deleteTriliumNote: deleteSyncedNote }));
        },
      ),
      tool(
        "delete_catalog_trilium_note",
        "Delete the Trilium note synced from a catalog item, then mark that catalog item as not synced. Use only after the user explicitly asks to delete the Trilium note.",
        { itemId: z.string() },
        async ({ itemId }) => {
          const noteId = await deleteCatalogItemTriliumNote(itemId);
          return text({ itemId, deletedNoteId: noteId, notesSyncStatus: "not_synced" });
        },
      ),
      tool(
        "delete_trilium_note",
        "Delete a Trilium note by noteId. Use only when the user explicitly gives or confirms the Trilium note ID to delete.",
        { noteId: z.string() },
        async ({ noteId }) => {
          await deleteTriliumNote(noteId);
          return text({ deletedNoteId: noteId });
        },
      ),
      tool(
        "list_catalog_models",
        "List modality-specific catalog processing models for note, image, audio, video, and file.",
        {},
        async () => text(await listCatalogModels()),
      ),
      tool(
        "set_catalog_model",
        "Set or clear the model used to process a specific catalog modality.",
        {
          modality: modalityEnum,
          model: z.string().nullable().describe("Canonical model or alias. Null clears to runtime model fallback."),
        },
        async ({ modality, model }) => {
          await setCatalogModel(modality as CatalogModality, model);
          return text({ modality, model: await getCatalogModel(modality as CatalogModality) });
        },
      ),
    ],
  });
}
