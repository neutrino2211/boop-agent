import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";

export interface TriliumConfig {
  baseUrl: string;
  token: string;
  rootNoteId?: string;
  syncEnabled: boolean;
}

interface CatalogAssetForSync {
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageUrl: string | null;
}

interface CatalogItemForSync {
  itemId: string;
  title: string;
  summary: string;
  modality: string;
  source: string;
  status: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  syncedNoteId?: string;
  processing?: {
    model?: string;
    extractedText?: string;
    transcript?: string;
    error?: string;
  };
  assets: CatalogAssetForSync[];
}

function envOrSettingKey(name: string) {
  return `env_override.${name}`;
}

async function settingOrEnv(name: string): Promise<string | null> {
  const envValue = process.env[name]?.trim();
  if (envValue) return envValue;
  try {
    const stored = await convex.query(api.settings.get, { key: envOrSettingKey(name) });
    return stored?.trim() || null;
  } catch {
    return null;
  }
}

export async function getTriliumConfig(): Promise<TriliumConfig | null> {
  const [baseUrl, token, rootNoteId, syncEnabled] = await Promise.all([
    settingOrEnv("TRILIUM_BASE_URL"),
    settingOrEnv("TRILIUM_ETAPI_TOKEN"),
    settingOrEnv("TRILIUM_ROOT_NOTE_ID"),
    settingOrEnv("TRILIUM_SYNC_ENABLED"),
  ]);
  if (!baseUrl || !token) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    token,
    rootNoteId: rootNoteId ?? undefined,
    syncEnabled: syncEnabled === null ? true : syncEnabled !== "false",
  };
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderCatalogNote(item: CatalogItemForSync): string {
  const assetList =
    item.assets.length === 0
      ? "<li>No assets attached.</li>"
      : item.assets
          .map((asset) => {
            const url = asset.storageUrl;
            const label = `${asset.filename} (${asset.contentType}, ${Math.round(asset.sizeBytes / 1024)} KB)`;
            return url
              ? `<li><a href="${htmlEscape(url)}">${htmlEscape(label)}</a></li>`
              : `<li>${htmlEscape(label)}</li>`;
          })
          .join("");
  const transcript = item.processing?.transcript
    ? `<h3>Transcript</h3><p>${htmlEscape(item.processing.transcript)}</p>`
    : "";
  const extractedText = item.processing?.extractedText
    ? `<h3>Extracted text</h3><p>${htmlEscape(item.processing.extractedText)}</p>`
    : "";
  return [
    `<h2>${htmlEscape(item.title)}</h2>`,
    `<p>${htmlEscape(item.summary)}</p>`,
    "<h3>Catalog metadata</h3>",
    "<ul>",
    `<li>Catalog id: ${htmlEscape(item.itemId)}</li>`,
    `<li>Modality: ${htmlEscape(item.modality)}</li>`,
    `<li>Source: ${htmlEscape(item.source)}</li>`,
    `<li>Status: ${htmlEscape(item.status)}</li>`,
    `<li>Tags: ${htmlEscape(item.tags.join(", ") || "none")}</li>`,
    `<li>Processing model: ${htmlEscape(item.processing?.model ?? "unknown")}</li>`,
    "</ul>",
    "<h3>Assets</h3>",
    `<ul>${assetList}</ul>`,
    transcript,
    extractedText,
  ].join("\n");
}

async function triliumFetch(
  config: TriliumConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  return await fetch(`${config.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: config.token,
      ...(init.headers ?? {}),
    },
  });
}

async function createNote(config: TriliumConfig, item: CatalogItemForSync): Promise<string> {
  const body = {
    parentNoteId: config.rootNoteId ?? "root",
    title: item.title,
    type: "text",
    content: renderCatalogNote(item),
  };
  const res = await triliumFetch(config, "/etapi/create-note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Trilium create-note failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { note?: { noteId?: string }; noteId?: string };
  const noteId = data.note?.noteId ?? data.noteId;
  if (!noteId) throw new Error("Trilium create-note response did not include noteId");
  return noteId;
}

async function updateNoteContent(
  config: TriliumConfig,
  noteId: string,
  item: CatalogItemForSync,
): Promise<void> {
  const res = await triliumFetch(config, `/etapi/notes/${encodeURIComponent(noteId)}/content`, {
    method: "PUT",
    headers: { "Content-Type": "text/html" },
    body: renderCatalogNote(item),
  });
  if (!res.ok) {
    throw new Error(`Trilium update content failed (${res.status}): ${await res.text()}`);
  }
}

export async function syncCatalogItemToTrilium(itemId: string): Promise<string> {
  const config = await getTriliumConfig();
  if (!config) throw new Error("TRILIUM_BASE_URL and TRILIUM_ETAPI_TOKEN are required");
  if (!config.syncEnabled) throw new Error("Trilium sync is disabled");

  const item = (await convex.query(api.catalog.get, { itemId })) as CatalogItemForSync | null;
  if (!item) throw new Error(`Catalog item not found: ${itemId}`);

  await convex.mutation(api.catalog.setNotesSync, {
    itemId,
    notesSyncStatus: "syncing",
  });
  try {
    const noteId = item.syncedNoteId ?? (await createNote(config, item));
    if (item.syncedNoteId) {
      await updateNoteContent(config, noteId, item);
    }
    await convex.mutation(api.catalog.setNotesSync, {
      itemId,
      notesSyncStatus: "synced",
      syncedNoteId: noteId,
    });
    return noteId;
  } catch (err) {
    await convex.mutation(api.catalog.setNotesSync, {
      itemId,
      notesSyncStatus: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export async function testTriliumConnection(): Promise<{ ok: boolean; error?: string }> {
  const config = await getTriliumConfig();
  if (!config) return { ok: false, error: "missing Trilium config" };
  try {
    const res = await triliumFetch(config, "/etapi/app-info", { method: "GET" });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
