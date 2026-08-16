import {
  ARTIFACT_WORKPIECE_ACTIONS,
  artifactWorkpieceExports,
  isArtifactWorkpieceState,
  type ArtifactDescriptor,
  type ArtifactWorkpieceDescriptor,
  type ArtifactWorkpieceKind,
  type ArtifactWorkpieceResult,
  type ArtifactWorkpieceState,
} from "@skynet/artifact-workspace";

export { ARTIFACT_WORKPIECE_ACTIONS, artifactWorkpieceExports };

export type {
  ArtifactDescriptor,
  ArtifactPresentationSlide,
  ArtifactWorkpieceAction,
  ArtifactWorkpieceDescriptor,
  ArtifactWorkpieceKind,
  ArtifactWorkpieceResult,
  ArtifactWorkpieceState,
} from "@skynet/artifact-workspace";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function decodeWorkpiece(value: unknown): ArtifactWorkpieceDescriptor | null {
  const item = record(value);
  if (!item) return null;
  if (
    item.kind !== "document" &&
    item.kind !== "spreadsheet" &&
    item.kind !== "presentation" &&
    item.kind !== "pdf"
  ) return null;
  if (
    typeof item.source_version !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.source_version) ||
    typeof item.state_url !== "string" ||
    !item.state_url ||
    !Number.isSafeInteger(item.state_revision) ||
    Number(item.state_revision) < 0
  ) {
    return null;
  }

  const actions = ARTIFACT_WORKPIECE_ACTIONS.filter((action) =>
    Array.isArray(item.actions) && item.actions.includes(action)
  );
  const expectedExports = artifactWorkpieceExports(item.kind);
  const exportMetadata = typeof item.export_url === "string" && !!item.export_url &&
    Array.isArray(item.exports) &&
    JSON.stringify(item.exports) === JSON.stringify(expectedExports)
    ? { export_url: item.export_url, exports: expectedExports }
    : null;
  const normalizedActions = exportMetadata && !actions.includes("export")
    ? [...actions, "export" as const]
    : actions.filter((action) => action !== "export" || !!exportMetadata);

  return {
    kind: item.kind,
    source_version: item.source_version,
    state_revision: Number(item.state_revision),
    state_url: item.state_url,
    actions: normalizedActions,
    ...(exportMetadata ?? {}),
  } as ArtifactWorkpieceDescriptor;
}

export function decodeWorkpieceState<Kind extends ArtifactWorkpieceKind>(
  kind: Kind,
  value: unknown,
): ArtifactWorkpieceState<Kind> | null | undefined {
  if (value === null) return null;
  return isArtifactWorkpieceState(kind, value) ? value : undefined;
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
  return state === undefined ? null : { workpiece, state } as ArtifactWorkpieceResult;
}
