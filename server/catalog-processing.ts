import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { completeSimple, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import OpenAI, { toFile } from "openai";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { getCatalogModel, type CatalogModality } from "./catalog-models.js";
import { broadcast } from "./broadcast.js";
import { detectMediaMetadata } from "./media-detection.js";
import { resolveModelRef } from "./model-config.js";

interface CatalogAssetForProcessing {
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageUrl?: string | null;
  durationMs?: number;
}

interface CatalogItemForProcessing {
  itemId: string;
  title: string;
  summary: string;
  modality: CatalogModality;
  tags: string[];
  processing?: {
    extractedText?: string;
    transcript?: string;
  };
  assets: CatalogAssetForProcessing[];
}

export interface CatalogAnalysis {
  summary: string;
  tags: string[];
  extractedText?: string;
  transcript?: string;
}

interface MediaBytes {
  asset: CatalogAssetForProcessing;
  bytes: Buffer;
}

const MAX_TEXT_CHARS = 45_000;
const MAX_SUMMARY_CHARS = 800;
const MAX_TAGS = 12;
const OPENAI_TRANSCRIPTION_EXTS = new Set([
  ".flac",
  ".aac",
  ".aiff",
  ".aif",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".oga",
  ".ogg",
  ".wav",
  ".webm",
]);
const OPENROUTER_TRANSCRIPTION_FORMATS = new Set([
  "aac",
  "aiff",
  "flac",
  "m4a",
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "oga",
  "ogg",
  "wav",
  "webm",
]);
const ANALYSIS_SYSTEM_PROMPT = [
  "You are the catalog processing model for a personal notes and media dashboard.",
  "Return only JSON with this exact shape:",
  '{"summary":"one or two useful sentences","tags":["short","lowercase"],"extractedText":"optional OCR or extracted text","transcript":"optional transcript"}',
  "Prefer durable, searchable metadata over commentary.",
].join("\n");

function describeAssets(assets: CatalogAssetForProcessing[]): string {
  if (assets.length === 0) return "No attached asset.";
  return assets
    .map((asset) => {
      const mb = (asset.sizeBytes / 1_000_000).toFixed(2);
      const duration = asset.durationMs ? `, ${Math.round(asset.durationMs / 1000)}s` : "";
      return `${asset.filename} (${asset.contentType}, ${mb} MB${duration})`;
    })
    .join("; ");
}

function assistantText(content: Awaited<ReturnType<typeof completeSimple>>["content"]): string {
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Catalog model did not return JSON: ${text.slice(0, 240)}`);
  }
  return candidate.slice(start, end + 1);
}

function cleanTags(existing: string[], suggested: unknown, modality: CatalogModality): string[] {
  const next = new Set<string>();
  for (const tag of [...existing, modality]) {
    const cleaned = tag.trim().toLowerCase();
    if (cleaned) next.add(cleaned);
  }
  if (Array.isArray(suggested)) {
    for (const tag of suggested) {
      if (typeof tag !== "string") continue;
      const cleaned = tag.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
      if (cleaned) next.add(cleaned);
      if (next.size >= MAX_TAGS) break;
    }
  }
  return [...next].slice(0, MAX_TAGS);
}

function parseAnalysis(text: string, item: CatalogItemForProcessing): CatalogAnalysis {
  const trimmed = text.trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJsonObject(trimmed)) as Record<string, unknown>;
  } catch (err) {
    if (!trimmed) throw err;
    return {
      summary: trimmed.slice(0, MAX_SUMMARY_CHARS),
      tags: cleanTags(item.tags, [], item.modality),
    };
  }
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : item.summary || item.title;
  const extractedText =
    typeof parsed.extractedText === "string" && parsed.extractedText.trim()
      ? parsed.extractedText.trim()
      : undefined;
  const transcript =
    typeof parsed.transcript === "string" && parsed.transcript.trim()
      ? parsed.transcript.trim()
      : undefined;
  return {
    summary,
    tags: cleanTags(item.tags, parsed.tags, item.modality),
    extractedText,
    transcript,
  };
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function summaryFromTranscript(transcript: string, fallbackTitle: string): string {
  const compact = compactWhitespace(transcript);
  if (!compact) return `${fallbackTitle} was transcribed but had no intelligible speech.`;
  const firstSentence = compact.match(/^(.{40,400}?[.!?])\s/)?.[1];
  const candidate = firstSentence || compact;
  return candidate.length <= MAX_SUMMARY_CHARS
    ? candidate
    : `${candidate.slice(0, MAX_SUMMARY_CHARS - 1).trim()}…`;
}

function transcriptFallbackAnalysis(
  item: CatalogItemForProcessing,
  transcript: string,
): CatalogAnalysis {
  return {
    summary: summaryFromTranscript(transcript, item.title),
    tags: cleanTags(item.tags, ["transcript"], item.modality),
    transcript,
  };
}

function isTextLike(asset: CatalogAssetForProcessing): boolean {
  const type = asset.contentType.toLowerCase();
  const name = asset.filename.toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".csv") ||
    name.endsWith(".json") ||
    name.endsWith(".xml")
  );
}

function decodeText(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/\0/g, "").slice(0, MAX_TEXT_CHARS);
}

function extensionFor(asset: CatalogAssetForProcessing, fallback: string): string {
  const ext = path.extname(asset.filename);
  return ext || fallback;
}

async function fetchPrimaryAsset(item: CatalogItemForProcessing): Promise<MediaBytes> {
  const asset = item.assets[0];
  if (!asset) {
    throw new Error(
      `Catalog item ${item.itemId} is ${item.modality} but has no attached asset. ` +
        "Media items must be created through an upload or inbound attachment path.",
    );
  }
  if (!asset.storageUrl) throw new Error(`Catalog asset ${asset.filename} has no readable storage URL`);
  const response = await fetch(asset.storageUrl);
  if (!response.ok) {
    throw new Error(`Could not fetch ${asset.filename} (${response.status}): ${await response.text()}`);
  }
  return { asset, bytes: Buffer.from(await response.arrayBuffer()) };
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

async function writeTempFile(bytes: Buffer, ext: string): Promise<string> {
  const file = path.join(tmpdir(), `boop-catalog-${randomUUID()}${ext}`);
  await fs.writeFile(file, bytes);
  return file;
}

async function cleanup(paths: string[]): Promise<void> {
  await Promise.all(paths.map((file) => fs.rm(file, { force: true }).catch(() => undefined)));
}

async function extractVideoFrame(bytes: Buffer, asset: CatalogAssetForProcessing): Promise<ImageContent> {
  const input = await writeTempFile(bytes, extensionFor(asset, ".mp4"));
  const output = path.join(tmpdir(), `boop-catalog-frame-${randomUUID()}.jpg`);
  try {
    await runProcess("ffmpeg", [
      "-y",
      "-i",
      input,
      "-vf",
      "thumbnail,scale=768:-2",
      "-frames:v",
      "1",
      output,
    ]);
    return {
      type: "image",
      data: (await fs.readFile(output)).toString("base64"),
      mimeType: "image/jpeg",
    };
  } finally {
    await cleanup([input, output]);
  }
}

async function extractVideoAudio(bytes: Buffer, asset: CatalogAssetForProcessing): Promise<Buffer | null> {
  const input = await writeTempFile(bytes, extensionFor(asset, ".mp4"));
  const output = path.join(tmpdir(), `boop-catalog-audio-${randomUUID()}.mp3`);
  try {
    await runProcess("ffmpeg", [
      "-y",
      "-i",
      input,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      output,
    ]);
    return await fs.readFile(output);
  } catch {
    return null;
  } finally {
    await cleanup([input, output]);
  }
}

function canTranscribeDirectly(filename: string, contentType: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const type = contentType.toLowerCase();
  return (
    OPENAI_TRANSCRIPTION_EXTS.has(ext) ||
    type === "audio/flac" ||
    type === "audio/m4a" ||
    type === "audio/mp3" ||
    type === "audio/mpeg" ||
    type === "audio/mpga" ||
    type === "audio/ogg" ||
    type === "audio/wav" ||
    type === "audio/webm" ||
    type === "video/mp4" ||
    type === "video/webm"
  );
}

function openRouterModelId(ref: string): string {
  return ref.startsWith("openrouter/") ? ref.slice("openrouter/".length) : ref;
}

function openRouterAudioFormat(filename: string, contentType: string): string {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  if (OPENROUTER_TRANSCRIPTION_FORMATS.has(ext)) return ext;
  const type = contentType.toLowerCase();
  if (type.includes("aac")) return "aac";
  if (type.includes("aiff") || type.includes("aifc")) return "aiff";
  if (type.includes("flac")) return "flac";
  if (type.includes("m4a") || type.includes("mp4")) return "m4a";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("ogg") || type.includes("opus")) return "ogg";
  if (type.includes("wav") || type.includes("wave")) return "wav";
  if (type.includes("webm")) return "webm";
  return "mp3";
}

function openRouterAudioModelCandidates(modelRef: string): string[] {
  const candidates = [
    modelRef.startsWith("openrouter/") ? openRouterModelId(modelRef) : undefined,
    process.env.OPENROUTER_AUDIO_TRANSCRIBE_MODEL?.trim(),
    process.env.CATALOG_AUDIO_TRANSCRIBE_MODEL?.trim()?.startsWith("openrouter/")
      ? openRouterModelId(process.env.CATALOG_AUDIO_TRANSCRIBE_MODEL.trim())
      : process.env.CATALOG_AUDIO_TRANSCRIBE_MODEL?.trim(),
    "openai/whisper-1",
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is string => {
    if (!candidate || seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

async function convertAudioForTranscription(
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
  if (canTranscribeDirectly(filename, contentType)) {
    return { bytes, filename, contentType };
  }
  const asset = { filename, contentType, sizeBytes: bytes.length };
  const input = await writeTempFile(bytes, extensionFor(asset, ".audio"));
  const output = path.join(tmpdir(), `boop-catalog-transcribe-${randomUUID()}.mp3`);
  try {
    await runProcess("ffmpeg", [
      "-y",
      "-i",
      input,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      output,
    ]);
    const base = path.basename(filename, path.extname(filename)) || "audio";
    return {
      bytes: await fs.readFile(output),
      filename: `${base}.mp3`,
      contentType: "audio/mpeg",
    };
  } finally {
    await cleanup([input, output]);
  }
}

function openRouterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
  if (process.env.OPENROUTER_HTTP_REFERER) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_HTTP_REFERER;
  }
  headers["X-Title"] = process.env.OPENROUTER_APP_TITLE || "Boop Agent";
  return headers;
}

function openRouterTextFromChatResponse(payload: unknown): string {
  const obj = payload as {
    choices?: Array<{
      message?: {
        content?: unknown;
      };
    }>;
  };
  const content = obj.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const block = part as Record<string, unknown>;
        return typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

async function transcribeAudioWithOpenRouter(
  bytes: Buffer,
  filename: string,
  contentType: string,
  modelRef: string,
): Promise<{ text: string; model: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured");
  const prepared = await convertAudioForTranscription(bytes, filename, contentType);
  const inputAudio = {
    data: prepared.bytes.toString("base64"),
    format: openRouterAudioFormat(prepared.filename, prepared.contentType),
  };
  const errors: string[] = [];
  for (const model of openRouterAudioModelCandidates(modelRef)) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model,
          input_audio: inputAudio,
        }),
      });
      const payload = (await res.json().catch(async () => ({ error: await res.text() }))) as {
        text?: unknown;
        error?: unknown;
      };
      if (!res.ok) {
        const detail =
          typeof payload.error === "string"
            ? payload.error
            : JSON.stringify(payload.error ?? payload).slice(0, 500);
        throw new Error(`STT ${res.status}: ${detail}`);
      }
      if (typeof payload.text === "string" && payload.text.trim()) {
        return { text: payload.text.trim(), model: `openrouter/${model}` };
      }
      throw new Error("STT response did not include text");
    } catch (err) {
      errors.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: openRouterHeaders(),
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Transcribe this audio faithfully. Return only the transcript text. " +
                    "If there is no intelligible speech, briefly describe the audible content.",
                },
                {
                  type: "input_audio",
                  input_audio: inputAudio,
                },
              ],
            },
          ],
          stream: false,
        }),
      });
      const payload = await res.json().catch(async () => ({ error: await res.text() }));
      if (!res.ok) {
        const detail = JSON.stringify((payload as { error?: unknown }).error ?? payload).slice(0, 500);
        throw new Error(`chat audio ${res.status}: ${detail}`);
      }
      const text = openRouterTextFromChatResponse(payload);
      if (text) return { text, model: `openrouter/${model}` };
      throw new Error("chat audio response did not include text");
    } catch (err) {
      errors.push(`${model} chat: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`OpenRouter audio transcription failed: ${errors.join("; ")}`);
}

