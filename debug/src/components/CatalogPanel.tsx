import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AiAudioIcon,
  AiImageIcon,
  AiVideoIcon,
  AlertCircleIcon,
  ArrowReloadHorizontalIcon,
  CheckmarkCircle02Icon,
  Clock03Icon,
  CloudUploadIcon,
  DatabaseSyncIcon,
  Download01Icon,
  Edit02Icon,
  File01Icon,
  FileAttachmentIcon,
  FileSyncIcon,
  GridViewIcon,
  LayoutTable01Icon,
  Search01Icon,
  SortingAZ01Icon,
  Tag01Icon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import {
  type CatalogAsset,
  type CatalogCollection,
  type CatalogItem,
  type CatalogModality,
  type CatalogProcessing,
  type CatalogSource,
  type CatalogStatus,
} from "../lib/catalogTypes.js";
import { api } from "../../../convex/_generated/api.js";

type ViewMode = "grid" | "list";
type SortMode = "newest" | "oldest" | "title" | "updated";
type ModalityFilter = "all" | CatalogModality;
type StatusFilter = "all" | CatalogStatus;
type SourceFilter = "all" | CatalogSource;

interface CatalogActions {
  onRetryProcessing: (itemId: string) => void;
  onSyncToNotes: (itemId: string) => void;
  onUpdateMetadata: (itemId: string, patch: Partial<Pick<CatalogItem, "title" | "summary" | "tags" | "collectionIds">>) => void;
  onUploadAsset: (file: File) => void;
}

const MODALITY_OPTIONS: Array<{ id: ModalityFilter; label: string; icon: any }> = [
  { id: "all", label: "All", icon: FileAttachmentIcon },
  { id: "note", label: "Notes", icon: File01Icon },
  { id: "image", label: "Images", icon: AiImageIcon },
  { id: "audio", label: "Audio", icon: AiAudioIcon },
  { id: "video", label: "Video", icon: AiVideoIcon },
  { id: "file", label: "Files", icon: FileAttachmentIcon },
];

const STATUS_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All states" },
  { id: "draft", label: "Draft" },
  { id: "processing", label: "Processing" },
  { id: "ready", label: "Ready" },
  { id: "failed", label: "Failed" },
  { id: "synced", label: "Synced" },
];

const SOURCE_OPTIONS: Array<{ id: SourceFilter; label: string }> = [
  { id: "all", label: "All sources" },
  { id: "imessage", label: "iMessage" },
  { id: "dashboard_upload", label: "Dashboard" },
  { id: "connector", label: "Connector" },
];

const SORT_OPTIONS: Array<{ id: SortMode; label: string }> = [
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "title", label: "Title" },
  { id: "updated", label: "Updated" },
];

const STATUS_STYLE: Record<CatalogStatus, { dark: string; light: string; icon: any }> = {
  draft: {
    dark: "text-slate-300 bg-slate-700/40 border-slate-600/50",
    light: "text-slate-600 bg-slate-100 border-slate-200",
    icon: Edit02Icon,
  },
  processing: {
    dark: "text-sky-300 bg-sky-500/10 border-sky-400/20",
    light: "text-sky-700 bg-sky-50 border-sky-200",
    icon: Clock03Icon,
  },
  ready: {
    dark: "text-emerald-300 bg-emerald-500/10 border-emerald-400/20",
    light: "text-emerald-700 bg-emerald-50 border-emerald-200",
    icon: CheckmarkCircle02Icon,
  },
  failed: {
    dark: "text-rose-300 bg-rose-500/10 border-rose-400/20",
    light: "text-rose-700 bg-rose-50 border-rose-200",
    icon: AlertCircleIcon,
  },
  synced: {
    dark: "text-amber-300 bg-amber-500/10 border-amber-400/20",
    light: "text-amber-700 bg-amber-50 border-amber-200",
    icon: DatabaseSyncIcon,
  },
};

