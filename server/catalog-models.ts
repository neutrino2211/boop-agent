import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getRuntimeModel, resolveModelInput } from "./runtime-config.js";

export type CatalogModality = "note" | "image" | "audio" | "video" | "file";

const MODEL_KEY_PREFIX = "catalog.model.";
const MODEL_TTL_MS = 30 * 1000;
const cache = new Map<CatalogModality, { at: number; value: string }>();

export function modalityForContentType(contentType: string, filename = ""): CatalogModality {
  const type = contentType.toLowerCase();
  const lowerName = filename.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/") || lowerName.endsWith(".md") || lowerName.endsWith(".txt")) {
    return "note";
  }
  return "file";
}

export async function getCatalogModel(modality: CatalogModality): Promise<string> {
  const cached = cache.get(modality);
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.value;
  const key = `${MODEL_KEY_PREFIX}${modality}`;
  let stored: string | null = null;
  try {
    stored = await convex.query(api.settings.get, { key });
  } catch (err) {
    console.warn(`[catalog-models] settings:get(${key}) failed`, err);
  }
  const resolved = stored ? (resolveModelInput(stored) ?? stored) : await getRuntimeModel();
  cache.set(modality, { at: Date.now(), value: resolved });
  return resolved;
}

export async function setCatalogModel(
  modality: CatalogModality,
  model: string | null,
): Promise<void> {
  const key = `${MODEL_KEY_PREFIX}${modality}`;
  if (model === null) {
    await convex.mutation(api.settings.clear, { key });
    cache.delete(modality);
    return;
  }
  const resolved = resolveModelInput(model);
  if (!resolved) throw new Error(`Unknown model "${model}"`);
  await convex.mutation(api.settings.set, { key, value: resolved });
  cache.set(modality, { at: Date.now(), value: resolved });
}

export async function listCatalogModels(): Promise<Record<CatalogModality, string>> {
  const modalities: CatalogModality[] = ["note", "image", "audio", "video", "file"];
  const keys = modalities.map((modality) => `${MODEL_KEY_PREFIX}${modality}`);
  let stored: Record<string, string | null> = {};
  try {
    stored = await convex.query(api.settings.getMany, { keys });
  } catch (err) {
    console.warn("[catalog-models] settings:getMany failed", err);
  }
  const runtimeModel = await getRuntimeModel();
  const entries = modalities.map((modality) => {
    const key = `${MODEL_KEY_PREFIX}${modality}`;
    const value = stored[key];
    const resolved = value ? (resolveModelInput(value) ?? value) : runtimeModel;
    cache.set(modality, { at: Date.now(), value: resolved });
    return [modality, resolved] as const;
  });
  return Object.fromEntries(entries) as Record<CatalogModality, string>;
}
