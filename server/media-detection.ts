import path from "node:path";
import { fileTypeFromBuffer } from "file-type";
import mime from "mime-types";

export type MediaModality = "note" | "image" | "audio" | "video" | "file";

const OCTET_STREAM = "application/octet-stream";

function cleanContentType(value: string | false | null | undefined): string {
  const cleaned = typeof value === "string" ? value.split(";")[0]?.trim().toLowerCase() : "";
  return cleaned || OCTET_STREAM;
}

function extWithDot(value: string | false | null | undefined): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function extensionForMime(contentType: string): string {
  return extWithDot(mime.extension(contentType));
}

function contentTypeForFilename(filename: string): string {
  return cleanContentType(mime.lookup(filename));
}

function isGenericContentType(contentType: string): boolean {
  return !contentType || contentType === OCTET_STREAM || contentType === "binary/octet-stream";
}

function classifyContentType(contentType: string): MediaModality | null {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/xml" ||
    contentType === "application/yaml" ||
    contentType === "application/x-yaml"
  ) {
    return "note";
  }
  return null;
}

export function modalityForMime(contentType: string, filename = ""): MediaModality {
  const declared = cleanContentType(contentType);
  const filenameType = filename ? contentTypeForFilename(filename) : OCTET_STREAM;
  const first = !isGenericContentType(declared) ? declared : filenameType;
  const firstMatch = classifyContentType(first);
  if (firstMatch) return firstMatch;
  const fallbackMatch = classifyContentType(filenameType);
  return fallbackMatch ?? "file";
}

export function normalizeFilenameForMime(filename: string, contentType: string): string {
  const cleaned = filename.trim() || "attachment";
  if (path.extname(cleaned)) return cleaned;
  const ext = extensionForMime(cleanContentType(contentType));
  return ext ? `${cleaned}${ext}` : cleaned;
}

export async function detectMediaMetadata(args: {
  bytes?: Buffer;
  filename: string;
  contentType?: string | null;
}): Promise<{
  filename: string;
  contentType: string;
  modality: MediaModality;
  detectedContentType?: string;
  detectedExtension?: string;
}> {
  const detected = args.bytes ? await fileTypeFromBuffer(args.bytes).catch(() => undefined) : undefined;
  const detectedContentType = cleanContentType(detected?.mime);
  const declaredContentType = cleanContentType(args.contentType);
  const filenameContentType = contentTypeForFilename(args.filename);
  const contentType = !isGenericContentType(detectedContentType)
    ? detectedContentType
    : !isGenericContentType(declaredContentType)
      ? declaredContentType
      : filenameContentType;
  const detectedExtension = extWithDot(detected?.ext);
  const filename = path.extname(args.filename)
    ? args.filename
    : detectedExtension
      ? `${args.filename || "attachment"}${detectedExtension}`
      : normalizeFilenameForMime(args.filename || "attachment", contentType);
  return {
    filename,
    contentType,
    modality: modalityForMime(contentType, filename),
    detectedContentType: detected ? detectedContentType : undefined,
    detectedExtension: detectedExtension || undefined,
  };
}
