import type { SDKMessage } from "./agent-sdk.js";

export interface UsageTotals {
  /** Name of the model that consumed the most tokens. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export const EMPTY_USAGE: UsageTotals = {
  model: "unknown",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

/**
 * The query() compatibility layer reports aggregate usage in msg.modelUsage.
 * Keep using modelUsage as source-of-truth for tool-heavy runs.
 */
export function aggregateUsageFromResult(
  msg: Extract<SDKMessage, { type: "result" }>,
  requestedModel?: string,
): UsageTotals {
  const modelUsage = (msg as { modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }> }).modelUsage ?? {};

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let fallbackModel = "";
  let fallbackTotal = 0;

  for (const [model, u] of Object.entries(modelUsage)) {
    const inT = u.inputTokens ?? 0;
    const outT = u.outputTokens ?? 0;
    inputTokens += inT;
    outputTokens += outT;
    cacheReadTokens += u.cacheReadInputTokens ?? 0;
    cacheCreationTokens += u.cacheCreationInputTokens ?? 0;
    const total = inT + outT;
    if (total > fallbackTotal) {
      fallbackTotal = total;
      fallbackModel = model;
    }
  }

  // Prefer the requested model if the SDK confirmed usage for it; fall back to
  // the heaviest-usage model only if the caller didn't pass one or the SDK
  // routed entirely around it (rare).
  let reportedModel: string;
  if (requestedModel && matchesAnyKey(requestedModel, Object.keys(modelUsage))) {
    reportedModel = requestedModel;
  } else {
    reportedModel = fallbackModel || requestedModel || "unknown";
  }

  return {
    model: reportedModel,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd: msg.total_cost_usd ?? 0,
  };
}

function matchesAnyKey(requested: string, keys: string[]): boolean {
  if (keys.includes(requested)) return true;
  // Providers may normalize model ids (for example adding date stamps). Prefix
  // match covers both directions.
  return keys.some(
    (k) => k === requested || k.startsWith(requested) || requested.startsWith(k),
  );
}
