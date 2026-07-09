import express from "express";

interface OpenRouterKeyData {
  label?: string;
  usage?: number;
  limit?: number;
  limit_remaining?: number;
  include_byok_in_limit?: boolean;
  is_management_key?: boolean;
}

interface OpenRouterCreditData {
  total_credits?: number;
  total_usage?: number;
}

async function fetchOpenRouter<T>(path: string, apiKey: string): Promise<T> {
  const response = await fetch(`https://openrouter.ai/api/v1${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter ${path} failed (${response.status}): ${body.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function createOpenRouterRouter(): express.Router {
  const router = express.Router();

  router.get("/usage", async (_req, res) => {
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      res.json({
        configured: false,
        updatedAt: Date.now(),
        key: null,
        account: null,
      });
      return;
    }

    try {
      const [keyPayload, creditsPayload] = await Promise.all([
        fetchOpenRouter<{ data?: OpenRouterKeyData }>("/key", apiKey),
        fetchOpenRouter<{ data?: OpenRouterCreditData }>("/credits", apiKey),
      ]);
      const key = keyPayload.data ?? {};
      const credits = creditsPayload.data ?? {};
      const totalCredits = numberOrNull(credits.total_credits);
      const totalUsage = numberOrNull(credits.total_usage);
      res.json({
        configured: true,
        updatedAt: Date.now(),
        key: {
          label: key.label ?? "OpenRouter key",
          usage: numberOrNull(key.usage),
          limit: numberOrNull(key.limit),
          limitRemaining: numberOrNull(key.limit_remaining),
          includeByokInLimit: Boolean(key.include_byok_in_limit),
          isManagementKey: Boolean(key.is_management_key),
        },
        account: {
          totalCredits,
          totalUsage,
          balance:
            totalCredits !== null && totalUsage !== null
              ? totalCredits - totalUsage
              : null,
        },
      });
    } catch (err) {
      res.status(502).json({
        configured: true,
        updatedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return router;
}
