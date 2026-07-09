import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import {
  getCatalogModel,
  listCatalogModels,
  modalityForContentType,
  setCatalogModel,
  type CatalogModality,
} from "./catalog-models.js";
import { processCatalogItem } from "./catalog-processing.js";
import { syncCatalogItemToTrilium, testTriliumConnection } from "./trilium.js";

export type CatalogSource = "imessage" | "dashboard_upload" | "connector";

const RAW_LIMIT = "75mb";

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function isCatalogSource(value: string | undefined): value is CatalogSource {
  return value === "imessage" || value === "dashboard_upload" || value === "connector";
}

function isCatalogModality(value: string | undefined): value is CatalogModality {
  return value === "note" || value === "image" || value === "audio" || value === "video" || value === "file";
}

function titleFromFilename(filename: string): string {
  return filename
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || filename;
}

export async function uploadToConvexStorage(
  body: Buffer,
  contentType: string,
): Promise<string> {
  const uploadUrl = await convex.mutation(api.catalog.generateUploadUrl, {});
  const uploadBody = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  const upload = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType || "application/octet-stream" },
    body: uploadBody,
  });
  if (!upload.ok) {
    throw new Error(`Convex storage upload failed (${upload.status}): ${await upload.text()}`);
  }
  const payload = (await upload.json()) as { storageId?: string };
  if (!payload.storageId) throw new Error("Convex storage upload returned no storageId");
  return payload.storageId;
}

export async function createCatalogItemWithOptionalAsset(opts: {
  title: string;
  summary: string;
  modality: CatalogModality;
  source: CatalogSource;
  status?: "draft" | "processing" | "ready";
  tags?: string[];
  collectionIds?: string[];
  sourceConversationId?: string;
  sourceMessageHandle?: string;
  asset?: {
    storageId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  };
}) {
  const processingModel = await getCatalogModel(opts.modality);
  const itemId = await convex.mutation(api.catalog.createItem, {
    title: opts.title,
    summary: opts.summary,
    modality: opts.modality,
    source: opts.source,
    status: opts.status ?? "processing",
    tags: opts.tags,
    collectionIds: opts.collectionIds,
    sourceConversationId: opts.sourceConversationId,
    sourceMessageHandle: opts.sourceMessageHandle,
    processingModel,
    extractedText: opts.modality === "note" ? opts.summary : undefined,
  });
  if (opts.asset) {
    await convex.mutation(api.catalog.addAsset, {
      itemId,
      storageId: opts.asset.storageId as any,
      filename: opts.asset.filename,
      contentType: opts.asset.contentType,
      sizeBytes: opts.asset.sizeBytes,
    });
  }
  processCatalogItem(itemId).catch((err) => console.error("[catalog] processing failed", err));
  return await convex.query(api.catalog.get, { itemId });
}

export function createCatalogRouter(): express.Router {
  const router = express.Router();

  router.get("/models", async (_req, res) => {
    try {
      res.json(await listCatalogModels());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/models", async (req, res) => {
    try {
      const modality = cleanString(req.body?.modality);
      if (!isCatalogModality(modality)) {
        res.status(400).json({ error: "modality must be note, image, audio, video, or file" });
        return;
      }
      const model = req.body?.model === null ? null : cleanString(req.body?.model);
      await setCatalogModel(modality, model ?? null);
      res.json({ modality, model: await getCatalogModel(modality) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/items", async (req, res) => {
    try {
      const title = cleanString(req.body?.title);
      const summary = cleanString(req.body?.summary);
      const modality = cleanString(req.body?.modality);
      const source = cleanString(req.body?.source) ?? "dashboard_upload";
      if (!title || !summary) {
        res.status(400).json({ error: "title and summary are required" });
        return;
      }
      if (!isCatalogModality(modality)) {
        res.status(400).json({ error: "valid modality is required" });
        return;
      }
      if (!isCatalogSource(source)) {
        res.status(400).json({ error: "valid source is required" });
        return;
      }
      const item = await createCatalogItemWithOptionalAsset({
        title,
        summary,
        modality,
        source,
        status: req.body?.status === "draft" ? "draft" : "processing",
        tags: splitList(req.body?.tags),
        collectionIds: splitList(req.body?.collectionIds),
      });
      res.json({ ok: true, item });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post(
    "/upload",
    express.raw({ type: "*/*", limit: RAW_LIMIT }),
    async (req, res) => {
      try {
        const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);
        if (body.length === 0) {
          res.status(400).json({ error: "raw file body is required" });
          return;
        }
        const filename =
          cleanString(req.header("x-filename")) ??
          cleanString(firstParam(req.query.filename as string | string[] | undefined)) ??
          "catalog-upload";
        const contentType =
          cleanString(req.header("content-type")) ?? "application/octet-stream";
        const sourceInput =
          cleanString(firstParam(req.query.source as string | string[] | undefined)) ??
          "dashboard_upload";
        const source = isCatalogSource(sourceInput) ? sourceInput : "dashboard_upload";
        const modalityInput = cleanString(firstParam(req.query.modality as string | string[] | undefined));
        const modality = isCatalogModality(modalityInput)
          ? modalityInput
          : modalityForContentType(contentType, filename);
        const storageId = await uploadToConvexStorage(body, contentType);
        const title =
          cleanString(firstParam(req.query.title as string | string[] | undefined)) ??
          titleFromFilename(filename);
        const summary =
          cleanString(firstParam(req.query.summary as string | string[] | undefined)) ??
          `${filename} uploaded to the catalog.`;
        const item = await createCatalogItemWithOptionalAsset({
          title,
          summary,
          modality,
          source,
          tags: splitList(firstParam(req.query.tags as string | string[] | undefined)),
          collectionIds: splitList(firstParam(req.query.collectionIds as string | string[] | undefined)),
          sourceConversationId: cleanString(firstParam(req.query.conversationId as string | string[] | undefined)),
          sourceMessageHandle: cleanString(firstParam(req.query.messageHandle as string | string[] | undefined)),
          asset: {
            storageId,
            filename,
            contentType,
            sizeBytes: body.length,
          },
        });
        res.json({ ok: true, item });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  router.post("/:itemId/retry", async (req, res) => {
    const itemId = firstParam(req.params.itemId);
    if (!itemId) {
      res.status(400).json({ error: "itemId required" });
      return;
    }
    try {
      processCatalogItem(itemId).catch((err) => console.error("[catalog] retry failed", err));
      res.json({ ok: true, started: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/:itemId/sync", async (req, res) => {
    const itemId = firstParam(req.params.itemId);
    if (!itemId) {
      res.status(400).json({ error: "itemId required" });
      return;
    }
    try {
      const noteId = await syncCatalogItemToTrilium(itemId);
      res.json({ ok: true, noteId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/trilium/status", async (_req, res) => {
    res.json(await testTriliumConnection());
  });

  return router;
}
