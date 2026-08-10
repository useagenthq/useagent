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
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  return item as unknown as ArtifactDescriptor;
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
