export const CANONICAL_SANDBOX_RUN_LABEL = "useagent-run";
export const LEGACY_SANDBOX_RUN_LABEL = "skynet-run";
export const CANONICAL_SANDBOX_GENERATION_LABEL = "useagent-provider-generation";
export const LEGACY_SANDBOX_GENERATION_LABEL = "skynet-provider-generation";

export interface CompatibleSandboxLabel {
  readonly value: string | null;
  readonly conflict: boolean;
}

export function readCompatibleSandboxLabel(
  labels: Readonly<Record<string, string>>,
  canonicalKey: string,
  legacyKey: string,
): CompatibleSandboxLabel {
  const canonical = labels[canonicalKey];
  const legacy = labels[legacyKey];
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    return { value: null, conflict: true };
  }
  return { value: canonical ?? legacy ?? null, conflict: false };
}

export function readSandboxRunLabel(
  labels: Readonly<Record<string, string>>,
): CompatibleSandboxLabel {
  return readCompatibleSandboxLabel(
    labels,
    CANONICAL_SANDBOX_RUN_LABEL,
    LEGACY_SANDBOX_RUN_LABEL,
  );
}
