import { basename } from "node:path";
import type { GatewayCompletionEffect } from "./descriptor";

export interface ResolvedCompletionEffect {
  readonly requirement: "artifact_create" | "artifact_update";
  readonly authority: "artifact_store" | "workpiece_store";
  readonly targetArtifactId: string | null;
  readonly candidateName: string | null;
}

function stringArgument(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeCandidateName(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized.length <= 255 &&
      !/[\/\\\u0000-\u001f\u007f]/u.test(normalized) &&
      !/^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)
    ? normalized
    : null;
}

export function completionEffectForCall(
  effect: GatewayCompletionEffect,
  args: Record<string, unknown>,
): ResolvedCompletionEffect | null {
  if (effect.kind === "artifact_update") {
    const targetArtifactId = stringArgument(args, effect.targetArtifactArgument);
    if (!targetArtifactId) return null;
    return {
      requirement: "artifact_update",
      authority: effect.authority,
      targetArtifactId,
      candidateName: null,
    };
  }
  if (effect.kind === "artifact_publish") {
    const targetArtifactId = stringArgument(args, effect.updateTargetArgument);
    const explicitName = stringArgument(args, "name");
    const path = stringArgument(args, "path");
    return {
      requirement: targetArtifactId ? "artifact_update" : "artifact_create",
      authority: effect.authority,
      targetArtifactId,
      candidateName: safeCandidateName(explicitName ?? (path ? basename(path) : null)),
    };
  }
  return {
    requirement: "artifact_create",
    authority: effect.authority,
    targetArtifactId: null,
    candidateName: safeCandidateName(stringArgument(args, "name")),
  };
}
