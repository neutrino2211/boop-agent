import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

interface ProviderSummary {
  provider: string;
  label: string;
  api: string;
  recommendedModel: string | null;
  configured: boolean;
  requiredEnv: string[];
}

interface ProviderConfigSnapshot {
  modelOverride: string | null;
  reasoningOverride: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  envOverrides: Record<string, string | null>;
  providers: ProviderSummary[];
}

const OPENAI_FORMAT_APIS = new Set(["openai-completions", "openai-responses"]);
const RUNTIME_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const EMBEDDING_ENV_KEYS = [
  "BOOP_ENABLE_BGE_MODEL",
  "BOOP_ENABLE_LOCAL_EMBEDDINGS",
  "BOOP_PRELOAD_LOCAL_EMBEDDINGS",
] as const;

const PROVIDER_FIELDS: Record<string, string[]> = {
  "azure-openai-responses": [
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  ],
};

const FIELD_META: Record<
  string,
  {
    label: string;
    placeholder: string;
    description: string;
    multiline?: boolean;
  }
> = {
  AZURE_OPENAI_API_KEY: {
    label: "Azure API key",
    placeholder: "AZURE_OPENAI_API_KEY",
    description: "Required. API key from your Azure OpenAI resource.",
  },
  AZURE_OPENAI_BASE_URL: {
    label: "Azure base URL",
    placeholder: "https://your-resource.openai.azure.com",
    description:
      "Required. Resource endpoint. Root URLs auto-normalize to /openai/v1.",
  },
  AZURE_OPENAI_API_VERSION: {
    label: "API version",
    placeholder: "v1",
    description: "Optional. Leave empty to use provider default.",
  },
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP: {
    label: "Deployment map",
    placeholder: "gpt-4o=prod,gpt-5=prod-gpt5",
    description:
      "Optional. Comma-separated model=deployment pairs for Azure deployment aliases.",
    multiline: true,
  },
  OPENAI_API_KEY: {
    label: "OpenAI API key",
    placeholder: "OPENAI_API_KEY",
    description: "Required.",
  },
  OPENROUTER_API_KEY: {
    label: "OpenRouter API key",
    placeholder: "OPENROUTER_API_KEY",
    description: "Required.",
  },
  GROQ_API_KEY: {
    label: "Groq API key",
    placeholder: "GROQ_API_KEY",
    description: "Required.",
  },
  DEEPSEEK_API_KEY: {
    label: "DeepSeek API key",
    placeholder: "DEEPSEEK_API_KEY",
    description: "Required.",
  },
  XAI_API_KEY: {
    label: "xAI API key",
    placeholder: "XAI_API_KEY",
    description: "Required.",
  },
  CEREBRAS_API_KEY: {
    label: "Cerebras API key",
    placeholder: "CEREBRAS_API_KEY",
    description: "Required.",
  },
  MOONSHOT_API_KEY: {
    label: "Moonshot API key",
    placeholder: "MOONSHOT_API_KEY",
    description: "Required.",
  },
  HF_TOKEN: {
    label: "Hugging Face token",
    placeholder: "HF_TOKEN",
    description: "Required.",
  },
  ZAI_API_KEY: {
    label: "Z.AI API key",
    placeholder: "ZAI_API_KEY",
    description: "Required.",
  },
  FIREWORKS_API_KEY: {
    label: "Fireworks API key",
    placeholder: "FIREWORKS_API_KEY",
    description: "Required.",
  },
  MISTRAL_API_KEY: {
    label: "Mistral API key",
    placeholder: "MISTRAL_API_KEY",
    description: "Required.",
  },
  MINIMAX_API_KEY: {
    label: "MiniMax API key",
    placeholder: "MINIMAX_API_KEY",
    description: "Required.",
  },
  MINIMAX_CN_API_KEY: {
    label: "MiniMax CN API key",
    placeholder: "MINIMAX_CN_API_KEY",
    description: "Required.",
  },
  KIMI_API_KEY: {
    label: "Kimi API key",
    placeholder: "KIMI_API_KEY",
    description: "Required.",
  },
  OPENCODE_API_KEY: {
    label: "OpenCode API key",
    placeholder: "OPENCODE_API_KEY",
    description: "Required.",
  },
  AI_GATEWAY_API_KEY: {
    label: "Vercel AI Gateway key",
    placeholder: "AI_GATEWAY_API_KEY",
    description: "Required.",
  },
  CLOUDFLARE_API_KEY: {
    label: "Cloudflare API key",
    placeholder: "CLOUDFLARE_API_KEY",
    description: "Required.",
  },
  CLOUDFLARE_ACCOUNT_ID: {
    label: "Cloudflare account ID",
    placeholder: "CLOUDFLARE_ACCOUNT_ID",
    description: "Required for Cloudflare AI endpoints.",
  },
  CLOUDFLARE_GATEWAY_ID: {
    label: "Cloudflare gateway ID",
    placeholder: "CLOUDFLARE_GATEWAY_ID",
    description: "Required for Cloudflare AI Gateway.",
  },
  BOOP_ENABLE_BGE_MODEL: {
    label: "Enable BGE model",
    placeholder: "true",
    description:
      "When false, disables local BGE model entirely (no pull, no local embedding fallback).",
  },
  BOOP_ENABLE_LOCAL_EMBEDDINGS: {
    label: "Enable local embeddings",
    placeholder: "true",
    description:
      "When false, local embedding fallback is disabled even if BGE model is enabled.",
  },
  BOOP_PRELOAD_LOCAL_EMBEDDINGS: {
    label: "Preload local embeddings",
    placeholder: "true",
    description:
      "When true, server preloads BGE model at startup (recommended in dev; often off in prod).",
  },
};

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function envToggleValue(
  draftOverrides: Record<string, string>,
  key: string,
  defaultEnabled: boolean,
): "true" | "false" {
  const raw = draftOverrides[key];
  if (raw === undefined || raw.trim() === "") return defaultEnabled ? "true" : "false";
  return raw.trim().toLowerCase() === "false" ? "false" : "true";
}

