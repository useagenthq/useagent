/**
 * Knowledge data model + view-model mappers.
 *
 * The page is wired to the backend at `/api/knowledge`, whose records carry a
 * distillation `kind` (qa / reference / policy / definition / decision /
 * outcome), a `title`/`body`, and flattened distilled meta (summary, question,
 * source, confidence, entities, refs). Real records map into the normalized
 * {@link KnowledgeItem} the gallery renders. When the backend is unreachable
 * the page falls back to {@link mockKnowledgeItems} — deliberately empty, so
 * the fallback is an honest empty state, never fabricated content.
 */

import type { ChipProps } from "@/components/base/badges/chip";
import { relativeTime } from "@/utils/format";

/* -------------------------------------------------------------------------- */
/*  Chip color union (legacy Badge hues — the skills page still maps            */
/*  its tag palette through this union, so the type stays exported here)        */
/* -------------------------------------------------------------------------- */

/** The subset of Badge colors shared tag palettes are keyed on. */
export type ChipColor =
  | "gray"
  | "blue"
  | "orange"
  | "red"
  | "green"
  | "yellow"
  | "purple"
  | "sky"
  | "pink"
  | "teal";

/* -------------------------------------------------------------------------- */
/*  Backend contract                                                            */
/* -------------------------------------------------------------------------- */

export type RecordKind =
  | "qa"
  | "reference"
  | "policy"
  | "definition"
  | "decision"
  | "outcome";

/**
 * Shape of a single record from `GET /api/knowledge` (backend `toApi` in
 * backend/src/knowledge/routes.ts flattens the useful distilled meta to the
 * top level). The original ingest contract nested `domain` /
 * `connector_instance_id` / `source_type` under `meta`, so the mapper
 * tolerates both.
 */
export interface KnowledgeRecord {
  id: string;
  kind: RecordKind;
  title: string;
  body: string;
  refs?: string[];
  domain?: string | null;
  connector_instance_id?: string | null;
  source_type?: string | null;
  source_url?: string | null;
  summary?: string | null;
  question?: string | null;
  confidence?: number | null;
  entities?: string[];
  meta?: {
    source_type?: string;
    connector_instance_id?: string;
    domain?: string;
    [key: string]: unknown;
  };
  pinned?: boolean;
  created_at?: string;
}

/** A single ranked hit from `POST /api/knowledge/search`. */
export interface SearchResult {
  rank: number;
  text: string;
  citation: string;
  id: string;
  kind?: RecordKind;
  title: string;
}

/* -------------------------------------------------------------------------- */
/*  View model                                                                  */
/* -------------------------------------------------------------------------- */

/** Normalized row model — both real records and the mock seed map into this. */
export interface KnowledgeItem {
  id: string;
  title: string;
  /** Optional "when to recall" line — present on mock seeds, omitted on records. */
  trigger?: string;
  body: string;
  /** Folder label source: `domain ?? connector_instance_id` for records. */
  folder: string;
  kind?: RecordKind;
  updated: string;
  pinned: boolean;
  /** Distilled one-line summary, when the distiller produced one. */
  summary?: string;
  /** The distilled question (qa records). */
  question?: string;
  sourceType?: string;
  sourceUrl?: string;
  connectorId?: string;
  confidence?: number;
  refs?: string[];
  entities?: string[];
}

/* -------------------------------------------------------------------------- */
/*  Colors                                                                      */
/* -------------------------------------------------------------------------- */

/** Kind → BoardUI Chip color, one distinct hue per RecordKind. */
export const kindChipColor: Record<
  RecordKind,
  NonNullable<ChipProps["color"]>
> = {
  qa: "blue",
  reference: "cyan",
  policy: "purple",
  definition: "lime",
  decision: "yellow",
  outcome: "rose",
};

/** User-facing label for a persisted knowledge folder key. */
export function knowledgeFolderLabel(folder: string): string {
  return folder === "skynet-app" ? "useAgent" : folder;
}

/** Row-safe display copy that leaves the stored item and folder key unchanged. */
export function knowledgeItemForDisplay(item: KnowledgeItem): KnowledgeItem {
  return { ...item, folder: knowledgeFolderLabel(item.folder) };
}

/* -------------------------------------------------------------------------- */
/*  Mappers                                                                     */
/* -------------------------------------------------------------------------- */

/** Map a backend record into the normalized row model. */
export function recordToItem(record: KnowledgeRecord): KnowledgeItem {
  const folder =
    record.domain ??
    record.meta?.domain ??
    record.connector_instance_id ??
    record.meta?.connector_instance_id ??
    "Ungrouped";
  return {
    id: record.id,
    title: record.title,
    body: record.body,
    folder,
    kind: record.kind,
    updated: relativeTime(record.created_at),
    pinned: Boolean(record.pinned),
    summary: record.summary ?? undefined,
    question: record.question ?? undefined,
    sourceType: record.source_type ?? record.meta?.source_type ?? undefined,
    sourceUrl: record.source_url ?? undefined,
    connectorId:
      record.connector_instance_id ??
      record.meta?.connector_instance_id ??
      undefined,
    confidence: record.confidence ?? undefined,
    refs: record.refs?.length ? record.refs : undefined,
    entities: record.entities?.length ? record.entities : undefined,
  };
}

/* -------------------------------------------------------------------------- */
/*  Fallback                                                                    */
/* -------------------------------------------------------------------------- */

/** Default folder options offered by the add-knowledge modal, unioned with the
 *  folders present in real records. */
export const seedFolders = ["Global", "skynet-app"];

/**
 * SSR fallback used only while the backend is unreachable. Intentionally empty:
 * the gallery renders its honest "No knowledge yet" empty state and self-heals
 * via a client refetch once the backend responds. Never seed demo content here.
 */
export const mockKnowledgeItems: KnowledgeItem[] = [];