async function transcribeAudio(
  bytes: Buffer,
  filename: string,
  contentType: string,
  modelRef: string,
): Promise<string> {
  try {
    const result = await transcribeAudioWithOpenRouter(bytes, filename, contentType, modelRef);
    console.log(`[catalog-processing] transcribed audio with ${result.model}`);
    return result.text;
  } catch (err) {
    console.warn("[catalog-processing] OpenRouter audio transcription failed; falling back", err);
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Audio transcription requires OPENROUTER_API_KEY, or OPENAI_API_KEY as a fallback.",
    );
  }
  const client = new OpenAI({ apiKey });
  const model = process.env.CATALOG_AUDIO_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe";
  const prepared = await convertAudioForTranscription(bytes, filename, contentType);
  const file = await toFile(prepared.bytes, prepared.filename, {
    type: prepared.contentType || "application/octet-stream",
  });
  const result = await client.audio.transcriptions.create({ file, model });
  if (typeof result === "string") return result;
  return result.text;
}

async function analyzeWithPi(args: {
  item: CatalogItemForProcessing;
  modelRef: string;
  prompt: string;
  images?: ImageContent[];
}): Promise<CatalogAnalysis> {
  const { ref, model } = resolveModelRef(args.modelRef);
  const images = args.images ?? [];
  const canUseImages = model.input.includes("image");
  if (images.length > 0 && !canUseImages) {
    throw new Error(
      `Catalog model ${ref} does not accept image input. Choose a vision-capable PI/OpenRouter model for ${args.item.modality}.`,
    );
  }
  const content =
    images.length > 0
      ? ([{ type: "text", text: args.prompt }, ...images] satisfies (TextContent | ImageContent)[])
      : args.prompt;
  const response = await completeSimple(
    model,
    {
      systemPrompt: ANALYSIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content, timestamp: Date.now() }],
    },
    { maxTokens: 1200 },
  );
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage || `Catalog model ${ref} failed`);
  }
  return parseAnalysis(assistantText(response.content), args.item);
}

