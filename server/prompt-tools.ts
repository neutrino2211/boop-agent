import { tool, createSdkMcpServer } from "./agent-sdk.js";
import { z } from "zod";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { availableIntegrations } from "./execution-agent.js";
import { describeUserNow } from "./timezone-config.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createPromptMcp(conversationId: string) {
  const integrationHint = availableIntegrations().join(", ") || "(none configured)";

  return createSdkMcpServer({
    name: "boop-prompts",
    version: "0.1.0",
    tools: [
      tool(
        "schedule_prompt",
        `Schedule a one-shot task to run later. The agent will run the prompt at the scheduled time and optionally reply with the result.

Use this for "remind me to X in Y minutes/hours", "ping me later about Z", "check on this later", or anything that should fire once at a future time.

Integrations available: ${integrationHint}`,
        {
          prompt: z
            .string()
            .describe("What the sub-agent should do when it fires."),
          delayMinutes: z
            .number()
            .positive()
            .describe("How many minutes from now to run."),
          integrations: z
            .array(z.string())
            .optional()
            .default([])
            .describe(
              "Integration names the sub-agent needs. Pass [] for simple reminders that don't need external tools.",
            ),
          notify: z
            .boolean()
            .optional()
            .default(true)
            .describe("If true, send the result to this conversation when it runs."),
        },
        async (args) => {
          const tzInfo = await describeUserNow();
          const runAt = Date.now() + Math.round(args.delayMinutes * 60_000);
          const promptId = randomId("sp");

          await convex.mutation(api.scheduledPrompts.create, {
            promptId,
            prompt: args.prompt,
            integrations: args.integrations,
            conversationId,
            notifyConversationId: args.notify ? conversationId : undefined,
            runAt,
          });

          const runAtStr = new Intl.DateTimeFormat("en-US", {
            timeZone: tzInfo.timezone,
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          }).format(new Date(runAt));

          return {
            content: [
              {
                type: "text" as const,
                text: `Scheduled to run at ${runAtStr} (${tzInfo.timezone}). I'll ping you with the result.`,
              },
            ],
          };
        },
      ),

      tool(
        "list_scheduled_prompts",
        "List pending scheduled prompts for this conversation.",
        {},
        async () => {
          const all = await convex.query(api.scheduledPrompts.listByConversation, {
            conversationId,
            status: "pending",
          });
          if (all.length === 0) {
            return { content: [{ type: "text" as const, text: "No pending scheduled prompts." }] };
          }
          const lines = all.map(
            (p: { promptId: string; runAt: number; prompt: string }) =>
              `• [${p.promptId}] in ${Math.round((p.runAt - Date.now()) / 60_000)}min — ${p.prompt}`,
          );
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        },
      ),

      tool(
        "cancel_scheduled_prompt",
        "Cancel a pending scheduled prompt by ID.",
        { promptId: z.string() },
        async (args) => {
          const id = await convex.mutation(api.scheduledPrompts.remove, {
            promptId: args.promptId,
          });
          return {
            content: [
              {
                type: "text" as const,
                text: id
                  ? `Cancelled scheduled prompt ${args.promptId}.`
                  : `Not found or already running/completed.`,
              },
            ],
          };
        },
      ),
    ],
  });
}