function isSensitiveField(envKey: string): boolean {
  return /(?:API_KEY|TOKEN|SECRET)/.test(envKey);
}

function providerFields(provider: ProviderSummary): string[] {
  const preferred = PROVIDER_FIELDS[provider.provider];
  if (preferred) return preferred;
  return provider.requiredEnv;
}

function apiLabel(api: string): string {
  if (api === "openai-responses") return "OpenAI Responses";
  if (api === "openai-completions") return "OpenAI Chat Completions";
  if (api === "azure-openai-responses") return "Azure OpenAI Responses";
  return api;
}

async function parseError(response: Response): Promise<string> {
  const json = await response.json().catch(() => null);
  if (json && typeof json.error === "string" && json.error.trim()) {
    return json.error;
  }
  return `Request failed (${response.status})`;
}

export function ProviderSettingsSection({ isDark }: { isDark: boolean }) {
  const [snapshot, setSnapshot] = useState<ProviderConfigSnapshot | null>(null);
  const [draftModel, setDraftModel] = useState("");
  const [draftReasoning, setDraftReasoning] = useState("");
  const [draftOverrides, setDraftOverrides] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hydrateDrafts = useCallback((next: ProviderConfigSnapshot) => {
    const envDrafts: Record<string, string> = {};
    for (const [envKey, value] of Object.entries(next.envOverrides)) {
      envDrafts[envKey] = value ?? "";
    }
    setDraftOverrides(envDrafts);
    setDraftModel(next.modelOverride ?? "");
    setDraftReasoning(next.reasoningOverride ?? "");
  }, []);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/provider-config");
      if (!response.ok) throw new Error(await parseError(response));
      const next = (await response.json()) as ProviderConfigSnapshot;
      setSnapshot(next);
      hydrateDrafts(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hydrateDrafts]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  const persist = useCallback(
    async (
      payload: {
        model?: string | null;
        reasoning?: string | null;
        envOverrides?: Record<string, string | null>;
      },
      busyKey: string,
      successNotice: string,
    ) => {
      setBusy(busyKey);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch("/api/provider-config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(await parseError(response));
        const next = (await response.json()) as ProviderConfigSnapshot;
        setSnapshot(next);
        hydrateDrafts(next);
        setNotice(successNotice);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [hydrateDrafts],
  );

  const azureProvider = useMemo(
    () => snapshot?.providers.find((provider) => provider.provider === "azure-openai-responses") ?? null,
    [snapshot],
  );

  const openAiFormatProviders = useMemo(
    () =>
      (snapshot?.providers ?? []).filter(
        (provider) =>
          provider.provider !== "azure-openai-responses" && OPENAI_FORMAT_APIS.has(provider.api),
      ),
    [snapshot],
  );

  const cardBg = isDark ? "bg-slate-900/40 border-slate-800/60" : "bg-white border-slate-200";
  const innerBg = isDark ? "bg-slate-900 border-slate-800/70" : "bg-slate-50 border-slate-200";
  const muted = isDark ? "text-slate-400" : "text-slate-600";
  const faint = isDark ? "text-slate-500" : "text-slate-400";
  const inputBg = isDark
    ? "bg-slate-950 border-slate-700 text-slate-200 placeholder:text-slate-600"
    : "bg-white border-slate-300 text-slate-800 placeholder:text-slate-400";
  const primaryBtn = "bg-sky-600 hover:bg-sky-500 text-white";
  const subtleBtn = isDark
    ? "text-slate-300 hover:text-slate-100 hover:bg-slate-800"
    : "text-slate-600 hover:text-slate-800 hover:bg-slate-100";

  const modelSuggestions = (snapshot?.providers ?? [])
    .map((provider) => provider.recommendedModel)
    .filter((value): value is string => Boolean(value))
    .slice(0, 6);

  const bgeEnabled = envToggleValue(draftOverrides, "BOOP_ENABLE_BGE_MODEL", true);
  const localEmbEnabled = envToggleValue(draftOverrides, "BOOP_ENABLE_LOCAL_EMBEDDINGS", true);
  const preloadLocalEmb = envToggleValue(
    draftOverrides,
    "BOOP_PRELOAD_LOCAL_EMBEDDINGS",
    true,
  );

  return (
    <div className={`border rounded-xl p-4 fade-in ${cardBg}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-sm font-medium ${isDark ? "text-slate-200" : "text-slate-800"}`}>
            AI providers
          </div>
          <div className={`text-xs mt-1 ${muted}`}>
            Configure Azure OpenAI and other OpenAI-format providers from UI. Values are saved to
            Convex settings and applied to runtime env overrides.
          </div>
        </div>
        <button
          onClick={() => void loadSnapshot()}
          disabled={loading || busy !== null}
          className={`text-xs px-2.5 py-1.5 rounded-md disabled:opacity-50 ${subtleBtn}`}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div
          className={`mt-3 text-xs rounded-md border px-2.5 py-2 ${
            isDark
              ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          className={`mt-3 text-xs rounded-md border px-2.5 py-2 ${
            isDark
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-emerald-200 bg-emerald-50 text-emerald-700"
          }`}
        >
          {notice}
        </div>
      )}

      <div className={`mt-4 border rounded-lg p-3 ${innerBg}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={`text-xs font-semibold uppercase tracking-wider ${faint}`}>
              Runtime model override
            </div>
            <div className={`text-xs mt-1 ${muted}`}>
              Use `provider/model-id`. Leave blank to fall back to `BOOP_MODEL` plus auto-fallback.
            </div>
          </div>
          {snapshot && (
            <span className={`text-[10px] mono ${faint}`}>
              active: {snapshot.modelOverride ?? "(unset)"}
            </span>
          )}
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              placeholder="azure-openai-responses/gpt-5-mini"
              className={`text-xs px-2.5 py-2 border rounded-md flex-1 mono ${inputBg}`}
              disabled={loading || busy !== null}
            />
            <button
              onClick={() =>
                void persist(
                  { model: trimmedOrNull(draftModel) },
                  "model",
                  trimmedOrNull(draftModel) ? "Model override saved." : "Model override cleared.",
                )}
              disabled={loading || busy !== null}
              className={`text-xs px-3 py-2 rounded-md disabled:opacity-50 ${primaryBtn}`}
            >
              {busy === "model" ? "Saving..." : "Save"}
            </button>
          </div>
          {modelSuggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {modelSuggestions.map((model) => (
                <button
                  key={model}
                  onClick={() => setDraftModel(model)}
                  disabled={loading || busy !== null}
                  className={`text-[11px] px-2 py-1 rounded-md disabled:opacity-50 mono ${subtleBtn}`}
                >
                  {model}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={`mt-4 border-t pt-3 ${isDark ? "border-slate-800/60" : "border-slate-200/60"}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wider ${faint}`}>
                Runtime reasoning level
              </div>
              <div className={`text-xs mt-1 ${muted}`}>
                Controls model reasoning effort for dispatcher and spawned agents. Higher levels
                may improve quality but increase latency and cost.
              </div>
            </div>
            {snapshot && (
              <span className={`text-[10px] mono ${faint}`}>
                active: {snapshot.reasoningOverride ?? "(default: off)"}
              </span>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <select
              value={draftReasoning}
              onChange={(e) => setDraftReasoning(e.target.value)}
              className={`text-xs px-2.5 py-2 border rounded-md flex-1 mono ${inputBg}`}
              disabled={loading || busy !== null}
            >
              <option value="">(unset: default off)</option>
              {RUNTIME_REASONING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            <button
              onClick={() =>
                void persist(
                  { reasoning: draftReasoning || null },
                  "reasoning",
                  draftReasoning
                    ? `Reasoning level set to ${draftReasoning}.`
                    : "Reasoning override cleared (default off).",
                )}
              disabled={loading || busy !== null}
              className={`text-xs px-3 py-2 rounded-md disabled:opacity-50 ${primaryBtn}`}
            >
              {busy === "reasoning" ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        <div className={`mt-4 border-t pt-3 ${isDark ? "border-slate-800/60" : "border-slate-200/60"}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className={`text-xs font-semibold uppercase tracking-wider ${faint}`}>
                Local embeddings (BGE)
              </div>
              <div className={`text-xs mt-1 ${muted}`}>
                Controls local semantic embedding fallback used for memory recall and re-embed.
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2">
            <label className="flex flex-col gap-1">
              <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                Enable BGE model
              </span>
              <select
                value={bgeEnabled}
                onChange={(e) =>
                  setDraftOverrides((prev) => ({ ...prev, BOOP_ENABLE_BGE_MODEL: e.target.value }))
                }
                className={`text-xs px-2.5 py-2 border rounded-md mono ${inputBg}`}
                disabled={loading || busy !== null}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                Enable local embeddings
              </span>
              <select
                value={localEmbEnabled}
                onChange={(e) =>
                  setDraftOverrides((prev) => ({
                    ...prev,
                    BOOP_ENABLE_LOCAL_EMBEDDINGS: e.target.value,
                  }))
                }
                className={`text-xs px-2.5 py-2 border rounded-md mono ${inputBg}`}
                disabled={loading || busy !== null}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                Preload local model
              </span>
              <select
                value={preloadLocalEmb}
                onChange={(e) =>
                  setDraftOverrides((prev) => ({
                    ...prev,
                    BOOP_PRELOAD_LOCAL_EMBEDDINGS: e.target.value,
                  }))
                }
                className={`text-xs px-2.5 py-2 border rounded-md mono ${inputBg}`}
                disabled={loading || busy !== null}
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() =>
                void persist(
                  {
                    envOverrides: Object.fromEntries(
                      EMBEDDING_ENV_KEYS.map((key) => [key, trimmedOrNull(draftOverrides[key] ?? "")]),
                    ),
                  },
                  "embeddings",
                  "Embedding runtime flags saved.",
                )}
              disabled={loading || busy !== null}
              className={`text-xs px-3 py-2 rounded-md disabled:opacity-50 ${primaryBtn}`}
            >
              {busy === "embeddings" ? "Saving..." : "Save embedding flags"}
            </button>
            <button
              onClick={() =>
                void persist(
                  {
                    envOverrides: Object.fromEntries(EMBEDDING_ENV_KEYS.map((key) => [key, null])),
                  },
                  "embeddings:clear",
                  "Embedding runtime flags cleared (defaults apply).",
                )}
              disabled={loading || busy !== null}
              className={`text-xs px-2.5 py-2 rounded-md disabled:opacity-50 ${subtleBtn}`}
            >
              Clear
            </button>
          </div>
          <div className={`text-[10px] mt-2 ${faint}`}>
            In Docker runtime, defaults are often disabled unless explicitly overridden here.
          </div>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {loading && snapshot === null ? (
          <div className={`h-24 rounded-lg border shimmer ${innerBg}`} />
        ) : (
          <>
            {azureProvider && (
              <ProviderCard
                provider={azureProvider}
                draftOverrides={draftOverrides}
                snapshot={snapshot!}
                busy={busy}
                isDark={isDark}
                muted={muted}
                faint={faint}
                inputBg={inputBg}
                primaryBtn={primaryBtn}
                subtleBtn={subtleBtn}
                setDraftOverrides={setDraftOverrides}
                onSave={(provider, fields) =>
                  persist(
                    {
                      envOverrides: Object.fromEntries(
                        fields.map((field) => [field, trimmedOrNull(draftOverrides[field] ?? "")]),
                      ),
                    },
                    `provider:${provider.provider}`,
                    `${provider.label} settings saved.`,
                  )}
                onClear={(provider, fields) =>
                  persist(
                    {
                      envOverrides: Object.fromEntries(fields.map((field) => [field, null])),
                    },
                    `provider:${provider.provider}`,
                    `${provider.label} overrides cleared.`,
                  )}
                onUseModel={(provider) => {
                  if (!provider.recommendedModel) return Promise.resolve();
                  return persist(
                    { model: provider.recommendedModel },
                    `model:${provider.provider}`,
                    `Model set to ${provider.recommendedModel}.`,
                  );
                }}
              />
            )}

            {openAiFormatProviders.length > 0 && (
              <div>
                <div className={`text-xs font-semibold uppercase tracking-wider mb-2 ${faint}`}>
                  OpenAI-format providers
                </div>
                <div className="space-y-3">
                  {openAiFormatProviders.map((provider) => (
                    <ProviderCard
                      key={provider.provider}
                      provider={provider}
                      draftOverrides={draftOverrides}
                      snapshot={snapshot!}
                      busy={busy}
                      isDark={isDark}
                      muted={muted}
                      faint={faint}
                      inputBg={inputBg}
                      primaryBtn={primaryBtn}
                      subtleBtn={subtleBtn}
                      setDraftOverrides={setDraftOverrides}
                      onSave={(currentProvider, fields) =>
                        persist(
                          {
                            envOverrides: Object.fromEntries(
                              fields.map((field) => [
                                field,
                                trimmedOrNull(draftOverrides[field] ?? ""),
                              ]),
                            ),
                          },
                          `provider:${currentProvider.provider}`,
                          `${currentProvider.label} settings saved.`,
                        )}
                      onClear={(currentProvider, fields) =>
                        persist(
                          {
                            envOverrides: Object.fromEntries(fields.map((field) => [field, null])),
                          },
                          `provider:${currentProvider.provider}`,
                          `${currentProvider.label} overrides cleared.`,
                        )}
                      onUseModel={(currentProvider) => {
                        if (!currentProvider.recommendedModel) return Promise.resolve();
                        return persist(
                          { model: currentProvider.recommendedModel },
                          `model:${currentProvider.provider}`,
                          `Model set to ${currentProvider.recommendedModel}.`,
                        );
                      }}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  draftOverrides,
  snapshot,
  busy,
  isDark,
  muted,
  faint,
  inputBg,
  primaryBtn,
  subtleBtn,
  setDraftOverrides,
  onSave,
  onClear,
  onUseModel,
}: {
  provider: ProviderSummary;
  draftOverrides: Record<string, string>;
  snapshot: ProviderConfigSnapshot;
  busy: string | null;
  isDark: boolean;
  muted: string;
  faint: string;
  inputBg: string;
  primaryBtn: string;
  subtleBtn: string;
  setDraftOverrides: Dispatch<SetStateAction<Record<string, string>>>;
  onSave: (provider: ProviderSummary, fields: string[]) => Promise<void>;
  onClear: (provider: ProviderSummary, fields: string[]) => Promise<void>;
  onUseModel: (provider: ProviderSummary) => Promise<void>;
}) {
  const fields = providerFields(provider);
  const busyKey = `provider:${provider.provider}`;
  const isSaving = busy === busyKey;
  const isSettingModel = busy === `model:${provider.provider}`;
  const hasSavedOverride = fields.some((field) => snapshot.envOverrides[field] !== null);

  const cardBg = isDark ? "bg-slate-900 border-slate-800/70" : "bg-slate-50 border-slate-200";

  return (
    <div className={`border rounded-lg p-3 ${cardBg}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-sm font-medium ${isDark ? "text-slate-200" : "text-slate-800"}`}>
            {provider.label}
          </div>
          <div className={`text-xs mt-1 ${muted}`}>
            API: {apiLabel(provider.api)} · provider id:{" "}
            <span className="mono">{provider.provider}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${
              provider.configured
                ? isDark
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-emerald-50 text-emerald-700"
                : isDark
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-amber-50 text-amber-700"
            }`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                provider.configured ? "bg-emerald-400" : "bg-amber-400"
              }`}
            />
            {provider.configured ? "Configured" : "Missing required values"}
          </span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {fields.map((field) => {
          const meta = FIELD_META[field] ?? {
            label: field,
            placeholder: field,
            description: provider.requiredEnv.includes(field) ? "Required." : "Optional.",
          };
          const value = draftOverrides[field] ?? "";
          const required = provider.requiredEnv.includes(field);
          const inputType = isSensitiveField(field) ? "password" : "text";
          return (
            <label key={field} className="flex flex-col gap-1">
              <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                {meta.label}
                <span className={`ml-1 ${faint}`}>{required ? "(required)" : "(optional)"}</span>
              </span>
              {meta.multiline ? (
                <textarea
                  rows={2}
                  value={value}
                  onChange={(e) =>
                    setDraftOverrides((prev) => ({ ...prev, [field]: e.target.value }))
                  }
                  placeholder={meta.placeholder}
                  disabled={isSaving || isSettingModel}
                  className={`text-xs px-2.5 py-2 border rounded-md mono resize-y ${inputBg}`}
                />
              ) : (
                <input
                  type={inputType}
                  value={value}
                  onChange={(e) =>
                    setDraftOverrides((prev) => ({ ...prev, [field]: e.target.value }))
                  }
                  placeholder={meta.placeholder}
                  disabled={isSaving || isSettingModel}
                  className={`text-xs px-2.5 py-2 border rounded-md mono ${inputBg}`}
                />
              )}
              <span className={`text-[10px] ${faint}`}>{meta.description}</span>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => void onSave(provider, fields)}
          disabled={isSaving || isSettingModel}
          className={`text-xs px-3 py-1.5 rounded-md disabled:opacity-50 ${primaryBtn}`}
        >
          {isSaving ? "Saving..." : "Save provider"}
        </button>
        <button
          onClick={() => void onClear(provider, fields)}
          disabled={isSaving || isSettingModel || !hasSavedOverride}
          className={`text-xs px-2.5 py-1.5 rounded-md disabled:opacity-50 ${subtleBtn}`}
        >
          Clear overrides
        </button>
        {provider.recommendedModel && (
          <button
            onClick={() => void onUseModel(provider)}
            disabled={isSaving || isSettingModel}
            className={`text-xs px-2.5 py-1.5 rounded-md disabled:opacity-50 mono ${subtleBtn}`}
          >
            {isSettingModel ? "Setting model..." : `Use ${provider.recommendedModel}`}
          </button>
        )}
      </div>

      {provider.recommendedModel && (
        <div className={`mt-2 text-[10px] mono ${faint}`}>
          recommended: {provider.recommendedModel}
        </div>
      )}
    </div>
  );
}
