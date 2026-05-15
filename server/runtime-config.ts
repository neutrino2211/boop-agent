import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import {
  DEFAULT_MODEL,
  KNOWN_MODELS,
  MODEL_ALIASES,
  normalizeModelOrDefault,
  resolveModelInput,
} from "./model-config.js";

const MODEL_KEY = "model";
const MODEL_TTL_MS = 30 * 1000;
let cached: { at: number; value: string } | null = null;

export { DEFAULT_MODEL, KNOWN_MODELS, MODEL_ALIASES, resolveModelInput };

function envFallback(): string {
  return normalizeModelOrDefault(process.env.BOOP_MODEL);
}

export async function getRuntimeModel(): Promise<string> {
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached.value;
  let stored: string | null = null;
  try {
    stored = await convex.query(api.settings.get, { key: MODEL_KEY });
  } catch (err) {
    console.warn("[runtime-config] settings:get failed", err);
  }
  // Re-validate even though set_model writes through resolveModelInput — the
  // settings table is also writable via the Convex dashboard and other
  // mutations, and a bad value here would surface as an opaque provider 4xx on
  // the next turn instead of falling back gracefully.
  const final = stored ? normalizeModelOrDefault(stored) : envFallback();
  cached = { at: Date.now(), value: final };
  return final;
}

export async function setRuntimeModel(model: string): Promise<void> {
  await convex.mutation(api.settings.set, { key: MODEL_KEY, value: model });
  cached = { at: Date.now(), value: model };
}

export async function clearRuntimeModel(): Promise<void> {
  await convex.mutation(api.settings.clear, { key: MODEL_KEY });
  cached = null;
}