function basePrompt(item: CatalogItemForProcessing): string {
  return [
    `Catalog item id: ${item.itemId}`,
    `Title: ${item.title}`,
    `Current summary: ${item.summary || "(none)"}`,
    `Modality: ${item.modality}`,
    `Existing tags: ${item.tags.join(", ") || "(none)"}`,
    `Assets: ${describeAssets(item.assets)}`,
  ].join("\n");
}

async function analyzeNote(
  item: CatalogItemForProcessing,
  modelRef: string,
  text?: string,
): Promise<CatalogAnalysis> {
  return analyzeWithPi({
    item,
    modelRef,
    prompt: [
      basePrompt(item),
      "",
      "Organize this note for later retrieval. Preserve concrete names, links, decisions, and action items.",
      "",
      "Text:",
      text || item.processing?.extractedText || item.summary || item.title,
    ].join("\n"),
  });
}

async function analyzeImage(
  item: CatalogItemForProcessing,
  modelRef: string,
  media: MediaBytes,
): Promise<CatalogAnalysis> {
  return analyzeWithPi({
    item,
    modelRef,
    prompt: [
      basePrompt(item),
      "",
      "Analyze the attached image for cataloging. Include visible text as extractedText when useful.",
    ].join("\n"),
    images: [
      {
        type: "image",
        data: media.bytes.toString("base64"),
        mimeType: media.asset.contentType || "image/jpeg",
      },
    ],
  });
}

