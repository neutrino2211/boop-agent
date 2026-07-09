import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";

const SETTING_PREFIX = "env_override.";

const TRILIUM_FIELDS = [
  {
    envKey: "TRILIUM_BASE_URL",
    label: "Base URL",
    placeholder: "https://notes.example.com",
    description: "Trilium server URL without /etapi.",
    sensitive: false,
    required: true,
  },
  {
    envKey: "TRILIUM_ETAPI_TOKEN",
    label: "ETAPI token",
    placeholder: "Paste token from Trilium ETAPI settings",
    description: "Sent as the Trilium Authorization header.",
    sensitive: true,
    required: true,
  },
  {
    envKey: "TRILIUM_ROOT_NOTE_ID",
    label: "Root note ID",
    placeholder: "root",
    description: "Optional parent note for synced catalog entries.",
    sensitive: false,
    required: false,
  },
] as const;

type TriliumEnvKey = (typeof TRILIUM_FIELDS)[number]["envKey"] | "TRILIUM_SYNC_ENABLED";
type Drafts = Record<TriliumEnvKey, string>;

const TRILIUM_SETTING_KEYS = [
  "TRILIUM_BASE_URL",
  "TRILIUM_ETAPI_TOKEN",
  "TRILIUM_ROOT_NOTE_ID",
  "TRILIUM_SYNC_ENABLED",
] satisfies TriliumEnvKey[];

interface Status {
  ok: boolean;
  error?: string;
}

function settingKey(envKey: TriliumEnvKey): string {
  return `${SETTING_PREFIX}${envKey}`;
}

