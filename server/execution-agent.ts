import { query } from "./agent-sdk.js";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import {
  buildMcpServersForIntegrations,
  listIntegrations,
  refreshIntegrations,
} from "./integrations/registry.js";
import { createDraftStagingMcp } from "./draft-tools.js";
import { createNotesMcp } from "./notes-tools.js";
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from "./usage.js";
import { getRuntimeModel, getRuntimeReasoningLevel } from "./runtime-config.js";

const running = new Map<string, AbortController>();

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// Composio surfaces the targeted account in a few different shapes depending on
// the tool. Pull whichever one is present so multi-account runs (e.g. 3 Gmail
// inboxes) make the chosen account visible per call.
function extractAccounts(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const accounts = new Set<string>();
  const collect = (v: unknown) => {
    if (typeof v === "string" && v.trim()) accounts.add(v.trim());
  };
  const obj = input as Record<string, unknown>;
  // Direct fields on the top-level call (single-execute, native Composio tools).
  collect(obj.account);
  collect(obj.connectedAccountId);
  collect(obj.connected_account_id);
  if (Array.isArray(obj.accounts)) obj.accounts.forEach(collect);
  // COMPOSIO_MULTI_EXECUTE_TOOL fans out: { tools: [{ account, ... }] }.
  if (Array.isArray(obj.tools)) {
    for (const t of obj.tools) {
      if (t && typeof t === "object") {
        const tt = t as Record<string, unknown>;
        collect(tt.account);
        collect(tt.connectedAccountId);
        collect(tt.connected_account_id);
      }
    }
  }
  return [...accounts];
}

const EXECUTION_SYSTEM_BASE = `You are a focused background worker for the user.

Your job:
1. Perform the task you were given, end to end.
2. Use your tools — WebSearch, WebFetch, and any integrations loaded for this spawn — to investigate and act.
3. Return a concise, well-structured answer — not a data dump.

Catalog:
- You have a boop-notes tool for cataloged notes/media. Use it when the task asks to save, catalog, organize, retrieve, retry processing, configure modality models, or sync an item to Trilium Notes.

Research discipline:
- Prefer WebSearch for fresh/factual questions. WebFetch when you need the content of a known URL.
- Cite real URLs only — NEVER invent sources. If a page failed to load, say so.
- Cross-check when it matters: one search is rarely enough for a claim.

MANDATORY: for any task that used WebSearch or WebFetch, end your response with
a "Sources:" section listing the ACTUAL URLs you fetched or found. Example:

  Sources:
  - https://www.lonelyplanet.com/japan/tokyo
  - https://www.japan-guide.com/e/e3008.html

No URLs = no sources section. Never write vague names like "Lonely Planet" or
"official guide" without the specific URL. The interaction agent relays your
output to the user verbatim, so if you don't include URLs, the user won't see
any.

Style:
- Optimize for iMessage delivery: short sentences, bullets over paragraphs, no tables.
- Prefer markdown with **bold** keywords and • bullets.
- Under 500 words unless explicitly asked for more.
- If you can't complete something, say why in one sentence.
`;

const EXECUTION_SYSTEM_DRAFT_ONLY = `${EXECUTION_SYSTEM_BASE}
Safety:
- Anything that sends a message, creates an event, or takes an external action: call save_draft with a JSON payload instead of the real send/create tool. Return the summary so the interaction agent can show it to the user.
- Only the interaction agent's send_draft tool commits. You never commit.`;

const EXECUTION_SYSTEM_DIRECT_ACTIONS = `${EXECUTION_SYSTEM_BASE}
Authorization:
- The parent agent has explicitly authorized this run to perform external actions directly.
- Do NOT save a draft. Execute the required send/create/update/delete actions using integration tools now.
- After action calls, clearly state what you executed and include IDs/links returned by tools when available.`;

export interface SpawnOptions {
  task: string;
  integrations: string[];
  conversationId?: string;
  name?: string;
  allowDirectActions?: boolean;
}

export interface SpawnResult {
  agentId: string;
  result: string;
  status: "completed" | "failed" | "cancelled";
}

function normalizeIntegrationName(input: string, available: string[]): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const lower = trimmed.toLowerCase();
  const byExact = available.find((name) => name === lower);
  if (byExact) return byExact;

  const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = squash(trimmed);
  const bySquashed = available.find((name) => squash(name) === target);
  if (bySquashed) return bySquashed;

  return lower;
}

