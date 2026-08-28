import { query } from "./_generated/server";
import { v } from "convex/values";

// Cap per-table scans so a long-lived install doesn't hit Convex's 16,384
// .collect() ceiling and break the dashboard. Metrics reflect the most
// recent N rows per table; `truncated` surfaces when we've hit the cap.
const METRICS_SCAN_LIMIT = 5000;

export const metrics = query({
  args: {
    // Optional server-side time window. When provided the query reads only
    // rows whose time field falls in the window via an index range scan,
    // dramatically reducing bytes read for 7d/30d views vs always scanning
    // the last 5k rows and filtering client-side. Undefined => all time
    // (back-compat).
    days: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? METRICS_SCAN_LIMIT, METRICS_SCAN_LIMIT);
    const cutoffTs =
      args.days != null && args.days > 0 ? Date.now() - args.days * 86_400_000 : null;

    // Indexed fetches: each table uses a time or lifecycle index so Convex
    // can do a range scan instead of a full table scan + JS filter.
    // `Promise.all` keeps the four scans concurrent as before.
    const [messages, memories, agents, automationRuns] = await Promise.all([
      // Messages & memories are global counters (not time-windowed in the UI)
      // so they always scan the most recent `limit` rows regardless of `days`.
      // Agents / automationRuns are windowed when `days` is supplied.
      ctx.db.query("messages").withIndex("by_created_at").order("desc").take(limit),

      // Previous version scanned *all* memories (active+archived+pruned) then
      // filtered to `lifecycle === "active"` in JS. Now the index does the
      // filtering server-side. This is the biggest bytes-read win when many
      // memories have been pruned/archived and when embeddings (1024 dims) are
      // stored — large vector fields are no longer read for rows we would
      // discard anyway. Tier counts derived in a single pass below.
      ctx.db.query("memoryRecords").withIndex("by_lifecycle", (q) => q.eq("lifecycle", "active")).take(limit),

      // Agents: bucketed by `startedAt` but previously ordered by _creationTime.
      // With `by_started_at` we can both (a) order by the field we actually
      // aggregate on and (b) push the cutoff into the index when a window is
      // selected.
      cutoffTs !== null
        ? ctx.db
            .query("executionAgents")
            .withIndex("by_started_at", (q) => q.gte("startedAt", cutoffTs))
            .order("desc")
            .take(limit)
        : ctx.db.query("executionAgents").withIndex("by_started_at").order("desc").take(limit),

      cutoffTs !== null
        ? ctx.db
            .query("automationRuns")
            .withIndex("by_started_at", (q) => q.gte("startedAt", cutoffTs))
            .order("desc")
            .take(limit)
        : ctx.db.query("automationRuns").withIndex("by_started_at").order("desc").take(limit),
    ]);

    const truncated =
      messages.length === limit ||
      memories.length === limit ||
      agents.length === limit ||
      automationRuns.length === limit;

    // --- Single-pass aggregations (replaces 10+ Array.filter/reduce passes) ---
    let memShort = 0;
    let memLong = 0;
    let memPermanent = 0;
    for (const m of memories) {
      if (m.tier === "short") memShort++;
      else if (m.tier === "long") memLong++;
      else if (m.tier === "permanent") memPermanent++;
    }

    let agentsCompleted = 0;
    let agentsFailed = 0;
    let agentsCancelled = 0;
    let agentsRunning = 0;
    let costTotal = 0;
    let inputTotal = 0;
    let outputTotal = 0;

    const buckets = new Map<
      string,
      {
        day: string;
        agentCost: number;
        inputTokens: number;
        outputTokens: number;
        agentsSpawned: number;
        agentsCompleted: number;
        agentsFailed: number;
        agentsCancelled: number;
        automationRuns: number;
      }
    >();

    function keyFor(ts: number) {
      return new Date(ts).toISOString().slice(0, 10);
    }
    function bucketFor(day: string) {
      let b = buckets.get(day);
      if (!b) {
        b = {
          day,
          agentCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          agentsSpawned: 0,
          agentsCompleted: 0,
          agentsFailed: 0,
          agentsCancelled: 0,
          automationRuns: 0,
        };
        buckets.set(day, b);
      }
      return b;
    }

    for (const a of agents) {
      costTotal += a.costUsd ?? 0;
      inputTotal += a.inputTokens ?? 0;
      outputTotal += a.outputTokens ?? 0;
      if (a.status === "completed") agentsCompleted++;
      else if (a.status === "failed") agentsFailed++;
      else if (a.status === "cancelled") agentsCancelled++;
      else if (a.status === "running" || a.status === "spawned") agentsRunning++;

      const b = bucketFor(keyFor(a.startedAt));
      b.agentsSpawned += 1;
      b.agentCost += a.costUsd ?? 0;
      b.inputTokens += a.inputTokens ?? 0;
      b.outputTokens += a.outputTokens ?? 0;
      if (a.status === "completed") b.agentsCompleted += 1;
      else if (a.status === "failed") b.agentsFailed += 1;
      else if (a.status === "cancelled") b.agentsCancelled += 1;
    }
    for (const r of automationRuns) {
      const b = bucketFor(keyFor(r.startedAt));
      b.automationRuns += 1;
    }

    const dailyBuckets = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));

    return {
      messages: messages.length,
      memories: {
        total: memories.length,
        shortTerm: memShort,
        longTerm: memLong,
        permanent: memPermanent,
      },
      agents: {
        total: agents.length,
        completed: agentsCompleted,
        failed: agentsFailed,
        cancelled: agentsCancelled,
        running: agentsRunning,
      },
      cost: { total: costTotal },
      tokens: { input: inputTotal, output: outputTotal },
      dailyBuckets,
      truncated,
      scanLimit: limit,
    };
  },
});
