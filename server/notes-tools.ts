import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { createSdkMcpServer, tool } from "./agent-sdk.js";
import {
  getCatalogModel,
  listCatalogModels,
  setCatalogModel,
  type CatalogModality,
} from "./catalog-models.js";
import { processCatalogItem } from "./catalog-processing.js";
import { syncCatalogItemToTrilium } from "./trilium.js";

const modalityEnum = z.enum(["note", "image", "audio", "video", "file"]);
const sourceEnum = z.enum(["imessage", "dashboard_upload", "connector"]);
const statusEnum = z.enum(["draft", "processing", "ready", "failed", "synced"]);
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

export function createNotesMcp(conversationId?: string) {
  return createSdkMcpServer({
    name: "boop-notes",
    version: "0.1.0",
    tools: [
      tool(
        "catalog_item",
        "Create a catalog item for a note, idea, link, or media description the user explicitly asked to save/catalog. For raw files, the dashboard/iMessage upload path creates assets separately; this tool stores structured metadata.",
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
