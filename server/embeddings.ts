/**
 * Thin embeddings wrapper. Tries Voyage → OpenAI → local Transformers.js
 * (Xenova/bge-large-en-v1.5). All three produce 1024-dim vectors so the
 * Convex vector index stays compatible regardless of which provider runs.
 *
 * Local fallback ensures `recall()` always works — no API key required.
 * First local call downloads ~440MB and caches in ~/.cache/huggingface.
 */

import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const VOYAGE_MODEL = "voyage-3";
const OPENAI_MODEL = "text-embedding-3-large";
const LOCAL_MODEL = "Xenova/bge-large-en-v1.5";
const DIMENSIONS = 1024;
const LOCAL_CACHE_DIR =
  process.env.BOOP_EMBEDDINGS_CACHE_DIR?.trim() || "/tmp/boop-embeddings-cache";
const require = createRequire(import.meta.url);

function hasTransformersPackage(): boolean {
  try {
    require.resolve("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

function envEnabled(name: string, defaultValue = true): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return raw !== "false";
}

const BGE_MODEL_ENABLED = envEnabled("BOOP_ENABLE_BGE_MODEL", true);
const LOCAL_TRANSFORMERS_AVAILABLE = hasTransformersPackage();
const LOCAL_EMBEDDINGS_ENABLED =
  BGE_MODEL_ENABLED &&
  envEnabled("BOOP_ENABLE_LOCAL_EMBEDDINGS", true) &&
  LOCAL_TRANSFORMERS_AVAILABLE;
let warnedLocalDisabled = false;

// Local pipeline is loaded lazily (model download is ~440MB) and cached
// in-process. `loading` dedupes parallel callers during the first load.
let extractor: FeatureExtractionPipeline | null = null;
let loading: Promise<FeatureExtractionPipeline> | null = null;

export type EmbeddingProvider = "voyage" | "openai" | "local";

export function activeProvider(): EmbeddingProvider {
  if (process.env.VOYAGE_API_KEY?.trim()) return "voyage";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  return "local";
}

// Returns true when at least one embedding backend is configured/enabled.
export function embeddingsAvailable(): boolean {
  return Boolean(
    process.env.VOYAGE_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      LOCAL_EMBEDDINGS_ENABLED,
  );
}

export function localEmbeddingsEnabled(): boolean {
  return LOCAL_EMBEDDINGS_ENABLED;
}

export function localEmbeddingsDisabledReason(): string | null {
  if (LOCAL_EMBEDDINGS_ENABLED) return null;
  if (!LOCAL_TRANSFORMERS_AVAILABLE) {
    return "@huggingface/transformers is not installed in this runtime image";
  }
  if (!BGE_MODEL_ENABLED) {
    return "BOOP_ENABLE_BGE_MODEL is false";
  }
  return "BOOP_ENABLE_LOCAL_EMBEDDINGS is false";
}

async function embedVoyage(text: string): Promise<number[]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      output_dimension: DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

async function embedOpenAI(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: text,
      dimensions: DIMENSIONS,
    }),
  });
  if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

async function getLocalExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor;
  if (loading) return loading;
  const attempt = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    // Default transformers.js cache path is relative to its own package dir
    // (under node_modules), which is read-only in our runtime container.
    await mkdir(LOCAL_CACHE_DIR, { recursive: true });
    env.cacheDir = LOCAL_CACHE_DIR;
    env.useFSCache = true;
    env.useBrowserCache = false;
    console.log(`[embeddings] loading local model ${LOCAL_MODEL} (~440MB on first run)…`);
    console.log(`[embeddings] cache dir: ${LOCAL_CACHE_DIR}`);
    const start = Date.now();
    const ext = await pipeline("feature-extraction", LOCAL_MODEL, {
      dtype: "fp32",
    });
    console.log(`[embeddings] local model ready in ${Date.now() - start}ms`);
    extractor = ext;
    return ext;
  })();
  loading = attempt;
  // If the load rejects (transient network failure during the 440MB
  // download, etc.) we MUST clear `loading` so the next call re-attempts
  // instead of replaying the cached rejection forever. Detach the cleanup
  // from the returned promise via .catch(() => {}) so callers see the
  // original rejection while the slot still resets.
  attempt.catch(() => {
    if (loading === attempt) loading = null;
  });
  return loading;
}

async function embedLocal(text: string): Promise<number[]> {
  const ext = await getLocalExtractor();
  const out = await ext(text, { pooling: "mean", normalize: true });
  // Tensor → number[]. BGE-large outputs 1024 floats; verify shape so a
  // future model swap doesn't silently produce mis-sized vectors that the
  // Convex vector index would reject.
  const arr = Array.from(out.data as ArrayLike<number>);
  if (arr.length !== DIMENSIONS) {
    throw new Error(
      `local embedding returned ${arr.length} dims, expected ${DIMENSIONS}`,
    );
  }
  return arr;
}

// Preload the local model in the background so the first user-facing
// recall() doesn't pay the ~5–15s model load. Safe to call at server
// startup — failures are logged, not thrown.
export function preloadLocalModel(): void {
  if (
    process.env.VOYAGE_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    !LOCAL_EMBEDDINGS_ENABLED
  ) {
    return;
  }
  getLocalExtractor().catch((err) => {
    console.warn("[embeddings] local model preload failed:", err);
  });
}

export async function embed(text: string): Promise<number[] | null> {
  try {
    if (process.env.VOYAGE_API_KEY?.trim()) return await embedVoyage(text);
    if (process.env.OPENAI_API_KEY?.trim()) return await embedOpenAI(text);
    if (!LOCAL_EMBEDDINGS_ENABLED) {
      if (!warnedLocalDisabled) {
        warnedLocalDisabled = true;
        console.warn(
          `[embeddings] local embeddings disabled (${localEmbeddingsDisabledReason() ?? "disabled"})`,
        );
      }
      return null;
    }
    return await embedLocal(text);
  } catch (err) {
    console.warn("[embeddings] failed:", err);
    return null;
  }
}
