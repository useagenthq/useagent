import type { ContextProjection } from "../store";
import type { CodeRecord } from "./extractor";

// ---------------------------------------------------------------------------
// Code projector - turns an extracted, redacted CodeRecord into a context_index
// projection of kind="code". Pure (no DB): the sweep upserts the result.
//
// source_ref is the stable typed pointer, carrying full provenance so context_read
// can re-fetch the exact cited excerpt from the repo at that commit:
//   code:<owner/name>@<sha>:<file>#L<line>
// e.g. "code:upstream-org/loop-dns@<sha>:workers/functions-proxy/src/index.ts#L17"
// ---------------------------------------------------------------------------

export interface CodeProvenance {
  /** "owner/name" of the source repo. */
  repo: string;
  /** The commit sha the extraction was pinned to. */
  commitSha: string;
}

/** Build the typed provenance source_ref for a code record. */
export function codeSourceRef(prov: CodeProvenance, record: CodeRecord): string {
  return `code:${prov.repo}@${prov.commitSha}:${record.file}#L${record.line}`;
}

/** Parsed pieces of a `code:` source_ref, or null when malformed. */
export interface ParsedCodeRef {
  repo: string;
  commitSha: string;
  file: string;
  line: number;
}

/** Parse "code:<repo>@<sha>:<file>#L<line>" back into its parts. Fails closed on
 *  anything malformed (context_read refuses it). */
export function parseCodeRef(ref: string): ParsedCodeRef | null {
  if (!ref.startsWith("code:")) return null;
  const rest = ref.slice("code:".length);
  const at = rest.indexOf("@");
  if (at <= 0) return null;
  const repo = rest.slice(0, at);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) return null;
  const afterAt = rest.slice(at + 1);
  const colon = afterAt.indexOf(":");
  if (colon <= 0) return null;
  const commitSha = afterAt.slice(0, colon);
  if (!/^[0-9a-f]{7,40}$/.test(commitSha)) return null;
  const fileAndLine = afterAt.slice(colon + 1);
  const hash = fileAndLine.lastIndexOf("#L");
  if (hash <= 0) return null;
  const file = fileAndLine.slice(0, hash);
  const line = Number(fileAndLine.slice(hash + 2));
  if (!file || !Number.isInteger(line) || line < 1) return null;
  return { repo, commitSha, file, line };
}

/** Project one extracted record into a context_index upsert payload. The title
 *  carries the repo so a search hit reads self-describingly. */
export function projectCode(prov: CodeProvenance, record: CodeRecord): ContextProjection {
  return {
    orgId: "", // filled by the sweep (org is deployment config, not per-record)
    kind: "code",
    title: `${record.title} (${prov.repo})`,
    searchableText: record.searchableText,
    sourceRef: codeSourceRef(prov, record),
    sourceKindId: `${prov.repo}:${record.file}`,
    version: null,
    embedding: null,
  };
}
