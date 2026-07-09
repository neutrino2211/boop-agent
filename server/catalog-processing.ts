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

interface CatalogAnalysis {
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
const MAX_TAGS = 12;
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
  const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
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
  if (!asset) throw new Error(`Catalog item ${item.itemId} has no attached asset`);
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

async function transcribeAudio(
  bytes: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Audio transcription requires OPENAI_API_KEY. The transcript is then summarized through the configured PI/OpenRouter catalog model.",
    );
  }
  const client = new OpenAI({ apiKey });
  const model = process.env.CATALOG_AUDIO_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe";
  const file = await toFile(bytes, filename, { type: contentType || "application/octet-stream" });
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
  );
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
      transcript = await transcribeAudio(audioBytes, `${media.asset.filename}.mp3`, "audio/mpeg");
    } catch (err) {
      console.warn("[catalog-processing] video audio transcription skipped", err);
    }
  }
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
