/**
 * Knowledge data model + view-model mappers.
 *
 * The page is wired to the backend at `/api/knowledge`, whose records carry a
 * distillation `kind` (qa / reference / policy / definition / decision /
 * outcome), a `title`/`body`, and a `meta` blob. Real records map into the
 * normalized {@link KnowledgeItem} the gallery renders. When the backend is
 * unreachable the page falls back to {@link mockKnowledgeItems} so it never
 * looks broken — the mock copy still describes this very codebase (AlignUI).
 */

import { relativeTime } from "@/utils/format";

/* -------------------------------------------------------------------------- */
/*  Chip color union (maps a BoardUI-style hue onto an AlignUI Badge color)     */
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
  "Growth Operator": "sky",
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
/*  Mock fallback                                                               */
/* -------------------------------------------------------------------------- */

/** Folder options offered by the add-knowledge modal before any real data. */
export const seedFolders = ["Global", "skynet-app", "Growth Operator"];

export const mockKnowledgeItems: KnowledgeItem[] = [
  {
    id: "alignui-tokens",
    title: "AlignUI tokens are the only styling primitive",
    trigger: "When writing or reviewing any component styling",
    body: "Style exclusively with the semantic theme tokens from app/globals.css — bg-bg-white-0, text-text-strong-950, ring-stroke-soft-200. Never reach for raw hex or Tailwind color literals, and skip dark: prefixes: the .dark class strategy remaps every token for you.",
    folder: "Global",
    updated: "2d ago",
    pinned: true,
  },
  {
    id: "reuse-base-kit",
    title: "Reuse the base kit before building anything new",
    trigger: "When you need an input, button, badge, select, switch, or modal",
    body: "Every primitive already lives in components/ui. Import Button, Input, Badge, Select, and Switch instead of re-implementing them — a parallel near-duplicate is a review blocker. Search the kit first, then extend it if a variant is genuinely missing.",
    folder: "Global",
    updated: "4d ago",
    pinned: true,
  },
  {
    id: "semantic-colors",
    title: "Semantic colors only — never raw hex",
    trigger: "When choosing a color for a background, text, border, or status",
    body: "Map every color to a semantic token so light and dark both resolve. The status tokens (success, warning, error, feature, verified) already carry their own light+dark pairs — prefer the Badge color prop over hand-rolled color classes.",
    folder: "Global",
    updated: "6d ago",
    pinned: false,
  },
  {
    id: "remix-icons",
    title: "Icons come from @remixicon/react only",
    trigger: "When adding an icon to any surface",
    body: "Pass the component reference (RiSearchLine), never a rendered <RiSearchLine />, and let the consuming primitive size it. No inline SVGs and no second icon pack — consistency across the shell depends on a single source.",
    folder: "Global",
    updated: "1w ago",
    pinned: false,
  },
  {
    id: "app-shell-frame",
    title: "AppShell is the page-frame contract",
    trigger: "When scaffolding a new route under app/",
    body: "Wrap the page in <AppShell activeTab=… sidebar={…}>. It renders TopNav + the sidebar + a scrollable main on the rounded bg-bg-weak-50 canvas. Don't rebuild the frame per page — pass a sidebar and let the shell own the chrome.",
    folder: "skynet-app",
    updated: "3d ago",
    pinned: false,
  },
  {
    id: "rebrand-skynet",
    title: "Rebrand every legacy 'Alpaca' / 'OpenClaw' string",
    trigger: "When you see old product naming in copy, metadata, or seed data",
    body: "The inspiration deck ships as 'Alpaca Super Computer' with openclaw references; our product is Skynet. Replace every visible occurrence — headings, metadata titles, and mock data — so nothing leaks the source branding.",
    folder: "skynet-app",
    updated: "5d ago",
    pinned: false,
  },
  {
    id: "client-boundary",
    title: "Keep 'use client' at the interactive leaf",
    trigger: "When a page needs state, effects, or event handlers",
    body: "Leave page.tsx as a server component for metadata and the shell, then push 'use client' down into the colocated interactive piece (search, modal, filters). This mirrors app/apps and app/artifacts and keeps the route payload lean.",
    folder: "skynet-app",
    updated: "1w ago",
    pinned: false,
  },
  {
    id: "run-trace-timeline",
    title: "Run traces read as a vertical timeline",
    trigger: "When rendering an agent run or tool log",
    body: "Follow the run-trace convention: a summary header (tools / files / commands + elapsed time), then a vertical timeline of steps with command and file chips, a JSON block with a Copy affordance, and a Done check to close it out.",
    folder: "Growth Operator",
    updated: "2d ago",
    pinned: false,
  },
  {
    id: "pipeline-fan-out",
    title: "Pipeline stages fan out — no barrier by default",
    trigger: "When wiring a multi-step agent workflow",
    body: "Prefer pipelining each item through all stages independently over synchronized barriers. Only collect every result at once when a stage genuinely needs cross-item context — dedup before expensive work, or an early-exit when the count is zero.",
    folder: "Growth Operator",
    updated: "8d ago",
    pinned: false,
  },
  {
    id: "status-dots-recents",
    title: "Recents use colored status dots for live runs",
    trigger: "When listing sessions in the agent sidebar",
    body: "Active runs get a status dot (indigo for in-flight); idle entries fall back to a hollow neutral ring. Keep the tone list in sync with the run state so the sidebar reads as a live queue, not a static menu.",
    folder: "Growth Operator",
    updated: "9d ago",
    pinned: false,
  },
];
