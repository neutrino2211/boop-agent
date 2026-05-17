import { getModels, type KnownProvider } from "@earendil-works/pi-ai";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { resolveReasoningInput, type RuntimeReasoningLevel } from "./runtime-config.js";

const ENV_OVERRIDE_PREFIX = "env_override.";
const MODEL_KEY = "model";
const REASONING_KEY = "reasoning";

export const PROVIDER_ENV_KEYS = [
  "BOOP_ENABLE_BGE_MODEL",
  "BOOP_ENABLE_LOCAL_EMBEDDINGS",
  "BOOP_PRELOAD_LOCAL_EMBEDDINGS",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "OPENAI_API_KEY",
  "FIREWORKS_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "KIMI_API_KEY",
  "OPENCODE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "CEREBRAS_API_KEY",
  "MOONSHOT_API_KEY",
  "HF_TOKEN",
  "ZAI_API_KEY",
] as const;

export type ProviderEnvKey = (typeof PROVIDER_ENV_KEYS)[number];

const PROVIDER_META = [
  {
    provider: "azure-openai-responses",
    label: "Azure OpenAI",
    api: "azure-openai-responses",
    requiredEnv: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL"] as ProviderEnvKey[],
  },
  {
    provider: "openai",
    label: "OpenAI",
    api: "openai-responses",
    requiredEnv: ["OPENAI_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "fireworks",
    label: "Fireworks",
    api: "openai-completions",
    requiredEnv: ["FIREWORKS_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "mistral",
    label: "Mistral",
    api: "openai-completions",
    requiredEnv: ["MISTRAL_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    api: "openai-completions",
    requiredEnv: ["OPENROUTER_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "groq",
    label: "Groq",
    api: "openai-completions",
    requiredEnv: ["GROQ_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "deepseek",
    label: "DeepSeek",
    api: "openai-completions",
    requiredEnv: ["DEEPSEEK_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "xai",
    label: "xAI",
    api: "openai-completions",
    requiredEnv: ["XAI_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "cerebras",
    label: "Cerebras",
    api: "openai-completions",
    requiredEnv: ["CEREBRAS_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "moonshotai",
    label: "Moonshot",
    api: "openai-completions",
    requiredEnv: ["MOONSHOT_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "moonshotai-cn",
    label: "Moonshot (CN)",
    api: "openai-completions",
    requiredEnv: ["MOONSHOT_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "minimax",
    label: "MiniMax",
    api: "openai-completions",
    requiredEnv: ["MINIMAX_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "minimax-cn",
    label: "MiniMax (CN)",
    api: "openai-completions",
    requiredEnv: ["MINIMAX_CN_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "opencode",
    label: "OpenCode",
    api: "openai-completions",
    requiredEnv: ["OPENCODE_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "opencode-go",
    label: "OpenCode Go",
    api: "openai-completions",
    requiredEnv: ["OPENCODE_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "kimi-coding",
    label: "Kimi Coding",
    api: "openai-completions",
    requiredEnv: ["KIMI_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "cloudflare-workers-ai",
    label: "Cloudflare Workers AI",
    api: "openai-completions",
    requiredEnv: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"] as ProviderEnvKey[],
  },
  {
    provider: "cloudflare-ai-gateway",
    label: "Cloudflare AI Gateway",
    api: "openai-completions",
    requiredEnv: [
      "CLOUDFLARE_API_KEY",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_GATEWAY_ID",
    ] as ProviderEnvKey[],
  },
  {
    provider: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    api: "openai-completions",
    requiredEnv: ["AI_GATEWAY_API_KEY"] as ProviderEnvKey[],
  },
  {
    provider: "huggingface",
    label: "HuggingFace Inference",
    api: "openai-completions",
    requiredEnv: ["HF_TOKEN"] as ProviderEnvKey[],
  },
  {
    provider: "zai",
    label: "Z.AI",
    api: "openai-completions",
    requiredEnv: ["ZAI_API_KEY"] as ProviderEnvKey[],
  },
] as const;

const bootEnv = new Map<ProviderEnvKey, string | undefined>(
  PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function settingKey(envKey: ProviderEnvKey): string {
  return `${ENV_OVERRIDE_PREFIX}${envKey}`;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isPlaceholder(value: string | null): boolean {
  return Boolean(value && /<[^>]+>/.test(value));
}

export function isProviderEnvKey(key: string): key is ProviderEnvKey {
  return (PROVIDER_ENV_KEYS as readonly string[]).includes(key);
}

export interface ProviderConfigSnapshot {
  modelOverride: string | null;
  reasoningOverride: RuntimeReasoningLevel | null;
  envOverrides: Record<ProviderEnvKey, string | null>;
  providers: Array<{
    provider: string;
    label: string;
    api: string;
    recommendedModel: string | null;
    configured: boolean;
    requiredEnv: ProviderEnvKey[];
  }>;
}

async function getSettingValue(key: string): Promise<string | null> {
  try {
    const value = await convex.query(api.settings.get, { key });
    return trimmedOrNull(value);
  } catch {
    return null;
  }
}

function effectiveEnvValue(envKey: ProviderEnvKey, override: string | null): string | null {
  if (override !== null) return override;
  return trimmedOrNull(process.env[envKey]);
}

function applyToProcessEnv(envKey: ProviderEnvKey, override: string | null): void {
  if (override !== null) {
    process.env[envKey] = override;
    return;
  }
  const original = bootEnv.get(envKey);
  if (original && original.trim()) {
    process.env[envKey] = original;
  } else {
    delete process.env[envKey];
  }
}

export async function hydrateProviderEnvOverrides(): Promise<void> {
  const values = await Promise.all(
    PROVIDER_ENV_KEYS.map(async (envKey) => [envKey, await getSettingValue(settingKey(envKey))] as const),
  );
  for (const [envKey, override] of values) {
    applyToProcessEnv(envKey, override);
  }
}

export async function updateProviderEnvOverrides(
  updates: Partial<Record<ProviderEnvKey, string | null>>,
): Promise<void> {
  for (const [rawKey, rawValue] of Object.entries(updates)) {
    if (!isProviderEnvKey(rawKey)) continue;
    const envKey = rawKey as ProviderEnvKey;
    const value = trimmedOrNull(rawValue);
    const key = settingKey(envKey);
    if (value === null) {
      await convex.mutation(api.settings.clear, { key });
    } else {
      await convex.mutation(api.settings.set, { key, value });
    }
    applyToProcessEnv(envKey, value);
  }
}

export async function getProviderConfigSnapshot(): Promise<ProviderConfigSnapshot> {
  const modelOverride = await getSettingValue(MODEL_KEY);
  const storedReasoning = await getSettingValue(REASONING_KEY);
  const reasoningOverride = storedReasoning ? resolveReasoningInput(storedReasoning) : null;
  const envOverridesEntries = await Promise.all(
    PROVIDER_ENV_KEYS.map(async (envKey) => [envKey, await getSettingValue(settingKey(envKey))] as const),
  );
  const envOverrides = Object.fromEntries(envOverridesEntries) as Record<
    ProviderEnvKey,
    string | null
  >;

  const providers = PROVIDER_META.map((meta) => {
    const recommendedModel = getModels(meta.provider as KnownProvider)[0]?.id ?? null;
    const configured = meta.requiredEnv.every((envKey) => {
      const value = effectiveEnvValue(envKey, envOverrides[envKey]);
      if (!value || isPlaceholder(value)) return false;
      if (
        meta.provider === "azure-openai-responses" &&
        envKey === "AZURE_OPENAI_BASE_URL" &&
        isPlaceholder(value)
      ) {
        return false;
      }
      return true;
    });
    return {
      provider: meta.provider,
      label: meta.label,
      api: meta.api,
      recommendedModel: recommendedModel ? `${meta.provider}/${recommendedModel}` : null,
      configured,
      requiredEnv: [...meta.requiredEnv],
    };
  });

  return {
    modelOverride,
    reasoningOverride,
    envOverrides,
    providers,
  };
}
