import "./env-setup.js";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { addClient } from "./broadcast.js";
import { createSendblueRouter } from "./sendblue.js";
import { handleUserMessage } from "./interaction-agent.js";
import { listIntegrations, loadIntegrations } from "./integrations/registry.js";
import { startCleanupLoop } from "./memory/clean.js";
import { startAutomationLoop } from "./automations.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { startConsolidationLoop } from "./consolidation.js";
import { cancelAgent, retryAgent } from "./execution-agent.js";
import { createComposioRouter } from "./composio-routes.js";
import { ensureProactiveWatcher } from "./proactive-email.js";
import { preloadLocalModel } from "./embeddings.js";
import { createMemoryRouter } from "./memory-routes.js";

function parsePositiveMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const INTEGRATIONS_BOOT_TIMEOUT_MS = parsePositiveMs(
  process.env.BOOP_INTEGRATIONS_BOOT_TIMEOUT_MS,
  12_000,
);
const INTEGRATIONS_RETRY_MS = parsePositiveMs(
  process.env.BOOP_INTEGRATIONS_RETRY_MS,
  60_000,
);
const SHOULD_PRELOAD_LOCAL_EMBEDDINGS =
  process.env.BOOP_PRELOAD_LOCAL_EMBEDDINGS === "true" ||
  (process.env.BOOP_PRELOAD_LOCAL_EMBEDDINGS !== "false" &&
    process.env.NODE_ENV !== "production");

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function main() {
  const stopCleanupLoop = startCleanupLoop();
  const stopAutomationLoop = startAutomationLoop();
  const stopHeartbeatLoop = startHeartbeatLoop();
  const stopConsolidationLoop = startConsolidationLoop();
  const stoppers = [
    stopCleanupLoop,
    stopAutomationLoop,
    stopHeartbeatLoop,
    stopConsolidationLoop,
  ];
  let integrationsReady = false;
  let integrationsLoading = false;
  let integrationsLastError: string | null = null;

  const loadIntegrationsWithRecovery = async (reason: "startup" | "retry") => {
    if (integrationsLoading) return;
    integrationsLoading = true;
    try {
      await withTimeout(
        loadIntegrations(),
        INTEGRATIONS_BOOT_TIMEOUT_MS,
        `[integrations] ${reason}`,
      );
      integrationsReady = true;
      integrationsLastError = null;
    } catch (err) {
      integrationsReady = false;
      integrationsLastError = String(err);
      console.error(`[integrations] ${reason} failed`, err);
    } finally {
      integrationsLoading = false;
    }
  };

  // Startup should not block on third-party integration APIs.
  void loadIntegrationsWithRecovery("startup");
  const integrationRetryTimer = setInterval(() => {
    if (integrationsReady || integrationsLoading) return;
    void loadIntegrationsWithRecovery("retry");
  }, INTEGRATIONS_RETRY_MS);
  integrationRetryTimer.unref?.();

  // No-op when a paid embedding key is set; otherwise downloads/loads the
  // local BGE-large model in the background so the first user-facing
  // recall() doesn't pay the model-load cost. Disabled by default in
  // production because model warmup is heavy on cold starts.
  if (SHOULD_PRELOAD_LOCAL_EMBEDDINGS) {
    preloadLocalModel();
  }

  // If a stable public URL is configured, register the Composio webhook +
  // Gmail trigger now. For ngrok-based dev, scripts/dev.mjs drives the same
  // function once the ngrok URL is known, so we skip when only the local
  // PORT default is available.
  const stableUrl = process.env.PUBLIC_URL;
  if (stableUrl && !stableUrl.includes("localhost")) {
    ensureProactiveWatcher(stableUrl).catch((err) =>
      console.error("[proactive] startup failed", err),
    );
  }

  const app = express();
  app.use(cors());
  // Composio webhook receiver must read raw bytes for HMAC verification, so
  // its body parser is mounted BEFORE the global express.json. Without this
  // ordering the JSON parser consumes the stream first and the raw buffer
  // arrives empty.
  app.use("/composio/webhook", express.raw({ type: "application/json", limit: "2mb" }));
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "boop-agent",
      integrationsReady,
      integrationsLoading,
      integrationsLoaded: listIntegrations().length,
      integrationsLastError,
    });
  });

  app.use("/sendblue", createSendblueRouter());
  app.use("/composio", createComposioRouter());
  app.use("/memory", createMemoryRouter());

  app.post("/agents/:id/cancel", (req, res) => {
    const ok = cancelAgent(req.params.id);
    res.json({ ok });
  });

  app.post("/consolidate", async (_req, res) => {
    try {
      const { runConsolidation } = await import("./consolidation.js");
      // Fire-and-forget so the HTTP request returns immediately.
      runConsolidation("manual").catch((err) =>
        console.error("[consolidation] manual run failed", err),
      );
      res.json({ ok: true, triggered: "manual" });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post("/agents/:id/retry", async (req, res) => {
    const result = await retryAgent(req.params.id);
    if (!result) {
      res.status(404).json({ error: "agent not found" });
      return;
    }
    res.json(result);
  });

  // Chat endpoint for local testing and the debug dashboard
  app.post("/chat", async (req, res) => {
    const { conversationId, content } = req.body ?? {};
    if (!conversationId || !content) {
      res.status(400).json({ error: "conversationId and content required" });
      return;
    }
    try {
      const reply = await handleUserMessage({ conversationId, content });
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    addClient(ws);
    ws.send(JSON.stringify({ event: "hello", data: { ok: true }, at: Date.now() }));
  });

  const port = Number(process.env.PORT ?? 3456);
  server.listen(port, () => {
    console.log(`boop-agent server listening on :${port}`);
    console.log(`  health      GET  http://localhost:${port}/health`);
    console.log(`  chat        POST http://localhost:${port}/chat`);
    console.log(`  sendblue    POST http://localhost:${port}/sendblue/webhook`);
    console.log(`  websocket   WS   ws://localhost:${port}/ws`);
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received; draining connections...`);

    clearInterval(integrationRetryTimer);
    for (const stop of stoppers) {
      try {
        stop();
      } catch {
        // Keep shutdown moving even if one loop teardown throws.
      }
    }

    for (const client of wss.clients) {
      try {
        client.close(1001, "server shutdown");
      } catch {
        // Ignore per-socket close errors during shutdown.
      }
    }
    wss.close();

    const hardStop = setTimeout(() => {
      console.error("[shutdown] force-exiting after timeout");
      process.exit(1);
    }, 10_000);
    hardStop.unref?.();

    server.close((err) => {
      clearTimeout(hardStop);
      if (err) {
        console.error("[shutdown] server close failed", err);
        process.exit(1);
        return;
      }
      console.log("[shutdown] complete");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
