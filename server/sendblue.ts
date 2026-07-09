import express from "express";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { handleUserMessage } from "./interaction-agent.js";
import { broadcast } from "./broadcast.js";
import {
  createCatalogItemWithOptionalAsset,
  uploadToConvexStorage,
} from "./catalog-routes.js";
import { modalityForContentType } from "./catalog-models.js";
import {
  analyzeAttachmentBytes,
  type AttachmentAnalysisResult,
} from "./catalog-processing.js";
import { detectMediaMetadata } from "./media-detection.js";

const API_BASE = "https://api.sendblue.com/api";
const MAX_CHUNK = 2900;
const MAX_MEDIA_BYTES = 75 * 1024 * 1024;
const MAX_ATTACHMENT_CONTEXT_CHARS = 32_000;
const MAX_ATTACHMENT_FIELD_CHARS = 10_000;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?|```/g, ""))
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s+/gm, "")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .trim();
}

function chunk(text: string, size = MAX_CHUNK): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let buf = "";
  for (const line of text.split(/\n/)) {
    if ((buf + "\n" + line).length > size) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function headers(): Record<string, string> | null {
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  if (!apiKey || !apiSecret) return null;
  return {
    "Content-Type": "application/json",
    "sb-api-key-id": apiKey,
    "sb-api-secret-key": apiSecret,
  };
}

function normalizeE164(n: string | undefined): string | undefined {
  if (!n) return undefined;
  const trimmed = n.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("+")) return trimmed;
  // Bare US-length numbers get a +1. Longer/shorter just get a leading +.
  if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
  if (/^\d{11,15}$/.test(trimmed)) return `+${trimmed}`;
  return trimmed;
}

interface InboundMedia {
  url: string;
  filename?: string;
  contentType?: string;
}

interface PreparedInboundMedia {
  url: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  bytes: Buffer;
  analysis?: AttachmentAnalysisResult;
  processingError?: string;
}

function basenameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "imessage-attachment";
  } catch {
    return "imessage-attachment";
  }
}

function contentDispositionFilename(value: string | null): string | undefined {
  if (!value) return undefined;
  const star = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.replace(/^"|"$/g, ""));
    } catch {
      return star.replace(/^"|"$/g, "");
    }
  }
  return value.match(/filename="?([^";]+)"?/i)?.[1]?.trim();
}

function shouldCatalogInbound(content: string): boolean {
  return /\b(?:catalog|save|store|organize|archive|file this|remember this)\b/i.test(content);
}

function attachmentSummary(media: InboundMedia[]): string {
  if (media.length === 0) return "no attachments";
  return media
    .map((item, index) => {
      const name = item.filename ?? basenameFromUrl(item.url);
      const type = item.contentType ?? "unknown";
      return `${index + 1}:${name} (${type})`;
    })
    .join(", ");
}

function truncateForAgent(value: string | undefined, limit = MAX_ATTACHMENT_FIELD_CHARS): string | undefined {
  if (!value) return undefined;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function formatAttachmentContext(attachments: PreparedInboundMedia[]): string {
  if (attachments.length === 0) return "";
  const lines = [
    "Inbound attachments were automatically processed before this turn. Use this context to answer the user; do not claim you cannot see or hear the attachments.",
  ];
  for (const [index, attachment] of attachments.entries()) {
    const mb = (attachment.sizeBytes / 1_000_000).toFixed(2);
    lines.push("");
    lines.push(`Attachment ${index + 1}: ${attachment.filename}`);
    lines.push(`Content type: ${attachment.contentType}; size: ${mb} MB`);
    if (attachment.analysis) {
      const analysis = attachment.analysis;
      lines.push(`Modality: ${analysis.modality}`);
      lines.push(`Processing model: ${analysis.model}`);
      lines.push(`Summary: ${analysis.summary}`);
      if (analysis.extractedText) {
        lines.push("Extracted/visible text:");
        lines.push(truncateForAgent(analysis.extractedText) ?? "");
      }
      if (analysis.transcript) {
        lines.push("Transcript:");
        lines.push(truncateForAgent(analysis.transcript) ?? "");
      }
      if (analysis.tags.length > 0) lines.push(`Tags: ${analysis.tags.join(", ")}`);
    } else {
      lines.push(`Processing failed: ${attachment.processingError ?? "unknown error"}`);
    }
  }
  const text = lines.join("\n");
  if (text.length <= MAX_ATTACHMENT_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_ATTACHMENT_CONTEXT_CHARS)}\n[attachment context truncated]`;
}

