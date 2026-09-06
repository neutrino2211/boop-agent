import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { spawnExecutionAgent } from "./execution-agent.js";
import { sendImessage } from "./sendblue.js";
import { broadcast } from "./broadcast.js";

async function runScheduledPrompt(p: {
  promptId: string;
  prompt: string;
  integrations: string[];
  conversationId?: string;
  notifyConversationId?: string;
}): Promise<void> {
  await convex.mutation(api.scheduledPrompts.markRunning, {
    promptId: p.promptId,
  });
  broadcast("scheduled_prompt_started", { promptId: p.promptId });

  try {
    const res = await spawnExecutionAgent({
      task: `SCHEDULED PROMPT: ${p.prompt}`,
      integrations: p.integrations,
      conversationId: p.conversationId,
      name: `scheduled:${p.promptId}`,
    });

    await convex.mutation(api.scheduledPrompts.markDone, {
      promptId: p.promptId,
      result: res.result,
      agentId: res.agentId,
    });

    if (p.notifyConversationId && res.result) {
      if (p.notifyConversationId.startsWith("sms:")) {
        const number = p.notifyConversationId.slice(4);
        await sendImessage(number, res.result);
      }
      await convex.mutation(api.messages.send, {
        conversationId: p.notifyConversationId,
        role: "assistant",
        content: res.result,
      });
    }

    broadcast("scheduled_prompt_completed", { promptId: p.promptId });
  } catch (err) {
    await convex.mutation(api.scheduledPrompts.markFailed, {
      promptId: p.promptId,
      error: String(err),
    });
    broadcast("scheduled_prompt_failed", {
      promptId: p.promptId,
      error: String(err),
    });
  }
}

export async function tickScheduledPrompts(): Promise<void> {
  const due = await convex.query(api.scheduledPrompts.listDue, {});
  for (const p of due) {
    runScheduledPrompt({
      promptId: p.promptId,
      prompt: p.prompt,
      integrations: p.integrations,
      conversationId: p.conversationId,
      notifyConversationId: p.notifyConversationId,
    }).catch((err) => console.error("[scheduled-prompts] run error", err));
  }
}

export function startScheduledPromptLoop(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    tickScheduledPrompts().catch((err) =>
      console.error("[scheduled-prompts] tick error", err),
    );
  }, intervalMs);
  return () => clearInterval(timer);
}