function inferIntegrationsFromTask(task: string, available: string[]): string[] {
  const lower = task.toLowerCase();
  const out = new Set<string>();
  const maybeAdd = (name: string, hints: string[]) => {
    if (!available.includes(name)) return;
    if (hints.some((hint) => lower.includes(hint))) out.add(name);
  };

  maybeAdd("gmail", ["gmail", "inbox", "email"]);
  maybeAdd("googlecalendar", ["google calendar", "calendar", "meeting", "schedule"]);
  maybeAdd("googledrive", ["google drive", "drive file", "drive folder"]);
  maybeAdd("googledocs", ["google doc", "docs"]);
  maybeAdd("googlesheets", ["google sheet", "spreadsheet", "sheets"]);
  maybeAdd("slack", ["slack", "channel", "workspace"]);
  maybeAdd("github", ["github", "pull request", "issue", "repo"]);
  maybeAdd("notion", ["notion", "page", "database"]);

  return [...out];
}

export async function spawnExecutionAgent(opts: SpawnOptions): Promise<SpawnResult> {
  const agentId = randomId("agent");
  const name = opts.name ?? (opts.integrations.join("+") || "general");
  const allowDirectActions = opts.allowDirectActions === true;
  const abort = new AbortController();
  running.set(agentId, abort);

  const shortId = agentId.slice(-6);
  const logAgent = (msg: string) => console.log(`[agent ${shortId}] ${msg}`);
  const taskPreview =
    opts.task.length > 120 ? opts.task.slice(0, 120) + "…" : opts.task;
  logAgent(
    `spawn: ${name} [${opts.integrations.join(", ") || "no integrations"}] (${allowDirectActions ? "direct-actions" : "draft-only"}) — ${JSON.stringify(taskPreview)}`,
  );
  const agentStart = Date.now();

  await convex.mutation(api.agents.create, {
    agentId,
    conversationId: opts.conversationId,
    name,
    task: opts.task,
    mcpServers: opts.integrations,
  });
  broadcast("agent_spawned", { agentId, name, task: opts.task });

  await convex.mutation(api.agents.update, { agentId, status: "running" });

  let known = listIntegrations().map((i) => i.name);
  if (known.length === 0) {
    try {
      await refreshIntegrations();
      known = listIntegrations().map((i) => i.name);
    } catch (err) {
      console.error("[integrations] initial refresh before spawn failed", err);
    }
  }
  let requestedIntegrations = opts.integrations.map((name) =>
    normalizeIntegrationName(name, known),
  );
  if (requestedIntegrations.length === 0) {
    const inferred = inferIntegrationsFromTask(opts.task, known);
    if (inferred.length > 0) {
      requestedIntegrations = inferred;
      logAgent(`inferred integrations from task: ${inferred.join(", ")}`);
    }
  }
  const missing = requestedIntegrations.filter((name) => !known.includes(name));
  if (missing.length > 0) {
    logAgent(
      `refreshing integrations before run (missing: ${missing.join(", ")})`,
    );
    try {
      await refreshIntegrations();
      known = listIntegrations().map((i) => i.name);
      requestedIntegrations = opts.integrations.map((name) =>
        normalizeIntegrationName(name, known),
      );
    } catch (err) {
      console.error("[integrations] refresh before spawn failed", err);
    }
  }

  const integrationServers = await buildMcpServersForIntegrations(
    requestedIntegrations,
    opts.conversationId,
  );
  const draftServer = !allowDirectActions && opts.conversationId
    ? createDraftStagingMcp(opts.conversationId)
    : undefined;
  const notesServer = createNotesMcp(opts.conversationId);
  const mcpServers = {
    ...integrationServers,
    ...(draftServer ? { "boop-drafts": draftServer } : {}),
    "boop-notes": notesServer,
  };
  const allowedTools = [
    "WebSearch",
    "WebFetch",
    "Skill",
    ...Object.keys(mcpServers).flatMap((n) => [`mcp__${n}__*`]),
  ];

  let buffer = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  let status: "completed" | "failed" | "cancelled" = "completed";
  let errorMsg: string | undefined;

  const requestedModel = await getRuntimeModel();
  const requestedReasoning = await getRuntimeReasoningLevel();
  try {
    for await (const msg of query({
      prompt: opts.task,
      options: {
        systemPrompt: allowDirectActions
          ? EXECUTION_SYSTEM_DIRECT_ACTIONS
          : EXECUTION_SYSTEM_DRAFT_ONLY,
        model: requestedModel,
        reasoning: requestedReasoning,
        mcpServers,
        allowedTools,
        // Skill loading is enabled via the "Skill" tool in allowedTools.
        settingSources: ["project"],
        permissionMode: "bypassPermissions",
        abortController: abort,
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text") {
            buffer += block.text;
            await convex.mutation(api.agents.addLog, {
              agentId,
              logType: "text",
              content: block.text,
            });
          } else if (block.type === "tool_use") {
            const toolShort = block.name.replace(/^mcp__[a-z-]+__/, "");
            const accounts = extractAccounts(block.input);
            const acctSuffix = accounts.length ? ` [${accounts.join(", ")}]` : "";
            logAgent(`tool: ${toolShort}${acctSuffix}`);
            await convex.mutation(api.agents.addLog, {
              agentId,
              logType: "tool_use",
              toolName: block.name,
              ...(accounts.length ? { accounts } : {}),
              content: JSON.stringify(block.input).slice(0, 2000),
            });
            broadcast("agent_tool", { agentId, toolName: block.name, accounts });
          }
        }
      } else if (msg.type === "user") {
        for (const block of msg.message.content) {
          if (typeof block === "string" || block.type !== "tool_result") continue;
          const text = Array.isArray(block.content)
            ? block.content
                .map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : ""))
                .join("")
            : String(block.content ?? "");
          await convex.mutation(api.agents.addLog, {
            agentId,
            logType: "tool_result",
            content: text.slice(0, 2000),
          });
        }
      } else if (msg.type === "result") {
        // Always take the aggregate from modelUsage — msg.usage is just the
        // final turn's raw tokens and massively undercounts on tool-heavy runs.
        usage = aggregateUsageFromResult(msg, requestedModel);
      }
    }
  } catch (err) {
    status = abort.signal.aborted ? "cancelled" : "failed";
    errorMsg = String(err);
    await convex.mutation(api.agents.addLog, {
      agentId,
      logType: "error",
      content: errorMsg,
    });
  } finally {
    running.delete(agentId);
  }

  const elapsed = ((Date.now() - agentStart) / 1000).toFixed(1);
  logAgent(
    `done (${status}, ${elapsed}s, in/out tokens ${usage.inputTokens}/${usage.outputTokens}, cache r/w ${usage.cacheReadTokens}/${usage.cacheCreationTokens}, $${usage.costUsd.toFixed(4)})`,
  );

  await convex.mutation(api.agents.update, {
    agentId,
    status,
    result: buffer,
    error: errorMsg,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
  });
  // Also append to the usage log so total-cost queries cover every layer.
  if (usage.costUsd > 0 || usage.inputTokens > 0) {
    await convex.mutation(api.usageRecords.record, {
      source: "execution",
      conversationId: opts.conversationId,
      agentId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd,
      durationMs: Date.now() - agentStart,
    });
  }
  broadcast("agent_done", { agentId, status, result: buffer.slice(0, 200) });

  return { agentId, result: buffer || errorMsg || "(no output)", status };
}

export function cancelAgent(agentId: string): boolean {
  const abort = running.get(agentId);
  if (!abort) return false;
  abort.abort();
  return true;
}

export function runningAgentIds(): string[] {
  return [...running.keys()];
}

export async function retryAgent(agentId: string): Promise<SpawnResult | null> {
  const existing = await convex.query(api.agents.get, { agentId });
  if (!existing) return null;
  const allowDirectActions =
    existing.name.startsWith("send:") || existing.task.startsWith("Execute this approved draft.");
  return await spawnExecutionAgent({
    task: existing.task,
    integrations: existing.mcpServers,
    conversationId: existing.conversationId,
    name: existing.name,
    allowDirectActions,
  });
}

export function availableIntegrations(): string[] {
  return listIntegrations().map((i) => i.name);
}

export async function ensureIntegrationsReady(): Promise<string[]> {
  let names = listIntegrations().map((i) => i.name);
  if (names.length > 0) return names;
  try {
    await refreshIntegrations();
  } catch (err) {
    console.error("[integrations] ensureIntegrationsReady refresh failed", err);
  }
  names = listIntegrations().map((i) => i.name);
  return names;
}
