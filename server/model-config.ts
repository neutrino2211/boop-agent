import type { KnownProvider, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export const piModels = builtinModels();

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

const PROVIDERS = new Set<string>(piModels.getProviders().map((p) => p.id));

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

const AUTO_FALLBACK_MODELS = [
  "anthropic/claude-sonnet-4-6",
  "azure-openai-responses/gpt-5-mini",
  "azure-openai-responses/gpt-5",
  "openrouter/anthropic/claude-sonnet-4.5",
] as const;

function hasProviderPrefix(input: string): boolean {
  const slash = input.indexOf("/");
  if (slash <= 0) return false;
  const provider = input.slice(0, slash).toLowerCase();
  return PROVIDERS.has(provider);
}

function canonicalizeWithProvider(provider: string, modelId: string): string | null {
  if (!PROVIDERS.has(provider)) return null;
  const providerModels = piModels.getModels(provider);
  const found = providerModels.find((m) => m.id.toLowerCase() === modelId.toLowerCase());
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

interface ProviderStatus {
  ok: boolean;
  reason?: string;
}

function hasPlaceholderToken(v: string | undefined): boolean {
  return Boolean(v && /<[^>]+>/.test(v));
}

function providerHasKey(provider: string): boolean {
  const envMap: Record<string, string | undefined> = {
    anthropic: process.env.ANTHROPIC_API_KEY,
    "azure-openai-responses": process.env.AZURE_OPENAI_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    groq: process.env.GROQ_API_KEY,
    xai: process.env.XAI_API_KEY,
    cerebras: process.env.CEREBRAS_API_KEY,
    fireworks: process.env.FIREWORKS_API_KEY,
    mistral: process.env.MISTRAL_API_KEY,
    minimax: process.env.MINIMAX_API_KEY,
    "minimax-cn": process.env.MINIMAX_CN_API_KEY,
    moonshotai: process.env.MOONSHOT_API_KEY,
    "moonshotai-cn": process.env.MOONSHOT_API_KEY,
    opencode: process.env.OPENCODE_API_KEY,
    "opencode-go": process.env.OPENCODE_API_KEY,
    "kimi-coding": process.env.KIMI_API_KEY,
    huggingface: process.env.HF_TOKEN,
    zai: process.env.ZAI_API_KEY,
    "vercel-ai-gateway": process.env.AI_GATEWAY_API_KEY,
    "cloudflare-workers-ai": process.env.CLOUDFLARE_API_KEY,
    "cloudflare-ai-gateway": process.env.CLOUDFLARE_API_KEY,
  };
  return Boolean(envMap[provider]);
}

function providerStatus(provider: string): ProviderStatus {
  if (!providerHasKey(provider)) {
    if (provider === "anthropic") {
      return { ok: false, reason: "missing ANTHROPIC_API_KEY (or ANTHROPIC_OAUTH_TOKEN)" };
    }
    if (provider === "azure-openai-responses") {
      return { ok: false, reason: "missing AZURE_OPENAI_API_KEY" };
    }
    return { ok: false, reason: `missing API key for provider "${provider}"` };
  }
  if (provider === "azure-openai-responses") {
    const baseUrl = process.env.AZURE_OPENAI_BASE_URL?.trim();
    const resource = process.env.AZURE_OPENAI_RESOURCE_NAME?.trim();
    if (!baseUrl && !resource) {
      return {
        ok: false,
        reason: "missing AZURE_OPENAI_BASE_URL (or AZURE_OPENAI_RESOURCE_NAME)",
      };
    }
    if (hasPlaceholderToken(baseUrl)) {
      return {
        ok: false,
        reason: "AZURE_OPENAI_BASE_URL still contains a placeholder (<...>)",
      };
    }
  }
  return { ok: true };
}

export function modelStatus(ref: string): ProviderStatus {
  const slash = ref.indexOf("/");
  if (slash <= 0) return { ok: false, reason: `invalid model reference: ${ref}` };
  const provider = ref.slice(0, slash).toLowerCase();
  if (!PROVIDERS.has(provider)) {
    return { ok: false, reason: `unknown provider: ${provider}` };
  }
  return providerStatus(provider);
}

export function bestConfiguredModel(preferred: Array<string | undefined> = []): string | null {
  const seen = new Set<string>();
  const candidates = [...preferred, ...AUTO_FALLBACK_MODELS];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = resolveModelInput(candidate) ?? candidate;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const status = modelStatus(normalized);
    if (status.ok) return normalized;
  }
  return null;
}

export function normalizeModelOrDefault(input: string | undefined): string {
  if (input) {
    const normalized = resolveModelInput(input);
    if (normalized) return normalized;
  }
  const auto = bestConfiguredModel();
  if (auto) return auto;
  return DEFAULT_MODEL;
}

export function resolveModelRef(input: string | undefined): { ref: string; model: Model<any> } {
  const ref = normalizeModelOrDefault(input);
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const found = piModels.getModels(provider).find((m) => m.id === modelId);
  if (!found) {
    throw new Error(`Unknown model reference: ${ref}`);
  }
  return {
    ref,
    model: found,
  };
}
