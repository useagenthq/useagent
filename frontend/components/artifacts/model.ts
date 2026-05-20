import {
  artifactActionContractFor,
  artifactExtensionLabel,
  artifactSurfaceCategoryFor,
  type ArtifactSurfaceCategory,
} from "@skynet/artifact-workspace";
import {
  decodeArtifactResult,
  decodeArtifactList,
  type ArtifactDescriptor,
} from "@skynet/agent-client";

export type { ArtifactDescriptor } from "@skynet/agent-client";
export type ArtifactCategory = ArtifactSurfaceCategory;

export function extractArtifacts(value: unknown): ArtifactDescriptor[] | null {
  return decodeArtifactList(value);
}

export function extractArtifactResult(value: unknown): ArtifactDescriptor | null {
  return decodeArtifactResult(value)?.artifact ?? null;
}

export function artifactViewFor(artifact: ArtifactDescriptor) {
  return {
    category: artifactSurfaceCategoryFor(artifact),
    extension: artifactExtensionLabel(artifact.name),
    ...artifactActionContractFor(artifact),
  };
}

export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (const next of units.slice(1)) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

export function formatArtifactDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
