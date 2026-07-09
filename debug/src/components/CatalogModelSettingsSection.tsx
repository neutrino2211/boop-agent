import { useCallback, useEffect, useState } from "react";
import type { CatalogModality } from "../lib/catalogTypes.js";

const MODALITIES: Array<{ id: CatalogModality; label: string; hint: string }> = [
  { id: "note", label: "Notes", hint: "Summaries and plain text extraction" },
  { id: "image", label: "Images", hint: "Visual description, OCR, screenshots" },
  { id: "audio", label: "Audio", hint: "Voice notes and transcription" },
  { id: "video", label: "Video", hint: "Clips, screen recordings, frame analysis" },
  { id: "file", label: "Files", hint: "PDFs and unsupported binary files" },
];

type ModelMap = Record<CatalogModality, string>;

async function parseError(response: Response): Promise<string> {
  const json = await response.json().catch(() => null);
  if (json && typeof json.error === "string") return json.error;
  return `Request failed (${response.status})`;
}

export function CatalogModelSettingsSection({ isDark }: { isDark: boolean }) {
  const [models, setModels] = useState<ModelMap | null>(null);
  const [drafts, setDrafts] = useState<Partial<ModelMap>>({});
  const [busy, setBusy] = useState<CatalogModality | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/catalog/models");
      if (!res.ok) throw new Error(await parseError(res));
      const next = (await res.json()) as ModelMap;
      setModels(next);
      setDrafts(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(modality: CatalogModality, value: string) {
    setBusy(modality);
    setError(null);
    try {
      const trimmed = value.trim();
      const res = await fetch("/api/catalog/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modality, model: trimmed || null }),
      });
      if (!res.ok) throw new Error(await parseError(res));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

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
            Catalog modality models
          </div>
          <div className={`text-xs mt-1 ${muted}`}>
            Route notes, images, audio, video, and files through different models when needed.
          </div>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy !== null}
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

      <div className="mt-4 space-y-2">
        {MODALITIES.map((modality) => {
          const value = drafts[modality.id] ?? "";
          const active = models?.[modality.id] ?? "…";
          return (
            <div key={modality.id} className={`border rounded-lg p-3 ${rowBg}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className={`text-xs font-semibold ${isDark ? "text-slate-200" : "text-slate-800"}`}>
                    {modality.label}
                  </div>
                  <div className={`text-[11px] mt-0.5 ${muted}`}>{modality.hint}</div>
                </div>
                <span className={`text-[10px] mono ${faint}`}>active: {active}</span>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="text"
                  value={value}
                  onChange={(event) =>
                    setDrafts((prev) => ({ ...prev, [modality.id]: event.target.value }))
                  }
                  placeholder="Leave blank to use runtime model"
                  className={`text-xs px-2.5 py-2 border rounded-md flex-1 mono ${inputBg}`}
                  disabled={busy !== null || models === null}
                />
                <button
                  onClick={() => void save(modality.id, value)}
                  disabled={busy !== null || models === null}
                  className={`text-xs px-3 py-2 rounded-md disabled:opacity-50 ${primaryBtn}`}
                >
                  {busy === modality.id ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
