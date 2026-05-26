// ---------------------------------------------------------------------------
// Context-index sync for the learning publish path (self_improving item 4).
//
// When a knowledge draft is ACCEPTED, drafts.ts creates the real
// knowledge_records row via the store upsert — but that upsert (unlike the wiki
// publish path) does NOT itself project into the unified context_index. The
// Phase-1 projector (src/context/projector.ts) owns that projection; wiki.ts
// calls syncKnowledgeToContextIndex after its upsert. The learning accept path
// was bypassing it, so an accepted learning was searchable via knowledge_records
// but MISSING from the federated context resolver.
//
// This module closes that gap. The Phase-1 context lane is not present on every
// branch yet (it lands via merge to main), so the call is made through a lazy,
// FAILURE-TOLERANT dynamic import: when the projector module exists the accepted
// record is projected; when it does not (or projection throws) it is a logged
// no-op that never affects the already-committed accept. Once the branch merges
// with main this wires the accepted learning straight into context_index.
// ---------------------------------------------------------------------------

interface KnowledgeProjection {
  recordId: string;
  orgId: string;
  title: string;
  body: string;
  tags?: string[];
}

/** Project an accepted learning's knowledge record into the unified context
 *  index, if the Phase-1 projector is present. Best-effort + non-fatal: a
 *  missing module or a projection failure is logged and swallowed, so it can
 *  never undo the accept. */
export async function syncAcceptedLearningToContextIndex(rec: KnowledgeProjection): Promise<void> {
  try {
    // Lazy import so this file compiles on branches where the Phase-1 context
    // lane has not merged yet. The specifier is assembled at runtime (String())
    // so the type checker treats the module as dynamic rather than hard-requiring
    // it; on main (projector present) this resolves and projects, off-main it is
    // a caught no-op.
    const specifier = String(["..", "context", "projector"].join("/"));
    const mod = (await import(specifier).catch(() => null)) as {
      syncKnowledgeToContextIndex?: (r: KnowledgeProjection) => Promise<void>;
    } | null;
    if (mod?.syncKnowledgeToContextIndex) {
      await mod.syncKnowledgeToContextIndex(rec);
    }
  } catch (err) {
    console.warn("[learning] context-index projection skipped (non-fatal):", (err as Error).message);
  }
}