async function analyzeAudio(
  item: CatalogItemForProcessing,
  modelRef: string,
  media: MediaBytes,
): Promise<CatalogAnalysis> {
  const transcript = await transcribeAudio(
    media.bytes,
    media.asset.filename,
    media.asset.contentType,
    modelRef,
  );
  try {
    const analysis = await analyzeWithPi({
      item,
      modelRef,
      prompt: [
        basePrompt(item),
        "",
        "Summarize and tag this audio transcript for retrieval.",
        "",
        "Transcript:",
        transcript.slice(0, MAX_TEXT_CHARS),
      ].join("\n"),
    });
    return { ...analysis, transcript: analysis.transcript || transcript };
  } catch (err) {
    console.warn("[catalog-processing] audio transcript summarization skipped", err);
    return transcriptFallbackAnalysis(item, transcript);
  }
}

async function analyzeVideo(
  item: CatalogItemForProcessing,
  modelRef: string,
  media: MediaBytes,
): Promise<CatalogAnalysis> {
  const [frame, audioBytes] = await Promise.all([
    extractVideoFrame(media.bytes, media.asset),
    extractVideoAudio(media.bytes, media.asset),
  ]);
  let transcript: string | undefined;
  if (audioBytes) {
    try {
      transcript = await transcribeAudio(audioBytes, `${media.asset.filename}.mp3`, "audio/mpeg", modelRef);
    } catch (err) {
      console.warn("[catalog-processing] video audio transcription skipped", err);
    }
  }
  try {
    const analysis = await analyzeWithPi({
      item,
      modelRef,
      prompt: [
        basePrompt(item),
        "",
        "Analyze this representative video frame and any transcript for cataloging.",
        transcript ? "\nTranscript:" : "",
        transcript ? transcript.slice(0, MAX_TEXT_CHARS) : "",
      ].join("\n"),
      images: [frame],
    });
    return { ...analysis, transcript: analysis.transcript || transcript };
  } catch (err) {
    if (!transcript) throw err;
    console.warn("[catalog-processing] video frame summarization skipped", err);
    return transcriptFallbackAnalysis(item, transcript);
  }
}