async function downloadInboundMedia(media: InboundMedia[]): Promise<PreparedInboundMedia[]> {
  const prepared: PreparedInboundMedia[] = [];
  for (const item of media) {
    try {
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_MEDIA_BYTES) throw new Error(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
      const detected = await detectMediaMetadata({
        bytes,
        filename:
          item.filename ??
          contentDispositionFilename(res.headers.get("content-disposition")) ??
          basenameFromUrl(item.url),
        contentType: item.contentType ?? res.headers.get("content-type"),
      });
      prepared.push({
        url: item.url,
        filename: detected.filename,
        contentType: detected.contentType,
        sizeBytes: bytes.length,
        bytes,
      });
    } catch (err) {
      console.warn("[sendblue] failed to download inbound media", err);
    }
  }
  return prepared;
}

async function analyzeInboundMedia(
  attachments: PreparedInboundMedia[],
  content: string,
  conversationId: string,
  turnTag: string,
): Promise<void> {
  for (const attachment of attachments) {
    try {
      attachment.analysis = await analyzeAttachmentBytes({
        bytes: attachment.bytes,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sourceText: content,
        sourceConversationId: conversationId,
      });
      console.log(
        `[turn ${turnTag}] processed attachment ${attachment.filename} as ${attachment.analysis.modality} with ${attachment.analysis.model}`,
      );
    } catch (err) {
      attachment.processingError = err instanceof Error ? err.message : String(err);
      console.warn(`[turn ${turnTag}] attachment processing failed for ${attachment.filename}`, err);
    }
  }
}

function collectInboundMedia(value: unknown, out: InboundMedia[], seen: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectInboundMedia(entry, out, seen);
    return;
  }
  const obj = value as Record<string, unknown>;
  const url =
    stringField(obj, "media_url") ??
    stringField(obj, "mediaUrl") ??
    stringField(obj, "file_url") ??
    stringField(obj, "fileUrl") ??
    stringField(obj, "attachment_url") ??
    stringField(obj, "attachmentUrl") ??
    stringField(obj, "url");
  if (url && /^https?:\/\//i.test(url) && !seen.has(url)) {
    seen.add(url);
    out.push({
      url,
      filename:
        stringField(obj, "filename") ??
        stringField(obj, "file_name") ??
        stringField(obj, "name") ??
        basenameFromUrl(url),
      contentType:
        stringField(obj, "content_type") ??
        stringField(obj, "contentType") ??
        stringField(obj, "mime") ??
        stringField(obj, "mime_type"),
    });
  }
  for (const key of ["attachments", "media", "files", "images", "videos", "audio"]) {
    if (obj[key]) collectInboundMedia(obj[key], out, seen);
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function catalogInboundMedia(args: {
  media: PreparedInboundMedia[];
  content: string;
  conversationId: string;
  messageHandle?: string;
}): Promise<string[]> {
  const itemIds: string[] = [];
  for (const media of args.media) {
    try {
      const storageId = await uploadToConvexStorage(media.bytes, media.contentType);
      const modality = media.analysis?.modality ?? modalityForContentType(media.contentType, media.filename);
      const item = (await createCatalogItemWithOptionalAsset({
        title: media.filename.replace(/\.[a-z0-9]+$/i, "") || media.filename,
        summary: media.analysis?.summary ?? (args.content || `${media.filename} sent via iMessage.`),
        modality,
        source: "imessage",
        status: media.analysis ? "ready" : "processing",
        tags: media.analysis?.tags ?? ["imessage", modality],
        sourceConversationId: args.conversationId,
        sourceMessageHandle: args.messageHandle,
        extractedText: media.analysis?.extractedText,
        transcript: media.analysis?.transcript,
        processNow: !media.analysis,
        asset: {
          storageId,
          filename: media.filename,
          contentType: media.contentType,
          sizeBytes: media.sizeBytes,
        },
      })) as { itemId?: string; id?: string } | null;
      const itemId = item?.itemId ?? item?.id;
      if (itemId) itemIds.push(itemId);
    } catch (err) {
      console.warn("[sendblue] failed to catalog inbound media", err);
    }
  }
  return itemIds;
}

export async function sendImessage(toNumber: string, text: string): Promise<void> {
  const h = headers();
  if (!h) {
    console.warn("[sendblue] missing credentials — not sending");
    return;
  }
  const from = normalizeE164(process.env.SENDBLUE_FROM_NUMBER);
  if (!from) {
    console.error(
      `[sendblue] SENDBLUE_FROM_NUMBER is not set. Run \`npm run sendblue:sync\` (pulls it from \`sendblue lines\`) or paste your provisioned number into .env.local, then restart \`npm run dev\`.`,
    );
    return;
  }
  const plain = stripMarkdown(text);
  for (const part of chunk(plain)) {
    const res = await fetch(`${API_BASE}/send-message`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, content: part, from_number: from }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[sendblue] send failed ${res.status}: ${body}`);
      if (body.includes("missing required parameter") && body.includes("from_number")) {
        console.error(
          `[sendblue] → Set SENDBLUE_FROM_NUMBER in .env.local to your Sendblue-provisioned number and restart the server.`,
        );
      } else if (body.includes("Cannot send messages to self")) {
        console.error(
          `[sendblue] → SENDBLUE_FROM_NUMBER is your personal cell. It must be the Sendblue-provisioned number (the one people text TO).`,
        );
      } else if (body.includes("This phone number is not defined")) {
        console.error(
          `[sendblue] → Sendblue doesn't recognize from_number=${from}. Run \`npm run sendblue:sync\` to pull the correct one from \`sendblue lines\`, then restart the server.`,
        );
      }
    } else {
      console.log(`[sendblue] → sent ${part.length} chars to ${toNumber}`);
    }
  }
}

