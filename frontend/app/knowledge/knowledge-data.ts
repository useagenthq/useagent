/**
 * Knowledge data model + view-model mappers.
 *
 * The page is wired to the backend at `/api/knowledge`, whose records carry a
 * distillation `kind` (qa / reference / policy / definition / decision /
 * outcome), a `title`/`body`, and a `meta` blob. Real records map into the
 * normalized {@link KnowledgeItem} the gallery renders. When the backend is
 * unreachable the page falls back to {@link mockKnowledgeItems} — deliberately
 * empty, so the fallback is an honest empty state, never fabricated content.
 */

import { relativeTime } from "@/utils/format";

/* -------------------------------------------------------------------------- */
/*  Chip color union (a semantic hue mapped onto an AlignUI Badge color)        */
/* -------------------------------------------------------------------------- */

/** The subset of AlignUI Badge colors we drive chips with. */
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
 * Shape of a single record from `GET /api/knowledge`. The store returns the
 * source fields flat (top-level `domain` / `connector_instance_id` /
 * `created_at`); the original ingest contract nested them under `meta`, so the
 * mapper tolerates both.
 */
export interface KnowledgeRecord {
  id: string;
  kind: RecordKind;
  title: string;
  body: string;
  refs?: string[];
  domain?: string;
  connector_instance_id?: string;
  source_type?: string;
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

/** Normalized card model — both real records and the mock seed map into this. */
export interface KnowledgeItem {
  id: string;
  title: string;
  /** Optional "when to recall" line — present on mock seeds, omitted on records. */
  trigger?: string;
  body: string;
  /** Folder chip label: `meta.domain ?? connector_instance_id` for records. */
  folder: string;
  kind?: RecordKind;
  updated: string;
  pinned: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Colors                                                                      */
/* -------------------------------------------------------------------------- */

/** Kind → Badge color, one distinct hue per RecordKind. */
export const kindChipColor: Record<RecordKind, ChipColor> = {
  qa: "blue",
  reference: "sky",
  policy: "purple",
  definition: "green",
  decision: "yellow",
  outcome: "red",
};

const folderPalette: ChipColor[] = [
  "purple",
  "blue",
  "sky",
  "green",
  "yellow",
  "red",
];

/** Stable colors for the seed folders so the fallback reads as before. */
const knownFolderColor: Record<string, ChipColor> = {
  Global: "purple",
  "skynet-app": "blue",
};

/** Deterministic Badge color for an arbitrary folder / domain name. */
export function folderChipColor(folder: string): ChipColor {
  if (folder in knownFolderColor) return knownFolderColor[folder];
  let hash = 0;
  for (let i = 0; i < folder.length; i++) {
    hash = (hash * 31 + folder.charCodeAt(i)) >>> 0;
  }
  return folderPalette[hash % folderPalette.length];
}

/* -------------------------------------------------------------------------- */
/*  Mappers                                                                     */
/* -------------------------------------------------------------------------- */

/** Map a backend record into the normalized card model. */
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
