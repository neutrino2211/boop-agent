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
const REASONING_KEY = "reasoning";
const SPLIT_KEY = "split_responses";
const MODEL_TTL_MS = 30 * 1000;
const REASONING_TTL_MS = 30 * 1000;
const SPLIT_TTL_MS = 30 * 1000;
let cachedModel: { at: number; value: string } | null = null;
let cachedReasoning: { at: number; value: RuntimeReasoningLevel } | null = null;
let cachedSplit: { at: number; value: string } | null = null;

export const RUNTIME_REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type RuntimeReasoningLevel = (typeof RUNTIME_REASONING_LEVELS)[number];

export { DEFAULT_MODEL, KNOWN_MODELS, MODEL_ALIASES, resolveModelInput };

function envFallback(): string {
  return normalizeModelOrDefault(process.env.BOOP_MODEL);
}

export function resolveReasoningInput(input: string): RuntimeReasoningLevel | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  if ((RUNTIME_REASONING_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as RuntimeReasoningLevel;
  }
  return null;
}

function envReasoningFallback(): RuntimeReasoningLevel {
  const envValue = process.env.BOOP_REASONING_LEVEL ?? process.env.BOOP_REASONING;
  if (!envValue) return "off";
  return resolveReasoningInput(envValue) ?? "off";
}

export async function getRuntimeModel(): Promise<string> {
  if (cachedModel && Date.now() - cachedModel.at < MODEL_TTL_MS) return cachedModel.value;
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
  cachedModel = { at: Date.now(), value: final };
  return final;
}

export async function setRuntimeModel(model: string): Promise<void> {
  await convex.mutation(api.settings.set, { key: MODEL_KEY, value: model });
  cachedModel = { at: Date.now(), value: model };
}

export async function clearRuntimeModel(): Promise<void> {
  await convex.mutation(api.settings.clear, { key: MODEL_KEY });
  cachedModel = null;
}

export async function getRuntimeReasoningLevel(): Promise<RuntimeReasoningLevel> {
  if (cachedReasoning && Date.now() - cachedReasoning.at < REASONING_TTL_MS) {
    return cachedReasoning.value;
  }

  let stored: string | null = null;
  try {
    stored = await convex.query(api.settings.get, { key: REASONING_KEY });
  } catch (err) {
    console.warn("[runtime-config] settings:get(reasoning) failed", err);
  }

  const resolved = stored ? resolveReasoningInput(stored) : null;
  const value = resolved ?? envReasoningFallback();
  cachedReasoning = { at: Date.now(), value };
  return value;
}

export async function setRuntimeReasoningLevel(
  level: RuntimeReasoningLevel,
): Promise<void> {
  await convex.mutation(api.settings.set, { key: REASONING_KEY, value: level });
  cachedReasoning = { at: Date.now(), value: level };
}

export async function clearRuntimeReasoningLevel(): Promise<void> {
  await convex.mutation(api.settings.clear, { key: REASONING_KEY });
  cachedReasoning = null;
}

function envSplitFallback(): string {
  const envValue = process.env.BOOP_SPLIT_RESPONSES;
  if (envValue === "on" || envValue === "off") return envValue;
  return "on";
}

export async function getRuntimeSplitResponses(): Promise<string> {
  if (cachedSplit && Date.now() - cachedSplit.at < SPLIT_TTL_MS) return cachedSplit.value;
  let stored: string | null = null;
  try {
    stored = await convex.query(api.settings.get, { key: SPLIT_KEY });
  } catch (err) {
    console.warn("[runtime-config] settings:get(split_responses) failed", err);
  }
  const value = stored === "on" || stored === "off" ? stored : envSplitFallback();
  cachedSplit = { at: Date.now(), value };
  return value;
}

export async function setRuntimeSplitResponses(value: string): Promise<void> {
  await convex.mutation(api.settings.set, { key: SPLIT_KEY, value });
  cachedSplit = { at: Date.now(), value };
}

export async function clearRuntimeSplitResponses(): Promise<void> {
  await convex.mutation(api.settings.clear, { key: SPLIT_KEY });
  cachedSplit = null;
}
