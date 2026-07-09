export type CatalogModality = "note" | "image" | "audio" | "video" | "file";
export type CatalogSource = "imessage" | "dashboard_upload" | "connector";
export type CatalogStatus = "draft" | "processing" | "ready" | "failed" | "synced";
export type NotesSyncStatus = "not_synced" | "syncing" | "synced" | "failed";

export interface CatalogAsset {
  id: string;
  assetId: string;
  itemId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storageId?: string;
  storageUrl: string | null;
  thumbnailUrl?: string;
  durationMs?: number;
  createdAt?: number;
}

export interface CatalogProcessing {
  status: CatalogStatus;
  model: string;
  error?: string;
  extractedText?: string;
  transcript?: string;
}

export interface CatalogItem {
  id: string;
  itemId: string;
  title: string;
  summary: string;
  modality: CatalogModality;
  source: CatalogSource;
  status: CatalogStatus;
  tags: string[];
  collectionIds: string[];
  createdAt: number;
  updatedAt: number;
  syncedNoteId?: string;
  notesSyncStatus: NotesSyncStatus;
  assetIds: string[];
  assets: CatalogAsset[];
  processing: CatalogProcessing;
}

export interface CatalogCollection {
  collectionId: string;
  name: string;
  color: string;
}

export interface CatalogMetrics {
  total: number;
  synced: number;
  failed: number;
  processing: number;
  draft: number;
  media: number;
  byModality: Record<CatalogModality, number>;
  truncated: boolean;
}
