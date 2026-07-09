import { useEffect, useMemo, useState, useRef, useCallback, type ReactNode } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api.js";

type TimeRange = "all" | "7d" | "30d" | "90d";

const RANGES: { id: TimeRange; label: string }[] = [
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "90d", label: "90 days" },
  { id: "all", label: "All time" },
];

interface OpenRouterUsage {
  configured: boolean;
  updatedAt: number;
  error?: string;
  key: null | {
    label: string;
    usage: number | null;
    limit: number | null;
    limitRemaining: number | null;
    includeByokInLimit: boolean;
    isManagementKey: boolean;
  };
  account: null | {
    totalCredits: number | null;
    totalUsage: number | null;
    balance: number | null;
  };
}

function cutoffDate(range: TimeRange): string | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function fmtMoney(value: number | null | undefined, digits = 2): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(digits)}`;
}

export function DashboardPanel({ isDark }: { isDark: boolean }) {
  const data = useQuery(api.dashboard.metrics, {});
  const catalogMetrics = useQuery(api.catalog.metrics, {});
  const usageSummary = useQuery(api.usageRecords.summary, { limit: 5000 });
  const [range, setRange] = useState<TimeRange>("all");
  const [openRouterUsage, setOpenRouterUsage] = useState<OpenRouterUsage | null>(null);
  const [openRouterLoading, setOpenRouterLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setOpenRouterLoading(true);
    fetch("/api/openrouter/usage")
      .then(async (res) => {
        const payload = (await res.json()) as OpenRouterUsage;
        if (!res.ok && !payload.error) {
          throw new Error(`OpenRouter usage request failed (${res.status})`);
        }
        return payload;
      })
      .then((payload) => {
        if (!cancelled) setOpenRouterUsage(payload);
      })
      .catch((err) => {
        if (!cancelled) {
          setOpenRouterUsage({
            configured: false,
            updatedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
            key: null,
            account: null,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setOpenRouterLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!data) return null;
    const cutoff = cutoffDate(range);
    const days = cutoff
      ? data.dailyBuckets.filter((d) => d.day >= cutoff)
      : data.dailyBuckets;

    let agentCost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let agentsSpawned = 0;
    let agentsCompleted = 0;
    let agentsFailed = 0;
    let agentsCancelled = 0;
    let automationRuns = 0;

    for (const d of days) {
      agentCost += d.agentCost;
      inputTokens += d.inputTokens;
      outputTokens += d.outputTokens;
      agentsSpawned += d.agentsSpawned;
      agentsCompleted += d.agentsCompleted;
      agentsFailed += d.agentsFailed;
      agentsCancelled += d.agentsCancelled;
      automationRuns += d.automationRuns;
    }

    const totalTokens = inputTokens + outputTokens;
    return {
      days,
      cost: { total: agentCost, agents: agentCost },
      tokens: { input: inputTokens, output: outputTokens, total: totalTokens },
      agents: {
        total: agentsSpawned,
        completed: agentsCompleted,
        failed: agentsFailed,
        cancelled: agentsCancelled,
        failureRate: agentsSpawned > 0 ? agentsFailed / agentsSpawned : 0,
      },
      automationRuns,
    };
  }, [data, range]);

  if (!data || !filtered) {
    return (
      <div
        className={`flex items-center justify-center h-full ${
          isDark ? "text-slate-500" : "text-slate-400"
        }`}
      >
        Loading dashboard…
      </div>
    );
  }

  const c = isDark
    ? {
        card: "bg-slate-900/60 border-slate-800",
        label: "text-slate-500",
        value: "text-slate-100",
        sub: "text-slate-400",
        chart: "bg-slate-900/40 border-slate-800",
      }
    : {
        card: "bg-white border-slate-200",
        label: "text-slate-500",
        value: "text-slate-900",
        sub: "text-slate-600",
        chart: "bg-white border-slate-200",
      };

  const failPct = (filtered.agents.failureRate * 100).toFixed(1);
  const openRouterKeySpend = openRouterUsage?.key?.usage ?? null;
  const openRouterKeyLimit = openRouterUsage?.key?.limit ?? null;
  const openRouterKeyRemaining = openRouterUsage?.key?.limitRemaining ?? null;
  const openRouterAccountUsage = openRouterUsage?.account?.totalUsage ?? null;
  const openRouterAccountBalance = openRouterUsage?.account?.balance ?? null;
  const trackedUsageCost = usageSummary?.totalCost ?? filtered.cost.total;

  return (
    <div className="h-full overflow-y-auto debug-scroll -m-5 p-5 space-y-5">
      <div className="flex items-center justify-between">
        <h2
          className={`text-sm font-bold uppercase tracking-wider ${
            isDark ? "text-slate-400" : "text-slate-500"
          }`}
        >
          Overview
        </h2>
        <div
          className={`flex items-center rounded-lg border text-xs ${
            isDark
              ? "border-slate-700 bg-slate-900/50"
              : "border-slate-200 bg-slate-50"
          }`}
        >
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className={`px-3 py-1.5 transition-colors ${
                range === r.id
                  ? isDark
                    ? "bg-slate-700 text-white font-medium"
                    : "bg-white text-slate-900 font-medium shadow-sm"
                  : isDark
                    ? "text-slate-500 hover:text-slate-300"
                    : "text-slate-500 hover:text-slate-700"
              } ${r.id === "7d" ? "rounded-l-lg" : ""} ${
                r.id === "all" ? "rounded-r-lg" : ""
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatCard label="Messages" value={fmt(data.messages)} c={c} />
        <StatCard
          label="Memories"
          value={fmt(data.memories.total)}
          sub={`${fmt(data.memories.shortTerm)}s / ${fmt(data.memories.longTerm)}l / ${fmt(data.memories.permanent)}p`}
          c={c}
        />
        <StatCard
          label="Catalog"
          value={fmt(catalogMetrics?.total ?? 0)}
          sub={`${fmt(catalogMetrics?.synced ?? 0)} synced`}
          c={c}
        />
        <StatCard
          label="Media"
          value={fmt(catalogMetrics?.media ?? 0)}
          sub={`${fmt(catalogMetrics?.processing ?? 0)} processing / ${fmt(catalogMetrics?.failed ?? 0)} failed`}
          c={c}
        />
        <StatCard
          label="Agents Spawned"
          value={fmt(filtered.agents.total)}
          sub={`${data.agents.running} running`}
          c={c}
        />
        <StatCard
          label="Tracked Cost"
          value={fmtMoney(trackedUsageCost)}
          color={isDark ? "text-emerald-400" : "text-emerald-600"}
          c={c}
          isDark={isDark}
          info={{
            title: "Internal usage log",
            body: (
              <>
                <p className="mb-1.5">
                  This is the app's own usage ledger from Convex usage records.
                </p>
                <p className="mb-1.5">
                  It can include providers outside OpenRouter, so compare it with the OpenRouter cards
                  before treating it as a billing total.
                </p>
                <p>
                  Going forward we should store OpenRouter generation IDs to reconcile exact per-call costs.
                </p>
              </>
            ),
          }}
        />
        <StatCard
          label="OpenRouter Key"
          value={openRouterLoading ? "…" : fmtMoney(openRouterKeySpend)}
          sub={
            openRouterUsage?.error
              ? "usage unavailable"
              : openRouterKeyLimit !== null
                ? `${fmtMoney(openRouterKeyRemaining)} left of ${fmtMoney(openRouterKeyLimit)}`
                : openRouterUsage?.configured === false
                  ? "key not configured"
                  : "current key spend"
          }
          color={isDark ? "text-sky-400" : "text-sky-600"}
          c={c}
          isDark={isDark}
          info={{
            title: "OpenRouter actuals",
            body: (
              <>
                <p className="mb-1.5">
                  This comes from OpenRouter's key endpoint for the active API key.
                </p>
                <p>
                  It is the closest number to actual spend for requests made through this key.
                </p>
              </>
            ),
          }}
        />
        <StatCard
          label="Tokens"
          value={fmtTokens(filtered.tokens.total)}
          sub={`${fmtTokens(filtered.tokens.input)} in / ${fmtTokens(filtered.tokens.output)} out`}
          c={c}
        />
        <StatCard
          label="Failure Rate"
          value={`${failPct}%`}
          sub={`${filtered.agents.failed} of ${filtered.agents.total}`}
          color={
            Number(failPct) > 20
              ? isDark
                ? "text-rose-400"
                : "text-rose-600"
              : undefined
          }
          c={c}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <BillingCard
          title="OpenRouter Account"
          isDark={isDark}
          c={c}
          rows={[
            ["Total used", fmtMoney(openRouterAccountUsage, 3)],
            ["Balance", fmtMoney(openRouterAccountBalance, 3)],
            ["Credits", fmtMoney(openRouterUsage?.account?.totalCredits, 2)],
          ]}
          note={
            openRouterUsage?.error
              ? openRouterUsage.error
              : openRouterUsage?.configured === false
                ? "OPENROUTER_API_KEY is not configured on this server."
                : "Account-level credits can include usage from other keys."
          }
        />
        <BillingCard
          title="Internal Ledger"
          isDark={isDark}
          c={c}
          rows={[
            ["Tracked cost", fmtMoney(usageSummary?.totalCost, 3)],
            ["Usage rows", usageSummary ? fmt(usageSummary.rowCount) : "—"],
            ["Model calls", usageSummary ? fmt(Object.values(usageSummary.bySource).reduce((sum, source) => sum + source.count, 0)) : "—"],
          ]}
          note="Convex usageRecords include dispatcher, execution, extraction, and consolidation calls."
        />
        <BillingCard
          title="Reconciliation"
          isDark={isDark}
          c={c}
          rows={[
            ["Key actual", fmtMoney(openRouterKeySpend, 3)],
            ["Tracked minus key", fmtMoney(typeof openRouterKeySpend === "number" ? trackedUsageCost - openRouterKeySpend : null, 3)],
            ["Key used", openRouterKeyLimit ? `${Math.min(100, ((openRouterKeySpend ?? 0) / openRouterKeyLimit) * 100).toFixed(1)}%` : "—"],
          ]}
          note="The difference includes non-OpenRouter providers and estimated rows without generation IDs."
        />
      </div>

      {filtered.days.length > 1 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className={`rounded-xl border p-4 ${c.chart}`}>
            <h3
              className={`text-xs font-semibold uppercase tracking-wider mb-3 ${c.label}`}
            >
              Cost Over Time
            </h3>
            <StackedAreaChart
              data={filtered.days}
              keys={["agentCost"]}
              colors={isDark ? ["#38bdf8"] : ["#0284c7"]}
              labels={["Agents"]}
              format={(v) => `$${v.toFixed(2)}`}
              isDark={isDark}
            />
          </div>
          <div className={`rounded-xl border p-4 ${c.chart}`}>
            <h3
              className={`text-xs font-semibold uppercase tracking-wider mb-3 ${c.label}`}
            >
              Token Usage Over Time
            </h3>
            <StackedAreaChart
              data={filtered.days}
              keys={["inputTokens", "outputTokens"]}
              colors={isDark ? ["#38bdf8", "#34d399"] : ["#0284c7", "#059669"]}
              labels={["Input", "Output"]}
              format={fmtTokens}
              isDark={isDark}
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className={`rounded-xl border p-4 ${c.chart}`}>
          <h3
            className={`text-xs font-semibold uppercase tracking-wider mb-3 ${c.label}`}
          >
            Agent Status
          </h3>
          <div className="space-y-2">
            {(
              [
                ["completed", filtered.agents.completed, isDark ? "bg-emerald-500" : "bg-emerald-600"],
                ["failed", filtered.agents.failed, isDark ? "bg-rose-500" : "bg-rose-600"],
                ["cancelled", filtered.agents.cancelled, isDark ? "bg-slate-500" : "bg-slate-400"],
              ] as const
            ).map(([label, count, color]) =>
              count > 0 ? (
                <BarRow
                  key={label}
                  label={label}
                  value={count}
                  total={filtered.agents.total}
                  color={color}
                  isDark={isDark}
                  format={String}
                />
              ) : null,
            )}
            {filtered.agents.total === 0 && (
              <p className={`text-xs ${isDark ? "text-slate-600" : "text-slate-400"}`}>
                No agents run yet in this range.
              </p>
            )}
          </div>
        </div>

        <div className={`rounded-xl border p-4 ${c.chart}`}>
          <h3
            className={`text-xs font-semibold uppercase tracking-wider mb-3 ${c.label}`}
          >
            Token Breakdown
          </h3>
          <div className="space-y-2">
            <BarRow
              label="Input"
              value={filtered.tokens.input}
              total={filtered.tokens.total}
              color={isDark ? "bg-sky-500" : "bg-sky-600"}
              isDark={isDark}
              format={fmtTokens}
            />
            <BarRow
              label="Output"
              value={filtered.tokens.output}
              total={filtered.tokens.total}
              color={isDark ? "bg-emerald-500" : "bg-emerald-600"}
              isDark={isDark}
              format={fmtTokens}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
  info,
  c,
  isDark,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  info?: { title: string; body: ReactNode };
  c: { card: string; label: string; value: string; sub: string };
  isDark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click — keeps the popover from sticking when the user
  // clicks elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div className={`rounded-xl border p-3.5 ${c.card} relative`}>
      <div className={`text-[11px] font-medium uppercase tracking-wider ${c.label} flex items-center gap-1.5`}>
        <span>{label}</span>
        {info && (
          <div className="relative" ref={popRef}>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-label={`What does ${label} mean?`}
              aria-expanded={open}
              className={`w-3.5 h-3.5 inline-flex items-center justify-center rounded-full border text-[9px] font-bold normal-case tracking-normal transition-colors ${
                isDark
                  ? "border-slate-600 text-slate-500 hover:border-sky-400 hover:text-sky-400"
                  : "border-slate-400 text-slate-500 hover:border-sky-500 hover:text-sky-600"
              }`}
            >
              i
            </button>
            {open && (
              <div
                role="dialog"
                aria-label={info.title}
                className={`absolute z-30 left-0 top-full mt-1.5 w-64 rounded-lg border px-3 py-2.5 shadow-lg text-[11px] leading-snug normal-case tracking-normal ${
                  isDark
                    ? "bg-slate-900 border-slate-700 text-slate-200"
                    : "bg-white border-slate-200 text-slate-700"
                }`}
              >
                <div className={`font-semibold mb-1 ${isDark ? "text-slate-100" : "text-slate-900"}`}>
                  {info.title}
                </div>
                <div className="font-normal">{info.body}</div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className={`text-xl font-bold mono mt-1 ${color ?? c.value}`}>
        {value}
      </div>
      {sub && <div className={`text-[11px] mt-0.5 ${c.sub}`}>{sub}</div>}
    </div>
  );
}

function BillingCard({
  title,
  rows,
  note,
  c,
  isDark,
}: {
  title: string;
  rows: Array<[string, string]>;
  note: string;
  c: { chart: string; label: string; value: string; sub: string };
  isDark: boolean;
}) {
  return (
    <section className={`rounded-xl border p-4 ${c.chart}`}>
      <div className={`text-xs font-semibold uppercase tracking-wider ${c.label}`}>
        {title}
      </div>
      <div className="mt-3 space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 text-xs">
            <span className={isDark ? "text-slate-500" : "text-slate-500"}>{label}</span>
            <span className={`mono font-semibold text-right ${c.value}`}>{value}</span>
          </div>
        ))}
      </div>
      <p className={`mt-3 text-[11px] leading-relaxed ${c.sub}`}>{note}</p>
    </section>
  );
}

function BarRow({
  label,
  value,
  total,
  color,
  isDark,
  format,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
  isDark: boolean;
  format?: (v: number) => string;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const display = format ? format(value) : `$${value.toFixed(2)}`;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span
        className={`w-24 truncate capitalize ${
          isDark ? "text-slate-400" : "text-slate-600"
        }`}
      >
        {label}
      </span>
      <div
        className={`flex-1 h-2 rounded-full overflow-hidden ${
          isDark ? "bg-slate-800" : "bg-slate-100"
        }`}
      >
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
      <span
        className={`w-16 text-right mono font-medium ${
          isDark ? "text-slate-300" : "text-slate-700"
        }`}
      >
        {display}
      </span>
    </div>
  );
}

function StackedAreaChart({
  data,
  keys,
  colors,
  labels,
  format,
  isDark,
}: {
  data: Record<string, any>[];
  keys: string[];
  colors: string[];
  labels: string[];
  format: (v: number) => string;
  isDark: boolean;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  if (data.length < 2) return null;

  const W = 800;
  const H = 180;
  const PL = 55;
  const PR = 16;
  const PT = 8;
  const PB = 28;
  const chartW = W - PL - PR;
  const chartH = H - PT - PB;

  const stacked = data.map((d) => {
    let cum = 0;
    const layers: number[] = [];
    const raw: number[] = [];
    for (const k of keys) {
      const v = d[k] ?? 0;
      raw.push(v);
      cum += v;
      layers.push(cum);
    }
    return { day: d.day as string, layers, raw, total: cum };
  });

  const maxVal = Math.max(...stacked.map((d) => d.total), 0.01);
  const x = (i: number) => PL + (i / (data.length - 1)) * chartW;
  const y = (v: number) => PT + chartH - (v / maxVal) * chartH;
  const yTicks = [0, maxVal * 0.5, maxVal];

  const areaPaths: string[] = [];
  for (let k = keys.length - 1; k >= 0; k--) {
    const topPoints = stacked.map((d, i) => `${x(i)},${y(d.layers[k])}`).join(" L");
    const bottomLayer =
      k > 0
        ? stacked
            .map((d, i) => `${x(i)},${y(d.layers[k - 1])}`)
            .reverse()
            .join(" L")
        : stacked
            .map((_, i) => `${x(i)},${y(0)}`)
            .reverse()
            .join(" L");
    areaPaths.push(`M${topPoints} L${bottomLayer} Z`);
  }

  const step = Math.max(1, Math.floor(data.length / 6));
  const xLabels: { i: number; label: string }[] = [];
  for (let i = 0; i < data.length; i += step)
    xLabels.push({ i, label: (data[i].day as string).slice(5) });
  if (xLabels[xLabels.length - 1]?.i !== data.length - 1) {
    xLabels.push({
      i: data.length - 1,
      label: (data[data.length - 1].day as string).slice(5),
    });
  }

  const gridColor = isDark ? "#1e293b" : "#e2e8f0";
  const textColor = isDark ? "#64748b" : "#94a3b8";
  const crosshair = isDark ? "#475569" : "#cbd5e1";

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const mouseX = ((e.clientX - rect.left) / rect.width) * W;
      const chartX = mouseX - PL;
      if (chartX < 0 || chartX > chartW) {
        setHoverIdx(null);
        return;
      }
      const idx = Math.round((chartX / chartW) * (data.length - 1));
      setHoverIdx(Math.max(0, Math.min(data.length - 1, idx)));
    },
    [data.length, chartW],
  );

  const hovered = hoverIdx !== null ? stacked[hoverIdx] : null;
  const tooltipLeft = hoverIdx !== null ? (x(hoverIdx) / W) * 100 : 0;
  const flipTooltip = hoverIdx !== null && tooltipLeft > 65;

  return (
    <div ref={containerRef} className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        preserveAspectRatio="none"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke={gridColor} strokeWidth={1} />
            <text
              x={PL - 6}
              y={y(v) + 3.5}
              textAnchor="end"
              fill={textColor}
              fontSize={10}
              fontFamily="monospace"
            >
              {format(v)}
            </text>
          </g>
        ))}

        {areaPaths.map((path, i) => (
          <path key={i} d={path} fill={colors[i]} opacity={0.35} />
        ))}

        {keys.map((_, k) => {
          const linePoints = stacked
            .map((d, i) => `${x(i)},${y(d.layers[k])}`)
            .join(" L");
          return (
            <path
              key={k}
              d={`M${linePoints}`}
              fill="none"
              stroke={colors[k]}
              strokeWidth={1.5}
            />
          );
        })}

        {xLabels.map(({ i, label }) => (
          <text
            key={i}
            x={x(i)}
            y={H - 4}
            textAnchor="middle"
            fill={textColor}
            fontSize={10}
            fontFamily="monospace"
          >
            {label}
          </text>
        ))}

        {hoverIdx !== null && hovered && (
          <>
            <line
              x1={x(hoverIdx)}
              x2={x(hoverIdx)}
              y1={PT}
              y2={PT + chartH}
              stroke={crosshair}
              strokeWidth={1}
              strokeDasharray="3,3"
            />
            {keys.map((_, k) => (
              <circle
                key={k}
                cx={x(hoverIdx)}
                cy={y(hovered.layers[k])}
                r={3.5}
                fill={colors[k]}
                stroke={isDark ? "#0f172a" : "#ffffff"}
                strokeWidth={1.5}
              />
            ))}
          </>
        )}
      </svg>

      {hoverIdx !== null && hovered && (
        <div
          className={`absolute pointer-events-none rounded-lg border px-3 py-2 shadow-lg text-xs z-10 ${
            isDark
              ? "bg-slate-800 border-slate-700 text-slate-200"
              : "bg-white border-slate-200 text-slate-800"
          }`}
          style={{
            top: 4,
            left: flipTooltip ? undefined : `calc(${tooltipLeft}% + 12px)`,
            right: flipTooltip ? `calc(${100 - tooltipLeft}% + 12px)` : undefined,
          }}
        >
          <div
            className={`font-semibold mb-1.5 ${
              isDark ? "text-slate-300" : "text-slate-700"
            }`}
          >
            {hovered.day}
          </div>
          {keys.map((_, k) => (
            <div key={k} className="flex items-center gap-2 py-0.5">
              <span
                className="w-2 h-2 rounded-sm shrink-0"
                style={{ background: colors[k] }}
              />
              <span className={isDark ? "text-slate-400" : "text-slate-500"}>
                {labels[k]}
              </span>
              <span className="ml-auto mono font-medium pl-3">
                {format(hovered.raw[k])}
              </span>
            </div>
          ))}
          <div
            className={`border-t mt-1.5 pt-1.5 flex justify-between font-semibold ${
              isDark ? "border-slate-700" : "border-slate-200"
            }`}
          >
            <span>Total</span>
            <span className="mono">{format(hovered.total)}</span>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 mt-2 ml-14">
        {labels.map((l, i) => (
          <div key={i} className="flex items-center gap-1.5 text-[11px]">
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{ background: colors[i] }}
            />
            <span className={isDark ? "text-slate-400" : "text-slate-600"}>
              {l}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
