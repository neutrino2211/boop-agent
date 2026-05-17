import express from "express";
import {
  getProviderConfigSnapshot,
  isProviderEnvKey,
  updateProviderEnvOverrides,
  type ProviderEnvKey,
} from "./provider-config.js";
import {
  clearRuntimeModel,
  clearRuntimeReasoningLevel,
  resolveModelInput,
  resolveReasoningInput,
  setRuntimeModel,
  setRuntimeReasoningLevel,
} from "./runtime-config.js";

function normalizeOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function createProviderConfigRouter(): express.Router {
  const router = express.Router();

  router.get("/", async (_req, res) => {
    const snapshot = await getProviderConfigSnapshot();
    res.json(snapshot);
  });

  router.post("/", async (req, res) => {
    try {
      const body = req.body ?? {};

      if (Object.prototype.hasOwnProperty.call(body, "model")) {
        const modelInput = normalizeOptionalString(body.model);
        if (modelInput === undefined) {
          res.status(400).json({ error: "model must be a string or null" });
          return;
        }
        if (modelInput === null) {
          await clearRuntimeModel();
        } else {
          const resolved = resolveModelInput(modelInput);
          if (!resolved) {
            res.status(400).json({ error: `unknown model: ${modelInput}` });
            return;
          }
          await setRuntimeModel(resolved);
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, "reasoning")) {
        const reasoningInput = normalizeOptionalString(body.reasoning);
        if (reasoningInput === undefined) {
          res.status(400).json({ error: "reasoning must be a string or null" });
          return;
        }
        if (reasoningInput === null) {
          await clearRuntimeReasoningLevel();
        } else {
          const resolved = resolveReasoningInput(reasoningInput);
          if (!resolved) {
            res.status(400).json({
              error:
                `unknown reasoning level: ${reasoningInput}. ` +
                `Use one of off, minimal, low, medium, high, xhigh.`,
            });
            return;
          }
          await setRuntimeReasoningLevel(resolved);
        }
      }

      const updates: Partial<Record<ProviderEnvKey, string | null>> = {};
      const rawOverrides = body.envOverrides;
      if (
        rawOverrides &&
        typeof rawOverrides === "object" &&
        !Array.isArray(rawOverrides)
      ) {
        for (const [rawKey, rawValue] of Object.entries(rawOverrides)) {
          if (!isProviderEnvKey(rawKey)) continue;
          const value = normalizeOptionalString(rawValue);
          if (value !== undefined) {
            updates[rawKey] = value;
          }
        }
      }
      await updateProviderEnvOverrides(updates);

      const snapshot = await getProviderConfigSnapshot();
      res.json(snapshot);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