const MODALITY_TONE: Record<CatalogModality, { dark: string; light: string; icon: any; label: string }> = {
  note: {
    dark: "text-cyan-300 bg-cyan-400/10 border-cyan-400/20",
    light: "text-cyan-700 bg-cyan-50 border-cyan-200",
    icon: File01Icon,
    label: "Note",
  },
  image: {
    dark: "text-fuchsia-300 bg-fuchsia-400/10 border-fuchsia-400/20",
    light: "text-fuchsia-700 bg-fuchsia-50 border-fuchsia-200",
    icon: AiImageIcon,
    label: "Image",
  },
  audio: {
    dark: "text-lime-300 bg-lime-400/10 border-lime-400/20",
    light: "text-lime-700 bg-lime-50 border-lime-200",
    icon: AiAudioIcon,
    label: "Audio",
  },
  video: {
    dark: "text-orange-300 bg-orange-400/10 border-orange-400/20",
    light: "text-orange-700 bg-orange-50 border-orange-200",
    icon: AiVideoIcon,
    label: "Video",
  },
  file: {
    dark: "text-violet-300 bg-violet-400/10 border-violet-400/20",
    light: "text-violet-700 bg-violet-50 border-violet-200",
    icon: FileAttachmentIcon,
    label: "File",
  },
};