export async function sendTypingIndicator(toNumber: string): Promise<void> {
  const h = headers();
  if (!h) return;
  const from = process.env.SENDBLUE_FROM_NUMBER;
  try {
    await fetch(`${API_BASE}/send-typing-indicator`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ number: toNumber, from_number: from }),
    });
  } catch {
    /* non-fatal */
  }
}

export function startTypingLoop(toNumber: string): () => void {
  sendTypingIndicator(toNumber);
  const timer = setInterval(() => sendTypingIndicator(toNumber), 5000);
  return () => clearInterval(timer);
}

export function createSendblueRouter(): express.Router {
  const router = express.Router();

  router.post("/webhook", async (req, res) => {
    const { content, from_number, is_outbound, message_handle } = req.body ?? {};
    const contentText = typeof content === "string" ? content : "";
    const media: InboundMedia[] = [];
    collectInboundMedia(req.body, media, new Set());
    if (is_outbound || (!contentText && media.length === 0) || !from_number) {
      res.json({ ok: true, skipped: true });
      return;
    }

    if (message_handle) {
      const { claimed } = await convex.mutation(api.sendblueDedup.claim, {
        handle: message_handle,
      });
      if (!claimed) {
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const conversationId = `sms:${from_number}`;
    const turnTag = Math.random().toString(36).slice(2, 8);
    const preview = contentText.length > 100 ? contentText.slice(0, 100) + "…" : contentText;
    console.log(
      `[turn ${turnTag}] ← ${from_number}: ${JSON.stringify(preview || "(attachment-only)")}; ${attachmentSummary(media)}`,
    );
    const start = Date.now();

    broadcast("message_in", { conversationId, content: contentText, from_number, handle: message_handle });
    res.json({ ok: true });

    const stopTyping = startTypingLoop(from_number);
    try {
      const attachments = media.length > 0 ? await downloadInboundMedia(media) : [];
      if (attachments.length > 0) {
        await analyzeInboundMedia(attachments, contentText, conversationId, turnTag);
      }
      const attachmentContext = formatAttachmentContext(attachments);
      const downloadFailureContext =
        media.length > 0 && attachments.length === 0
          ? `Received ${media.length} attachment${media.length === 1 ? "" : "s"}, but none could be downloaded for processing.`
          : "";
      let contentForAgent = [
        contentText ||
          `Received ${media.length} attachment${media.length === 1 ? "" : "s"} via iMessage.`,
        attachmentContext,
        downloadFailureContext,
      ].filter(Boolean).join("\n\n");
      if (attachments.length > 0 && shouldCatalogInbound(contentText)) {
        const cataloged = await catalogInboundMedia({
          media: attachments,
          content: contentText,
          conversationId,
          messageHandle: message_handle,
        });
        if (cataloged.length > 0) {
          contentForAgent = `${contentForAgent}\n\nCataloged attachment item IDs: ${cataloged.join(", ")}`;
          console.log(`[turn ${turnTag}] cataloged ${cataloged.length}/${attachments.length} attachment(s): ${cataloged.join(", ")}`);
        } else {
          console.log(`[turn ${turnTag}] found ${attachments.length} attachment(s), none cataloged`);
        }
      } else if (attachments.length > 0) {
        console.log(`[turn ${turnTag}] found ${attachments.length} attachment(s), waiting for explicit catalog/save request`);
      }
      const reply = await handleUserMessage({
        conversationId,
        content: contentForAgent,
        turnTag,
        onThinking: (t) => broadcast("thinking", { conversationId, t }),
      });
      if (reply) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const replyPreview = reply.length > 100 ? reply.slice(0, 100) + "…" : reply;
        console.log(
          `[turn ${turnTag}] → reply (${elapsed}s, ${reply.length} chars): ${JSON.stringify(replyPreview)}`,
        );
        await sendImessage(from_number, reply);
        await convex.mutation(api.messages.send, {
          conversationId,
          role: "assistant",
          content: reply,
        });
      } else {
        console.log(`[turn ${turnTag}] → (no reply)`);
      }
    } catch (err) {
      console.error(`[turn ${turnTag}] handler error`, err);
    } finally {
      stopTyping();
    }
  });

  return router;
}