async function parseError(response: Response): Promise<string> {
  const json = await response.json().catch(() => null);
  if (json && typeof json.error === "string" && json.error.trim()) return json.error;
  return `Request failed (${response.status})`;
}

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function TriliumSettingsSection({ isDark }: { isDark: boolean }) {
  const settings = useQuery(api.settings.getMany, {
    keys: TRILIUM_SETTING_KEYS.map(settingKey),
  });
  const setSetting = useMutation(api.settings.set);
  const clearSetting = useMutation(api.settings.clear);

  const [drafts, setDrafts] = useState<Drafts>({
    TRILIUM_BASE_URL: "",
    TRILIUM_ETAPI_TOKEN: "",
    TRILIUM_ROOT_NOTE_ID: "",
    TRILIUM_SYNC_ENABLED: "true",
  });
  const [busy, setBusy] = useState<"save" | "clear" | "test" | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loading = settings === undefined;

  const raw = useMemo<Record<TriliumEnvKey, string | null>>(
    () => ({
      TRILIUM_BASE_URL: settings?.[settingKey("TRILIUM_BASE_URL")] ?? null,
      TRILIUM_ETAPI_TOKEN: settings?.[settingKey("TRILIUM_ETAPI_TOKEN")] ?? null,
      TRILIUM_ROOT_NOTE_ID: settings?.[settingKey("TRILIUM_ROOT_NOTE_ID")] ?? null,
      TRILIUM_SYNC_ENABLED: settings?.[settingKey("TRILIUM_SYNC_ENABLED")] ?? null,
    }),
    [settings],
  );

  const stored = useMemo<Drafts>(
    () => ({
      TRILIUM_BASE_URL: raw.TRILIUM_BASE_URL ?? "",
      TRILIUM_ETAPI_TOKEN: raw.TRILIUM_ETAPI_TOKEN ?? "",
      TRILIUM_ROOT_NOTE_ID: raw.TRILIUM_ROOT_NOTE_ID ?? "",
      TRILIUM_SYNC_ENABLED: raw.TRILIUM_SYNC_ENABLED ?? "true",
    }),
    [raw],
  );

  useEffect(() => {
    if (!loading) setDrafts(stored);
  }, [loading, stored]);

  async function save() {
    setBusy("save");
    setError(null);
    setNotice(null);
    setStatus(null);
    try {
      if (!drafts.TRILIUM_BASE_URL.trim() || !drafts.TRILIUM_ETAPI_TOKEN.trim()) {
        setError("Base URL and ETAPI token are required.");
        return;
      }
      await Promise.all(
        (Object.entries(drafts) as Array<[TriliumEnvKey, string]>).map(([envKey, value]) => {
          const trimmed = trimmedOrNull(value);
          return trimmed === null
            ? clearSetting({ key: settingKey(envKey) })
            : setSetting({ key: settingKey(envKey), value: trimmed });
        }),
      );
      setNotice("Trilium settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    setBusy("clear");
    setError(null);
    setNotice(null);
    setStatus(null);
    try {
      await Promise.all(
        TRILIUM_SETTING_KEYS.map((envKey) => clearSetting({ key: settingKey(envKey) })),
      );
      setDrafts({
        TRILIUM_BASE_URL: "",
        TRILIUM_ETAPI_TOKEN: "",
        TRILIUM_ROOT_NOTE_ID: "",
        TRILIUM_SYNC_ENABLED: "true",
      });
      setNotice("Trilium overrides cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("test");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/catalog/trilium/status");
      if (!response.ok) throw new Error(await parseError(response));
      setStatus((await response.json()) as Status);
    } catch (err) {
      setStatus({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  const configured = Boolean(stored.TRILIUM_BASE_URL && stored.TRILIUM_ETAPI_TOKEN);
  const hasOverride = Object.values(raw).some((value) => Boolean(value));
  const dirty = JSON.stringify(drafts) !== JSON.stringify(stored);

  const cardBg = isDark ? "bg-slate-900/40 border-slate-800/60" : "bg-white border-slate-200";
  const rowBg = isDark ? "bg-slate-900 border-slate-800/70" : "bg-slate-50 border-slate-200";
  const inputBg = isDark
    ? "bg-slate-950 border-slate-700 text-slate-200 placeholder:text-slate-600"
    : "bg-white border-slate-300 text-slate-800 placeholder:text-slate-400";
  const muted = isDark ? "text-slate-400" : "text-slate-600";
  const faint = isDark ? "text-slate-500" : "text-slate-400";
  const primaryBtn = "bg-sky-600 hover:bg-sky-500 text-white";
  const subtleBtn = isDark
    ? "text-slate-300 hover:text-slate-100 hover:bg-slate-800"
    : "text-slate-600 hover:text-slate-800 hover:bg-slate-100";

  return (
    <div className={`border rounded-xl p-4 fade-in ${cardBg}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-sm font-medium ${isDark ? "text-slate-200" : "text-slate-800"}`}>
            Trilium notes
          </div>
          <div className={`text-xs mt-1 ${muted}`}>
            Configure ETAPI sync for catalog items and generated notes.
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] ${
            configured
              ? isDark
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-emerald-50 text-emerald-700"
              : isDark
                ? "bg-amber-500/15 text-amber-300"
                : "bg-amber-50 text-amber-700"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${configured ? "bg-emerald-400" : "bg-amber-400"}`} />
          {configured ? "Configured" : "Missing credentials"}
        </span>
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
      {status && (
        <div
          className={`mt-3 text-xs rounded-md border px-2.5 py-2 ${
            status.ok
              ? isDark
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
              : isDark
                ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                : "border-amber-200 bg-amber-50 text-amber-700"
          }`}
        >
          {status.ok ? "Trilium connection is healthy." : status.error ?? "Trilium connection failed."}
        </div>
      )}

      <div className={`mt-4 border rounded-lg p-3 ${rowBg}`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {TRILIUM_FIELDS.map((field) => (
            <label key={field.envKey} className="flex flex-col gap-1">
              <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                {field.label}
                <span className={`ml-1 ${faint}`}>{field.required ? "(required)" : "(optional)"}</span>
              </span>
              <input
                type={field.sensitive ? "password" : "text"}
                value={drafts[field.envKey]}
                onChange={(event) =>
                  setDrafts((prev) => ({ ...prev, [field.envKey]: event.target.value }))
                }
                placeholder={field.placeholder}
                disabled={loading || busy !== null}
                className={`text-xs px-2.5 py-2 border rounded-md mono ${inputBg}`}
              />
              <span className={`text-[10px] ${faint}`}>{field.description}</span>
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
              Sync enabled
            </span>
            <select
              value={drafts.TRILIUM_SYNC_ENABLED}
              onChange={(event) =>
                setDrafts((prev) => ({ ...prev, TRILIUM_SYNC_ENABLED: event.target.value }))
              }
              disabled={loading || busy !== null}
              className={`text-xs px-2.5 py-2 border rounded-md mono ${inputBg}`}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
            <span className={`text-[10px] ${faint}`}>Set false to keep credentials but block sync.</span>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={loading || busy !== null || !dirty}
            className={`text-xs px-3 py-1.5 rounded-md disabled:opacity-50 ${primaryBtn}`}
          >
            {busy === "save" ? "Saving..." : "Save Trilium"}
          </button>
          <button
            onClick={() => void testConnection()}
            disabled={loading || busy !== null || dirty || !configured}
            className={`text-xs px-2.5 py-1.5 rounded-md disabled:opacity-50 ${subtleBtn}`}
          >
            {busy === "test" ? "Testing..." : "Test connection"}
          </button>
          <button
            onClick={() => void clear()}
            disabled={loading || busy !== null || !hasOverride}
            className={`text-xs px-2.5 py-1.5 rounded-md disabled:opacity-50 ${subtleBtn}`}
          >
            {busy === "clear" ? "Clearing..." : "Clear overrides"}
          </button>
        </div>
        <div className={`mt-2 text-[10px] mono ${faint}`}>
          settings: env_override.TRILIUM_BASE_URL · env_override.TRILIUM_ETAPI_TOKEN
        </div>
      </div>
    </div>
  );
}