async function analyzeFile(
  item: CatalogItemForProcessing,
  modelRef: string,
  media: MediaBytes,
): Promise<CatalogAnalysis> {
  const text = isTextLike(media.asset) ? decodeText(media.bytes) : "";
  return analyzeWithPi({
    item,
    modelRef,
    prompt: [
      basePrompt(item),
      "",
      text
        ? "Summarize and tag this file content for retrieval."
        : "Summarize and tag this file from its catalog metadata. If content extraction is required, say so in extractedText.",
      text ? "\nFile content:" : "",
      text,
    ].join("\n"),
  });
}

async function analyzeItem(
  item: CatalogItemForProcessing,
  modelRef: string,
): Promise<CatalogAnalysis> {
  if (item.modality === "note" && item.assets.length === 0) {
    return analyzeNote(item, modelRef);
  }
  const media = await fetchPrimaryAsset(item);
  if (item.modality === "note") {
    return analyzeNote(item, modelRef, isTextLike(media.asset) ? decodeText(media.bytes) : item.summary);
  }
  if (item.modality === "image") return analyzeImage(item, modelRef, media);
  if (item.modality === "audio") return analyzeAudio(item, modelRef, media);
  if (item.modality === "video") return analyzeVideo(item, modelRef, media);
  return analyzeFile(item, modelRef, media);
}

export interface AttachmentAnalysisResult extends CatalogAnalysis {
  modality: CatalogModality;
  model: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export async function analyzeAttachmentBytes(args: {
  bytes: Buffer;
  filename: string;
  contentType: string;
  sourceText?: string;
  sourceConversationId?: string;
}): Promise<AttachmentAnalysisResult> {
  const detected = await detectMediaMetadata({
    bytes: args.bytes,
    filename: args.filename,
    contentType: args.contentType,
  });
  const modality = detected.modality as CatalogModality;
  const model = await getCatalogModel(modality);
  const asset: CatalogAssetForProcessing = {
    filename: detected.filename,
    contentType: detected.contentType,
    sizeBytes: args.bytes.length,
  };
  const item: CatalogItemForProcessing = {
    itemId: `inbound_${randomUUID()}`,
    title: detected.filename,
    summary: args.sourceText?.trim() || `${detected.filename} received as an inbound attachment.`,
    modality,
    tags: ["imessage", modality],
    assets: [asset],
  };
  const media = { asset, bytes: args.bytes };
  let analysis: CatalogAnalysis;
  if (modality === "note") {
    analysis = await analyzeNote(item, model, isTextLike(asset) ? decodeText(args.bytes) : item.summary);
  } else if (modality === "image") {
    analysis = await analyzeImage(item, model, media);
  } else if (modality === "audio") {
    analysis = await analyzeAudio(item, model, media);
  } else if (modality === "video") {
    analysis = await analyzeVideo(item, model, media);
  } else {
    analysis = await analyzeFile(item, model, media);
  }
  return {
    ...analysis,
    modality,
    model,
    filename: detected.filename,
    contentType: detected.contentType,
    sizeBytes: args.bytes.length,
  };
}

export async function processCatalogItem(itemId: string): Promise<void> {
  const item = (await convex.query(api.catalog.get, { itemId })) as CatalogItemForProcessing | null;
  if (!item) throw new Error(`Catalog item not found: ${itemId}`);
  const model = await getCatalogModel(item.modality);
  await convex.mutation(api.catalog.setProcessing, {
    itemId,
    status: "processing",
    processingModel: model,
  });
  broadcast("catalog.processing", { itemId, status: "processing", model });

  try {
    const analysis = await analyzeItem(item, model);
    await convex.mutation(api.catalog.setProcessing, {
      itemId,
      status: "ready",
      processingModel: model,
      summary: analysis.summary,
      extractedText: analysis.extractedText,
      transcript: analysis.transcript,
      tags: analysis.tags,
    });
    broadcast("catalog.processing", { itemId, status: "ready", model });
  } catch (err) {
    await convex.mutation(api.catalog.setProcessing, {
      itemId,
      status: "failed",
      processingModel: model,
      processingError: err instanceof Error ? err.message : String(err),
    });
    broadcast("catalog.processing", {
      itemId,
      status: "failed",
      model,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
