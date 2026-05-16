/** Durable artifact wire contract shared by every Skynet UI consumer. Bytes
 * remain out of band; these descriptors carry tenant-authorized content URLs. */
export interface ArtifactDescriptor {
  readonly id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly name: string;
  readonly source_path: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly created_at: string;
  readonly preview_url: string;
  readonly download_url: string;
  readonly workpiece: ArtifactWorkpieceDescriptor | null;
}

export type ArtifactWorkpieceKind = "document" | "spreadsheet";
export type ArtifactWorkpieceState = Readonly<{ text: string }> | Readonly<{ csv: string }>;

export interface ArtifactWorkpieceDescriptor {
  readonly kind: ArtifactWorkpieceKind;
  /** Immutable source identity. A changed source produces a new artifact digest. */
  readonly source_version: string;
  readonly state_revision: number;
  readonly state_url: string;
  readonly actions: readonly ["preview", "download", "edit"];
}

export interface ArtifactWorkpieceResult {
  readonly workpiece: ArtifactWorkpieceDescriptor;
  readonly state: ArtifactWorkpieceState | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeWorkpiece(value: unknown): ArtifactWorkpieceDescriptor | null {
  const item = record(value);
  if (!item) return null;
  if (item.kind !== "document" && item.kind !== "spreadsheet") return null;
  if (
    typeof item.source_version !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.source_version) ||
    typeof item.state_url !== "string" ||
    !item.state_url ||
    !Number.isSafeInteger(item.state_revision) ||
    Number(item.state_revision) < 0 ||
    !Array.isArray(item.actions) ||
    item.actions.join(",") !== "preview,download,edit"
  ) {
    return null;
  }
  return item as unknown as ArtifactWorkpieceDescriptor;
}

function decodeWorkpieceState(
  kind: ArtifactWorkpieceKind,
  value: unknown,
): ArtifactWorkpieceState | null | undefined {
  if (value === null) return null;
  const item = record(value);
  if (!item) return undefined;
  const key = kind === "spreadsheet" ? "csv" : "text";
  const entries = Object.entries(item);
  return entries.length === 1 && entries[0]?.[0] === key && typeof entries[0][1] === "string"
    ? (item as ArtifactWorkpieceState)
    : undefined;
}

export function decodeArtifact(value: unknown): ArtifactDescriptor | null {
  const item = record(value);
  if (!item) return null;
  const requiredStrings = [
    "id",
    "run_id",
    "thread_id",
    "name",
    "source_path",
    "content_type",
    "sha256",
    "created_at",
    "preview_url",
    "download_url",
  ] as const;
  if (requiredStrings.some((key) => typeof item[key] !== "string" || !item[key])) {
    return null;
  }
  if (!Number.isSafeInteger(item.size_bytes) || Number(item.size_bytes) < 0) return null;
  const workpiece = item.workpiece === null || item.workpiece === undefined
    ? null
    : decodeWorkpiece(item.workpiece);
  if (item.workpiece !== null && item.workpiece !== undefined && !workpiece) return null;
  return { ...(item as unknown as Omit<ArtifactDescriptor, "workpiece">), workpiece };
}

export function decodeArtifactList(value: unknown): ArtifactDescriptor[] | null {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.artifacts)) return null;
  const parsed = envelope.artifacts.map(decodeArtifact);
  return parsed.every((item): item is ArtifactDescriptor => item !== null) ? parsed : null;
}

export function decodeArtifactResult(
  value: unknown,
): { artifact: ArtifactDescriptor; created?: boolean } | null {
  const envelope = record(value);
  const artifact = decodeArtifact(envelope?.artifact);
  if (!artifact) return null;
  if (envelope && "created" in envelope && typeof envelope.created !== "boolean") return null;
  return {
    artifact,
    ...(typeof envelope?.created === "boolean" ? { created: envelope.created } : {}),
  };
}

export function decodeWorkpieceResult(value: unknown): ArtifactWorkpieceResult | null {
  const envelope = record(value);
  const workpiece = decodeWorkpiece(envelope?.workpiece);
  if (!workpiece || !envelope || !("state" in envelope)) return null;
  const state = decodeWorkpieceState(workpiece.kind, envelope.state);
  return state === undefined ? null : { workpiece, state };
}
