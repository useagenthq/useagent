/**
 * Memory Hub data model + view helpers.
 *
 * The page is wired to `/api/memory`, the human control surface over the
 * team-memory pools (TencentDB MemoryCore) plus our own capture outbox and
 * retrieval ledger. Every shape here mirrors a real backend response; nothing is
 * fabricated. When the backend is unreachable the page surfaces a distinct error
 * state, never a fake "empty" that hides an outage.
 */

import { RiTeamLine, RiUser3Line, type RemixiconComponentType } from "@remixicon/react";

/* -------------------------------------------------------------------------- */
/*  Scope                                                                       */
/* -------------------------------------------------------------------------- */

export type MemoryScope = "org" | "personal";

/** The two scope tabs, mirroring the composer's MemoryScopePicker grammar. */
export const SCOPE_META: Record<
  MemoryScope,
  { label: string; short: string; hint: string; tag: string; icon: RemixiconComponentType }
> = {
  org: {
    label: "Organization memory",
    short: "Organization",
    hint: "Shared team memory - every member recalls it",
    tag: "org",
    icon: RiTeamLine,
  },
  personal: {
    label: "Personal memory",
    short: "Personal",
    hint: "Your private memory, plus organization memory",
    tag: "personal",
    icon: RiUser3Line,
  },
};

export const SCOPES: MemoryScope[] = ["org", "personal"];

/* -------------------------------------------------------------------------- */
/*  Recall (search) + stored memory (browse)                                    */
/* -------------------------------------------------------------------------- */

export interface MemoryCitation {
  provider: string;
  assetId: string;
  score?: number;
}

/** One ranked recall hit from GET /api/memory/search. */
export interface RecallItem {
  content: string;
  sourceScope: MemoryScope;
  citation: MemoryCitation;
}

export interface SearchResponse {
  enabled: boolean;
  scope: MemoryScope;
  authed: boolean;
  items: RecallItem[];
  truncated?: boolean;
  latencyMs?: number;
  failedClosed?: boolean;
}

/** One stored L1 fact from GET /api/memory/browse. */
export interface StoredMemory {
  id: string;
  type: string;
  content: string;
  background?: string;
  sourceScope: MemoryScope;
  citation: MemoryCitation;
  createdAt: string;
  updatedAt: string;
}

export interface BrowseResponse {
  enabled: boolean;
  scope: MemoryScope;
  authed: boolean;
  items: StoredMemory[];
  total: number;
  failedClosed?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Capture outbox (inspect + operate)                                          */
/* -------------------------------------------------------------------------- */

export type CaptureState = "pending" | "delivering" | "delivered" | "dead";

export interface CaptureRow {
  runId: string;
  state: CaptureState;
  scope: MemoryScope | null;
  promptPreview: string;
  summaryPreview: string;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
}

/** The subset of AlignUI Badge colors we drive state chips with. */
export type ChipColor = "gray" | "blue" | "orange" | "green" | "red";

/** One capture state, rendered as a labeled chip. `delivering` reads as an
 *  orphan candidate (the happy-path window is milliseconds, so a row shown here
 *  is awaiting the documented manual inspection). */
export const CAPTURE_STATE_META: Record<
  CaptureState,
  { label: string; color: ChipColor; note: string }
> = {
  delivered: { label: "Delivered", color: "green", note: "Written to team memory." },
  pending: { label: "Pending", color: "blue", note: "Queued for delivery with backoff." },
  delivering: {
    label: "Delivering",
    color: "orange",
    note: "In flight - a row that lingers here is a crash orphan awaiting manual inspection (at-most-once).",
  },
  dead: { label: "Dead", color: "red", note: "Delivery failed after max attempts." },
};

/* -------------------------------------------------------------------------- */
/*  Retrieval ledger (recently recalled)                                        */
/* -------------------------------------------------------------------------- */

export interface RecallLedgerRow {
  runId: string;
  threadId: string;
  memoryScope: MemoryScope;
  query: string;
  itemCount: number;
  items: { content: string; sourceScope: MemoryScope }[];
  latencyMs: number;
  truncated: boolean;
  createdAt: string;
}