export function CatalogPanel({ isDark }: { isDark: boolean }) {
  const [query, setQuery] = useState("");
  const [modality, setModality] = useState<ModalityFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [sort, setSort] = useState<SortMode>("newest");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const updateMetadata = useMutation(api.catalog.updateMetadata);

  const itemsQuery = useQuery(api.catalog.list, {
    query: query.trim() || undefined,
    modality: modality !== "all" ? modality : undefined,
    status: status !== "all" ? status : undefined,
    source: source !== "all" ? source : undefined,
    sort,
    limit: 100,
  }) as CatalogItem[] | undefined;
  const collectionsQuery = useQuery(api.catalog.listCollections, {}) as
    | CatalogCollection[]
    | undefined;
  const metrics = useQuery(api.catalog.metrics, {});

  const items = itemsQuery ?? [];
  const collections = collectionsQuery ?? [];
  const loading = itemsQuery === undefined || collectionsQuery === undefined;

  const collectionById = useMemo(
    () => new Map(collections.map((collection) => [collection.collectionId, collection])),
    [collections],
  );

  const effectiveItems = items;
  const selectedItem =
    effectiveItems.find((item) => item.id === selectedId) ?? effectiveItems[0] ?? null;

  const totals = useMemo(
    () => ({
      all: metrics?.total ?? items.length,
      media: metrics?.media ?? items.filter((item) => item.modality !== "note").length,
      ready:
        (metrics?.synced ?? 0) +
        items.filter((item) => item.status === "ready").length,
      attention:
        (metrics?.failed ?? 0) +
        (metrics?.draft ?? 0),
    }),
    [items, metrics],
  );

  const actions: CatalogActions = {
    onRetryProcessing: (itemId) => {
      setBusyAction(`retry:${itemId}`);
      setOperationError(null);
      fetch(`/api/catalog/${encodeURIComponent(itemId)}/retry`, { method: "POST" })
        .then(async (res) => {
          if (!res.ok) throw new Error(await parseError(res));
        })
        .catch((err) => setOperationError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyAction(null));
    },
    onSyncToNotes: (itemId) => {
      setBusyAction(`sync:${itemId}`);
      setOperationError(null);
      fetch(`/api/catalog/${encodeURIComponent(itemId)}/sync`, { method: "POST" })
        .then(async (res) => {
          if (!res.ok) throw new Error(await parseError(res));
        })
        .catch((err) => setOperationError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyAction(null));
    },
    onUpdateMetadata: (itemId, patch) => {
      setBusyAction(`edit:${itemId}`);
      setOperationError(null);
      updateMetadata({ itemId, ...patch })
        .catch((err) => setOperationError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyAction(null));
    },
    onUploadAsset: (file) => {
      setBusyAction("upload");
      setOperationError(null);
      const params = new URLSearchParams({
        filename: file.name,
        source: "dashboard_upload",
      });
      fetch(`/api/catalog/upload?${params}`, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "x-filename": file.name,
        },
        body: file,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(await parseError(res));
        })
        .catch((err) => setOperationError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusyAction(null));
    },
  };

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) actions.onUploadAsset(file);
    event.target.value = "";
  }

  const chrome = {
    border: isDark ? "border-slate-800" : "border-slate-200",
    panel: isDark ? "bg-slate-950" : "bg-slate-50",
    surface: isDark ? "bg-slate-900/45 border-slate-800" : "bg-white border-slate-200",
    surfaceHover: isDark ? "hover:bg-slate-900/80" : "hover:bg-slate-50",
    text: isDark ? "text-slate-200" : "text-slate-800",
    muted: isDark ? "text-slate-500" : "text-slate-500",
    faint: isDark ? "text-slate-600" : "text-slate-400",
    input: isDark
      ? "bg-slate-900 border-slate-700 text-slate-200 placeholder:text-slate-600"
      : "bg-white border-slate-300 text-slate-800 placeholder:text-slate-400",
    active: isDark ? "bg-slate-700 text-white" : "bg-slate-200 text-slate-900",
    inactive: isDark
      ? "text-slate-500 hover:text-slate-200 hover:bg-slate-800"
      : "text-slate-500 hover:text-slate-800 hover:bg-slate-100",
  };

  return (
    <div className={`flex flex-col h-full -m-5 ${chrome.panel}`}>
      <div className={`shrink-0 border-b px-5 py-3 ${chrome.border}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className={`text-xs font-semibold uppercase ${chrome.muted}`}>Catalog</div>
            <div className={`text-[11px] mt-0.5 ${chrome.faint}`}>
              {totals.all} items · {totals.media} media · {totals.attention} need attention
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busyAction === "upload"}
              className={`inline-flex items-center gap-2 text-xs rounded-md px-3 py-1.5 border transition-colors ${
                isDark
                  ? "border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20"
                  : "border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100"
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <HugeiconsIcon icon={Upload01Icon} size={15} />
              {busyAction === "upload" ? "Uploading" : "Upload"}
            </button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={onFileChange} />
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 xl:grid-cols-[minmax(260px,1fr)_auto] gap-3">
          <label className="relative block">
            <HugeiconsIcon
              icon={Search01Icon}
              size={16}
              className={`absolute left-3 top-1/2 -translate-y-1/2 ${chrome.faint}`}
            />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, tags, source, summary…"
              className={`w-full h-9 rounded-md border pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500/30 ${chrome.input}`}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
              className={`h-9 text-xs rounded-md px-2.5 border ${chrome.input}`}
              aria-label="Status filter"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={source}
              onChange={(event) => setSource(event.target.value as SourceFilter)}
              className={`h-9 text-xs rounded-md px-2.5 border ${chrome.input}`}
              aria-label="Source filter"
            >
              {SOURCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <label className={`h-9 inline-flex items-center gap-1.5 rounded-md border px-2 ${chrome.input}`}>
              <HugeiconsIcon icon={SortingAZ01Icon} size={15} className={chrome.faint} />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as SortMode)}
                className="bg-transparent text-xs focus:outline-none"
                aria-label="Sort catalog"
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className={`inline-flex h-9 rounded-md border overflow-hidden ${chrome.border}`}>
              {(["grid", "list"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  aria-label={`${mode} view`}
                  title={`${mode} view`}
                  className={`w-9 inline-flex items-center justify-center transition-colors ${
                    viewMode === mode ? chrome.active : chrome.inactive
                  }`}
                >
                  <HugeiconsIcon icon={mode === "grid" ? GridViewIcon : LayoutTable01Icon} size={16} />
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-1 overflow-x-auto debug-scroll pb-1">
          {MODALITY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setModality(option.id)}
              className={`shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                modality === option.id ? chrome.active : chrome.inactive
              }`}
            >
              <HugeiconsIcon icon={option.icon} size={14} />
              {option.label}
            </button>
          ))}
          <span className={`ml-auto shrink-0 text-xs mono ${chrome.faint}`}>
            {effectiveItems.length}/{items.length}
          </span>
        </div>
        {operationError && (
          <div
            className={`mt-2 rounded-md border px-3 py-2 text-xs ${
              isDark
                ? "border-rose-500/30 bg-rose-500/10 text-rose-200"
                : "border-rose-200 bg-rose-50 text-rose-700"
            }`}
          >
            {operationError}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className={`min-h-0 overflow-y-auto debug-scroll border-r ${chrome.border}`}>
          {loading ? (
            <CatalogLoading isDark={isDark} />
          ) : effectiveItems.length === 0 ? (
            <CatalogState
              isDark={isDark}
              icon={Search01Icon}
              title="Nothing in this view"
              body="Try a different filter, clear search, or upload an asset."
            />
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3 p-4">
              {effectiveItems.map((item) => (
                <CatalogCard
                  key={item.id}
                  item={item}
                  asset={item.assets[0]}
                  selected={selectedItem?.id === item.id}
                  isDark={isDark}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          ) : (
            <div className={`divide-y ${isDark ? "divide-slate-800/70" : "divide-slate-100"}`}>
              {effectiveItems.map((item) => (
                <CatalogRow
                  key={item.id}
                  item={item}
                  asset={item.assets[0]}
                  selected={selectedItem?.id === item.id}
                  isDark={isDark}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          )}
        </div>

        <CatalogDetail
          item={selectedItem}
          assets={selectedItem?.assets ?? []}
          collections={selectedItem ? selectedItem.collectionIds.map((id) => collectionById.get(id)?.name ?? id) : []}
          isDark={isDark}
          actions={actions}
          busyAction={busyAction}
        />
      </div>
    </div>
  );
}

function CatalogCard({
  item,
  asset,
  selected,
  isDark,
  onSelect,
}: {
  item: CatalogItem;
  asset?: CatalogAsset;
  selected: boolean;
  isDark: boolean;
  onSelect: () => void;
}) {
  const modality = MODALITY_TONE[item.modality];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left rounded-lg border overflow-hidden transition-all ${
        selected
          ? isDark
            ? "border-sky-400/70 bg-slate-900 shadow-[0_0_0_1px_rgba(56,189,248,0.2)]"
            : "border-sky-400 bg-white shadow-sm"
          : isDark
            ? "border-slate-800 bg-slate-900/40 hover:border-slate-700"
            : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <PreviewBlock item={item} asset={asset} isDark={isDark} compact={false} />
      <div className="p-3 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${isDark ? modality.dark : modality.light}`}>
            <HugeiconsIcon icon={modality.icon} size={12} />
            {modality.label}
          </span>
          <StatusBadge status={item.status} isDark={isDark} />
        </div>
        <div className={`font-semibold text-sm leading-snug line-clamp-2 ${isDark ? "text-slate-100" : "text-slate-900"}`}>
          {item.title}
        </div>
        <p className={`text-xs leading-relaxed mt-1.5 line-clamp-3 ${isDark ? "text-slate-400" : "text-slate-600"}`}>
          {item.summary}
        </p>
        <TagStrip tags={item.tags} isDark={isDark} limit={3} />
        <div className={`mt-3 flex items-center justify-between text-[11px] ${isDark ? "text-slate-600" : "text-slate-400"}`}>
          <span>{sourceLabel(item.source)}</span>
          <span>{formatRelative(item.updatedAt)}</span>
        </div>
      </div>
    </button>
  );
}

function CatalogRow({
  item,
  asset,
  selected,
  isDark,
  onSelect,
}: {
  item: CatalogItem;
  asset?: CatalogAsset;
  selected: boolean;
  isDark: boolean;
  onSelect: () => void;
}) {
  const modality = MODALITY_TONE[item.modality];
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-4 py-3 grid grid-cols-[64px_minmax(0,1fr)] sm:grid-cols-[64px_minmax(0,1fr)_auto] gap-3 transition-colors ${
        selected
          ? isDark
            ? "bg-sky-500/10"
            : "bg-sky-50"
          : isDark
            ? "hover:bg-slate-900/60"
            : "hover:bg-slate-50"
      }`}
    >
      <PreviewBlock item={item} asset={asset} isDark={isDark} compact />
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <HugeiconsIcon icon={modality.icon} size={14} className={isDark ? "text-slate-500" : "text-slate-400"} />
          <span className={`font-medium text-sm truncate ${isDark ? "text-slate-100" : "text-slate-900"}`}>
            {item.title}
          </span>
        </div>
        <p className={`text-xs line-clamp-2 ${isDark ? "text-slate-400" : "text-slate-600"}`}>
          {item.summary}
        </p>
        <TagStrip tags={item.tags} isDark={isDark} limit={4} />
      </div>
      <div className="col-start-2 sm:col-start-auto flex flex-row sm:flex-col items-center sm:items-end justify-between gap-2">
        <StatusBadge status={item.status} isDark={isDark} />
        <span className={`text-[11px] whitespace-nowrap ${isDark ? "text-slate-600" : "text-slate-400"}`}>
          {formatRelative(item.updatedAt)}
        </span>
      </div>
    </button>
  );
}

function CatalogDetail({
  item,
  assets,
  collections,
  isDark,
  actions,
  busyAction,
}: {
  item: CatalogItem | null;
  assets: CatalogAsset[];
  collections: string[];
  isDark: boolean;
  actions: CatalogActions;
  busyAction: string | null;
}) {
  const muted = isDark ? "text-slate-500" : "text-slate-500";
  const text = isDark ? "text-slate-200" : "text-slate-800";
  const border = isDark ? "border-slate-800" : "border-slate-200";
  const surface = isDark ? "bg-slate-950" : "bg-white";

  if (!item) {
    return (
      <aside className={`min-h-0 overflow-y-auto debug-scroll ${surface}`}>
        <CatalogState
          isDark={isDark}
          icon={FileAttachmentIcon}
          title="No item selected"
          body="Item metadata and assets will appear here."
        />
      </aside>
    );
  }

  const primaryAsset = assets[0];
  const modality = MODALITY_TONE[item.modality];

  return (
    <aside className={`min-h-0 overflow-y-auto debug-scroll ${surface}`}>
      <div className={`border-b ${border}`}>
        <PreviewBlock item={item} asset={primaryAsset} isDark={isDark} compact={false} />
      </div>

      <div className="p-4 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] ${isDark ? modality.dark : modality.light}`}>
              <HugeiconsIcon icon={modality.icon} size={12} />
              {modality.label}
            </span>
            <StatusBadge status={item.status} isDark={isDark} />
          </div>
          <h2 className={`text-lg font-semibold leading-tight ${text}`}>{item.title}</h2>
          <p className={`text-sm leading-relaxed mt-2 ${isDark ? "text-slate-400" : "text-slate-600"}`}>
            {item.summary}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <MetaTile label="Source" value={sourceLabel(item.source)} isDark={isDark} />
          <MetaTile label="Updated" value={formatDate(item.updatedAt)} isDark={isDark} />
          <MetaTile label="Created" value={formatDate(item.createdAt)} isDark={isDark} />
          <MetaTile label="Trilium" value={notesSyncLabel(item)} isDark={isDark} />
        </div>

        <section>
          <SectionHeader icon={Tag01Icon} label="Tags" isDark={isDark} />
          <TagStrip tags={item.tags} isDark={isDark} limit={12} />
        </section>

        <section>
          <SectionHeader icon={FileSyncIcon} label="Collections" isDark={isDark} />
          <div className="flex flex-wrap gap-1.5">
            {collections.map((collection) => (
              <span
                key={collection}
                className={`rounded-md px-2 py-1 text-xs border ${
                  isDark
                    ? "border-slate-700 bg-slate-900 text-slate-300"
                    : "border-slate-200 bg-slate-50 text-slate-700"
                }`}
              >
                {collection}
              </span>
            ))}
          </div>
        </section>

        <ProcessingPanel processing={item.processing} isDark={isDark} />

        <section>
          <SectionHeader icon={FileAttachmentIcon} label="Assets" isDark={isDark} />
          <div className="space-y-2">
            {assets.length === 0 ? (
              <div className={`text-xs rounded-md border p-3 ${isDark ? "border-slate-800 text-slate-500" : "border-slate-200 text-slate-500"}`}>
                No attached asset
              </div>
            ) : (
              assets.map((asset) => (
                <AssetRow key={asset.id} asset={asset} isDark={isDark} />
              ))
            )}
          </div>
        </section>

        <div className={`pt-3 border-t ${border} grid grid-cols-2 gap-2`}>
          <ActionButton
            icon={ArrowReloadHorizontalIcon}
            label={busyAction === `retry:${item.id}` ? "Retrying" : "Retry"}
            isDark={isDark}
            disabled={busyAction !== null}
            onClick={() => actions.onRetryProcessing(item.id)}
          />
          <ActionButton
            icon={DatabaseSyncIcon}
            label={busyAction === `sync:${item.id}` ? "Syncing" : "Sync"}
            isDark={isDark}
            disabled={busyAction !== null}
            onClick={() => actions.onSyncToNotes(item.id)}
          />
          <ActionButton
            icon={Edit02Icon}
            label="Edit"
            isDark={isDark}
            disabled={busyAction !== null}
            onClick={() => actions.onUpdateMetadata(item.id, { title: item.title })}
          />
          <ActionButton
            icon={Download01Icon}
            label="Download"
            isDark={isDark}
            disabled={!primaryAsset?.storageUrl}
            onClick={() => {
              if (primaryAsset?.storageUrl) window.open(primaryAsset.storageUrl, "_blank", "noopener,noreferrer");
            }}
          />
        </div>

        <div className={`text-[11px] leading-relaxed ${muted}`}>
          Item id <span className="mono">{item.id}</span>
          {item.syncedNoteId ? (
            <>
              {" · "}note <span className="mono">{item.syncedNoteId}</span>
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function PreviewBlock({
  item,
  asset,
  isDark,
  compact,
}: {
  item: CatalogItem;
  asset?: CatalogAsset;
  isDark: boolean;
  compact: boolean;
}) {
  const tone = MODALITY_TONE[item.modality];
  const Icon = tone.icon;
  const height = compact ? "h-16" : "h-36";
  const base = isDark
    ? "bg-slate-950 border-slate-800"
    : "bg-slate-100 border-slate-200";

  if (item.modality === "image" && asset?.thumbnailUrl) {
    return (
      <div className={`${height} ${base} relative overflow-hidden`}>
        <img src={asset.thumbnailUrl} alt="" className="w-full h-full object-cover opacity-75" />
        <div className={`absolute inset-0 ${isDark ? "bg-slate-950/25" : "bg-white/10"}`} />
        <HugeiconsIcon icon={Icon} size={compact ? 20 : 28} className="absolute right-3 bottom-3 text-white drop-shadow" />
      </div>
    );
  }

  if (item.modality === "audio") {
    return (
      <div className={`${height} ${base} relative overflow-hidden flex items-center justify-center`}>
        <Waveform isDark={isDark} compact={compact} />
        <HugeiconsIcon icon={Icon} size={compact ? 18 : 28} className={`absolute left-3 top-3 ${isDark ? "text-lime-300" : "text-lime-700"}`} />
      </div>
    );
  }

  return (
    <div className={`${height} ${base} relative overflow-hidden flex items-center justify-center`}>
      <div
        className={`absolute inset-x-0 bottom-0 h-1/2 ${
          isDark
            ? "bg-[linear-gradient(180deg,transparent,rgba(15,23,42,0.9))]"
            : "bg-[linear-gradient(180deg,transparent,rgba(226,232,240,0.8))]"
        }`}
      />
      <div className={`w-12 h-12 rounded-lg border inline-flex items-center justify-center ${isDark ? tone.dark : tone.light}`}>
        <HugeiconsIcon icon={Icon} size={compact ? 20 : 28} />
      </div>
      {item.modality === "video" && (
        <div className={`absolute bottom-3 left-3 right-3 h-1.5 rounded-full overflow-hidden ${isDark ? "bg-slate-800" : "bg-slate-300"}`}>
          <div className="h-full w-2/5 bg-orange-400" />
        </div>
      )}
    </div>
  );
}

function Waveform({ isDark, compact }: { isDark: boolean; compact: boolean }) {
  const bars = compact ? [18, 26, 14, 32, 20, 28] : [22, 52, 34, 78, 42, 66, 28, 58, 36, 70, 30, 48];
  return (
    <div className="flex items-center gap-1.5">
      {bars.map((height, index) => (
        <span
          key={index}
          className={`w-1.5 rounded-full ${isDark ? "bg-lime-300/70" : "bg-lime-600/70"}`}
          style={{ height }}
        />
      ))}
    </div>
  );
}

function ProcessingPanel({ processing, isDark }: { processing: CatalogProcessing; isDark: boolean }) {
  return (
    <section>
      <SectionHeader icon={CloudUploadIcon} label="Processing" isDark={isDark} />
      <div
        className={`rounded-md border p-3 ${
          isDark ? "border-slate-800 bg-slate-900/40" : "border-slate-200 bg-slate-50"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <StatusBadge status={processing.status} isDark={isDark} />
          <span className={`text-[11px] mono truncate ${isDark ? "text-slate-500" : "text-slate-500"}`}>
            {processing.model}
          </span>
        </div>
        {processing.error && (
          <p className={`text-xs leading-relaxed mt-2 ${isDark ? "text-rose-300" : "text-rose-700"}`}>
            {processing.error}
          </p>
        )}
        {(processing.transcript || processing.extractedText) && (
          <p className={`text-xs leading-relaxed mt-2 line-clamp-4 ${isDark ? "text-slate-400" : "text-slate-600"}`}>
            {processing.transcript ?? processing.extractedText}
          </p>
        )}
      </div>
    </section>
  );
}

function AssetRow({ asset, isDark }: { asset: CatalogAsset; isDark: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${isDark ? "border-slate-800 bg-slate-900/40" : "border-slate-200 bg-slate-50"}`}>
      <div className="flex items-center gap-2">
        <HugeiconsIcon icon={FileAttachmentIcon} size={16} className={isDark ? "text-slate-500" : "text-slate-400"} />
        <div className="min-w-0 flex-1">
          <div className={`text-xs font-medium truncate ${isDark ? "text-slate-200" : "text-slate-800"}`}>
            {asset.filename}
          </div>
          <div className={`text-[11px] mono mt-0.5 ${isDark ? "text-slate-600" : "text-slate-400"}`}>
            {asset.contentType} · {formatBytes(asset.sizeBytes)}
            {asset.durationMs ? ` · ${formatDuration(asset.durationMs)}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  isDark,
  disabled,
  onClick,
}: {
  icon: any;
  label: string;
  isDark: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs transition-colors disabled:opacity-55 disabled:cursor-not-allowed ${
        isDark
          ? "border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800"
          : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
      }`}
    >
      <HugeiconsIcon icon={icon} size={15} />
      {label}
    </button>
  );
}

function StatusBadge({ status, isDark }: { status: CatalogStatus; isDark: boolean }) {
  const cfg = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] capitalize ${isDark ? cfg.dark : cfg.light}`}>
      <HugeiconsIcon icon={cfg.icon} size={11} />
      {status}
    </span>
  );
}

function TagStrip({ tags, isDark, limit }: { tags: string[]; isDark: boolean; limit: number }) {
  const shown = tags.slice(0, limit);
  const remaining = tags.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {shown.map((tag) => (
        <span
          key={tag}
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            isDark ? "bg-slate-800 text-slate-400" : "bg-slate-100 text-slate-600"
          }`}
        >
          {tag}
        </span>
      ))}
      {remaining > 0 && (
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${isDark ? "text-slate-600" : "text-slate-400"}`}>
          +{remaining}
        </span>
      )}
    </div>
  );
}

function MetaTile({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  return (
    <div className={`rounded-md border p-2.5 min-w-0 ${isDark ? "border-slate-800 bg-slate-900/40" : "border-slate-200 bg-slate-50"}`}>
      <div className={`text-[10px] uppercase ${isDark ? "text-slate-600" : "text-slate-400"}`}>
        {label}
      </div>
      <div className={`text-xs mt-1 truncate ${isDark ? "text-slate-300" : "text-slate-700"}`}>
        {value}
      </div>
    </div>
  );
}

function SectionHeader({ icon, label, isDark }: { icon: any; label: string; isDark: boolean }) {
  return (
    <div className={`flex items-center gap-2 text-xs font-semibold mb-2 ${isDark ? "text-slate-400" : "text-slate-600"}`}>
      <HugeiconsIcon icon={icon} size={14} />
      {label}
    </div>
  );
}

function CatalogLoading({ isDark }: { isDark: boolean }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3 p-4">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className={`rounded-lg overflow-hidden border ${isDark ? "border-slate-800 bg-slate-900/40" : "border-slate-200 bg-white"}`}>
          <div className={`h-36 shimmer ${isDark ? "bg-slate-900" : "bg-slate-100"}`} />
          <div className="p-3 space-y-2">
            <div className={`h-3 rounded shimmer ${isDark ? "bg-slate-800" : "bg-slate-100"}`} />
            <div className={`h-3 w-2/3 rounded shimmer ${isDark ? "bg-slate-800" : "bg-slate-100"}`} />
            <div className={`h-8 rounded shimmer ${isDark ? "bg-slate-800" : "bg-slate-100"}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

function CatalogState({
  isDark,
  icon,
  title,
  body,
}: {
  isDark: boolean;
  icon: any;
  title: string;
  body: string;
}) {
  return (
    <div className="h-full min-h-[360px] flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <div
          className={`mx-auto w-12 h-12 rounded-lg border flex items-center justify-center ${
            isDark
              ? "border-slate-800 bg-slate-900 text-slate-500"
              : "border-slate-200 bg-white text-slate-400"
          }`}
        >
          <HugeiconsIcon icon={icon} size={24} />
        </div>
        <div className={`mt-3 text-sm font-medium ${isDark ? "text-slate-200" : "text-slate-800"}`}>
          {title}
        </div>
        <p className={`mt-1 text-xs leading-relaxed ${isDark ? "text-slate-500" : "text-slate-500"}`}>
          {body}
        </p>
      </div>
    </div>
  );
}

function sourceLabel(source: CatalogSource): string {
  if (source === "imessage") return "iMessage";
  if (source === "dashboard_upload") return "Dashboard";
  return "Connector";
}

function notesSyncLabel(item: CatalogItem): string {
  if (item.notesSyncStatus === "synced") return "Synced";
  if (item.notesSyncStatus === "syncing") return "Syncing";
  if (item.notesSyncStatus === "failed") return "Failed";
  return "Not synced";
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.max(1, Math.round(diff / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

async function parseError(response: Response): Promise<string> {
  const json = await response.json().catch(() => null);
  if (json && typeof json.error === "string") return json.error;
  return `Request failed (${response.status})`;
}
