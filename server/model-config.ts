import { getModels, getProviders, type KnownProvider, type Model } from "@earendil-works/pi-ai";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

const PROVIDERS = new Set<string>(getProviders());

// Friendly aliases users can text via set_model.
export const MODEL_ALIASES: Record<string, string> = {
  opus: "anthropic/claude-opus-4-7",
  "opus 4.7": "anthropic/claude-opus-4-7",
  sonnet: "anthropic/claude-sonnet-4-6",
  "sonnet 4.6": "anthropic/claude-sonnet-4-6",
  haiku: "anthropic/claude-haiku-4-5-20251001",
  "haiku 4.5": "anthropic/claude-haiku-4-5-20251001",
  "gpt-5": "azure-openai-responses/gpt-5",
  gpt5: "azure-openai-responses/gpt-5",
  "gpt-5 mini": "azure-openai-responses/gpt-5-mini",
  "gpt5 mini": "azure-openai-responses/gpt-5-mini",
  "gpt-5 nano": "azure-openai-responses/gpt-5-nano",
  "gpt4o": "azure-openai-responses/gpt-4o",
  "gpt-4o": "azure-openai-responses/gpt-4o",
  "openrouter sonnet": "openrouter/anthropic/claude-sonnet-4.5",
  "azure gpt-5": "azure-openai-responses/gpt-5",
  "azure gpt-5 mini": "azure-openai-responses/gpt-5-mini",
};

const CURATED_MODELS = [
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5-20251001",
  "openrouter/anthropic/claude-sonnet-4.5",
  "openrouter/openai/gpt-5",
  "azure-openai-responses/gpt-5",
  "azure-openai-responses/gpt-5-mini",
  "azure-openai-responses/gpt-5-nano",
  "azure-openai-responses/gpt-4o",
  "azure-openai-responses/gpt-4.1",
] as const;

export const KNOWN_MODELS = new Set<string>(CURATED_MODELS);

function hasProviderPrefix(input: string): boolean {
  const slash = input.indexOf("/");
  if (slash <= 0) return false;
  const provider = input.slice(0, slash).toLowerCase();
  return PROVIDERS.has(provider);
}

function canonicalizeWithProvider(provider: string, modelId: string): string | null {
  if (!PROVIDERS.has(provider)) return null;
  const models = getModels(provider as KnownProvider);
  const found = models.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
  return found ? `${provider}/${found.id}` : null;
}

function canonicalizeAcrossProviders(modelId: string, providers: string[]): string | null {
  for (const provider of providers) {
    const found = canonicalizeWithProvider(provider, modelId);
    if (found) return found;
  }
  return null;
}

function normalizeCandidate(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  const alias = MODEL_ALIASES[lower];
  if (alias) return alias;

  if (hasProviderPrefix(trimmed)) {
    const slash = trimmed.indexOf("/");
    const provider = trimmed.slice(0, slash).toLowerCase();
    const modelId = trimmed.slice(slash + 1).trim();
    return canonicalizeWithProvider(provider, modelId);
  }

  // Convenience: bare GPT-family IDs should route to Azure first when
  // available, so users can text "use gpt-5" without the provider prefix.
  if (/^(gpt-|gpt\d|o\d|o\d-)/i.test(trimmed)) {
    const azureFirst = canonicalizeAcrossProviders(trimmed, [
      "azure-openai-responses",
      "openai",
    ]);
    if (azureFirst) return azureFirst;
  }

  // Back-compat for legacy BOOP_MODEL/set_model values like "claude-sonnet-4-6".
  return canonicalizeAcrossProviders(trimmed, ["anthropic"]);
}

export function resolveModelInput(input: string): string | null {
  const normalized = normalizeCandidate(input);
  return normalized;
}

export function normalizeModelOrDefault(input: string | undefined): string {
  if (input) {
    const normalized = resolveModelInput(input);
    if (normalized) return normalized;
  }
  return DEFAULT_MODEL;
}

export function resolveModelRef(input: string | undefined): { ref: string; model: Model<any> } {
  const ref = normalizeModelOrDefault(input);
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash) as KnownProvider;
  const modelId = ref.slice(slash + 1);
  const model = getModels(provider).find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`Unknown model reference: ${ref}`);
  }
  return {
    ref,
    model,
  };
}
