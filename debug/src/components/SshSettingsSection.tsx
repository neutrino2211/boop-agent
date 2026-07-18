import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";

const SSH_FIELDS = [
  {
    key: "ssh_host",
    label: "Host",
    placeholder: "192.168.1.100 or server.example.com",
    description: "Remote server hostname or IP address.",
    type: "text" as const,
    sensitive: false,
    required: true,
  },
  {
    key: "ssh_port",
    label: "Port",
    placeholder: "22",
    description: "SSH port. Defaults to 22.",
    type: "text" as const,
    sensitive: false,
    required: false,
  },
  {
    key: "ssh_username",
    label: "Username",
    placeholder: "root",
    description: "SSH login username.",
    type: "text" as const,
    sensitive: false,
    required: true,
  },
  {
    key: "ssh_auth_method",
    label: "Auth method",
    placeholder: "",
    description: "Use key-based auth (recommended) or password.",
    type: "select" as const,
    options: [
      { value: "key", label: "Private key" },
      { value: "password", label: "Password" },
    ],
    sensitive: false,
    required: false,
  },
  {
    key: "ssh_password",
    label: "Password",
    placeholder: "SSH password",
    description: "Used when auth method is set to password.",
    type: "password" as const,
    sensitive: true,
    required: false,
  },
  {
    key: "ssh_private_key",
    label: "Private key",
    placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    description: "Paste the full private key. Used when auth method is set to private key.",
    type: "textarea" as const,
    sensitive: true,
    required: false,
  },
] as const;

type SshKey = (typeof SSH_FIELDS)[number]["key"];
type Drafts = Record<SshKey, string>;

function trimmedOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function SshSettingsSection({ isDark }: { isDark: boolean }) {
  const host = useQuery(api.settings.get, { key: "ssh_host" });
  const port = useQuery(api.settings.get, { key: "ssh_port" });
  const username = useQuery(api.settings.get, { key: "ssh_username" });
  const authMethod = useQuery(api.settings.get, { key: "ssh_auth_method" });
  const password = useQuery(api.settings.get, { key: "ssh_password" });
  const privateKey = useQuery(api.settings.get, { key: "ssh_private_key" });
  const setSetting = useMutation(api.settings.set);
  const clearSetting = useMutation(api.settings.clear);

  const [drafts, setDrafts] = useState<Drafts>({
    ssh_host: "",
    ssh_port: "22",
    ssh_username: "",
    ssh_auth_method: "key",
    ssh_password: "",
    ssh_private_key: "",
  });
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loading =
    host === undefined ||
    port === undefined ||
    username === undefined ||
    authMethod === undefined ||
    password === undefined ||
    privateKey === undefined;

  const raw = useMemo<Record<string, string | null>>(
    () => ({
      ssh_host: host ?? null,
      ssh_port: port ?? null,
      ssh_username: username ?? null,
      ssh_auth_method: authMethod ?? null,
      ssh_password: password ?? null,
      ssh_private_key: privateKey ?? null,
    }),
    [host, port, username, authMethod, password, privateKey],
  );

  const stored = useMemo<Drafts>(
    () => ({
      ssh_host: raw.ssh_host ?? "",
      ssh_port: raw.ssh_port ?? "22",
      ssh_username: raw.ssh_username ?? "",
      ssh_auth_method: raw.ssh_auth_method ?? "key",
      ssh_password: raw.ssh_password ?? "",
      ssh_private_key: raw.ssh_private_key ?? "",
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
    try {
      if (!drafts.ssh_host.trim() || !drafts.ssh_username.trim()) {
        setError("Host and username are required.");
        return;
      }
      await Promise.all(
        (Object.entries(drafts) as Array<[SshKey, string]>).map(([key, value]) => {
          const trimmed = trimmedOrNull(value);
          if (trimmed === null) {
            return clearSetting({ key });
          }
          if (key === "ssh_port" && !value.trim()) {
            return clearSetting({ key });
          }
          return setSetting({ key, value: trimmed });
        }),
      );
      setNotice("SSH settings saved.");
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
    try {
      await Promise.all(
        SSH_FIELDS.map((f) => clearSetting({ key: f.key })),
      );
      setDrafts({
        ssh_host: "",
        ssh_port: "22",
        ssh_username: "",
        ssh_auth_method: "key",
        ssh_password: "",
        ssh_private_key: "",
      });
      setNotice("SSH overrides cleared.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const configured = Boolean(stored.ssh_host && stored.ssh_username);
  const hasOverride = Object.values(raw).some((v) => Boolean(v));
  const dirty = JSON.stringify(drafts) !== JSON.stringify(stored);

  const showPassword = drafts.ssh_auth_method === "password";
  const showKey = drafts.ssh_auth_method === "key";

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
            SSH server access
          </div>
          <div className={`text-xs mt-1 ${muted}`}>
            Configure SSH credentials so the agent can run commands on a remote server.
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
          {configured ? "Configured" : "Not configured"}
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

      <div className={`mt-4 border rounded-lg p-3 ${rowBg}`}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {SSH_FIELDS.map((field) => {
            if (field.type === "select") {
              return (
                <label key={field.key} className="flex flex-col gap-1">
                  <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                    {field.label}
                  </span>
                  <select
                    value={drafts[field.key]}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    disabled={loading || busy !== null}
                    className={`text-xs px-2.5 py-2 border rounded-md mono ${inputBg}`}
                  >
                    {field.options?.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <span className={`text-[10px] ${faint}`}>{field.description}</span>
                </label>
              );
            }
            if (field.key === "ssh_private_key" && !showKey) return null;
            if (field.key === "ssh_password" && !showPassword) return null;
            if (field.type === "textarea") {
              return (
                <label key={field.key} className="flex flex-col gap-1 md:col-span-2">
                  <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                    {field.label}
                    <span className={`ml-1 ${faint}`}>{field.required ? "(required)" : "(optional)"}</span>
                  </span>
                  <textarea
                    rows={4}
                    value={drafts[field.key]}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    disabled={loading || busy !== null}
                    className={`text-xs px-2.5 py-2 border rounded-md mono resize-y font-mono ${inputBg}`}
                  />
                  <span className={`text-[10px] ${faint}`}>{field.description}</span>
                </label>
              );
            }
            if (field.type === "password" || field.type === "text") {
              return (
                <label key={field.key} className="flex flex-col gap-1">
                  <span className={`text-[11px] ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                    {field.label}
                    <span className={`ml-1 ${faint}`}>{field.required ? "(required)" : "(optional)"}</span>
                  </span>
                  <input
                    type={field.sensitive ? "password" : "text"}
                    value={drafts[field.key]}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    placeholder={field.placeholder}
                    disabled={loading || busy !== null}
                    className={`text-xs px-2.5 py-2 border rounded-md mono ${inputBg}`}
                  />
                  <span className={`text-[10px] ${faint}`}>{field.description}</span>
                </label>
              );
            }
            return null;
          })}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={loading || busy !== null || !dirty}
            className={`text-xs px-3 py-1.5 rounded-md disabled:opacity-50 ${primaryBtn}`}
          >
            {busy === "save" ? "Saving..." : "Save SSH"}
          </button>
          <button
            onClick={() => void clear()}
            disabled={loading || busy !== null || !hasOverride}
            className={`text-xs px-2.5 py-1.5 rounded-md disabled:opacity-50 ${subtleBtn}`}
          >
            {busy === "clear" ? "Clearing..." : "Clear credentials"}
          </button>
        </div>
        <div className={`mt-2 text-[10px] mono ${faint}`}>
          Agent tool: ssh_exec — use via spawn_agent
        </div>
      </div>
    </div>
  );
}
