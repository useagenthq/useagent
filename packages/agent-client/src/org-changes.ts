import {
  decodeProviderConnectionChange,
  type ProviderConnectionChange,
} from "./provider-connections";
import {
  decodeIntegrationConnectionChange,
  type IntegrationConnectionChange,
} from "./integrations";

export const RUN_CHANGE_ACTIONS = ["created", "running", "settled", "cancelled"] as const;
export type RunChangeAction = (typeof RUN_CHANGE_ACTIONS)[number];

// "created"/"updated" mean mainline changed; "proposed" means an agent proposal
// lane changed (a proposal appeared or was dismissed) while mainline is untouched.
export const ARTIFACT_CHANGE_ACTIONS = ["created", "updated", "proposed"] as const;
export type ArtifactChangeAction = (typeof ARTIFACT_CHANGE_ACTIONS)[number];

export const AUTOMATION_CHANGE_ACTIONS = ["created", "updated", "deleted", "fired"] as const;
export type AutomationChangeAction = (typeof AUTOMATION_CHANGE_ACTIONS)[number];

export interface RunOrgChange {
  readonly type: "run";
  readonly action: RunChangeAction;
  readonly runId: string;
  readonly threadId: string;
}

export interface ArtifactOrgChange {
  readonly type: "artifact";
  readonly action: ArtifactChangeAction;
  readonly artifactId: string;
  readonly runId: string;
  readonly threadId: string;
}

export type AutomationOrgChange =
  | {
      readonly type: "automation";
      readonly action: Exclude<AutomationChangeAction, "fired">;
      readonly automationId: string;
    }
  | {
      readonly type: "automation";
      readonly action: "fired";
      readonly automationId: string;
      readonly runId: string;
    };

/** Complete browser-visible org invalidation wire contract. */
export type OrgChange =
  | RunOrgChange
  | ArtifactOrgChange
  | AutomationOrgChange
  | IntegrationConnectionChange
  | ProviderConnectionChange;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunChangeAction(value: unknown): value is RunChangeAction {
  return typeof value === "string" && (RUN_CHANGE_ACTIONS as readonly string[]).includes(value);
}

function isArtifactChangeAction(value: unknown): value is ArtifactChangeAction {
  return (
    typeof value === "string" && (ARTIFACT_CHANGE_ACTIONS as readonly string[]).includes(value)
  );
}

function isAutomationChangeAction(value: unknown): value is AutomationChangeAction {
  return (
    typeof value === "string" && (AUTOMATION_CHANGE_ACTIONS as readonly string[]).includes(value)
  );
}

export function decodeOrgChange(value: unknown): OrgChange | null {
  if (!isRecord(value)) return null;

  if (
    value.type === "run" &&
    isRunChangeAction(value.action) &&
    typeof value.runId === "string" &&
    typeof value.threadId === "string"
  ) {
    return {
      type: value.type,
      action: value.action,
      runId: value.runId,
      threadId: value.threadId,
    };
  }

  if (
    value.type === "artifact" &&
    isArtifactChangeAction(value.action) &&
    typeof value.artifactId === "string" &&
    typeof value.runId === "string" &&
    typeof value.threadId === "string"
  ) {
    return {
      type: value.type,
      action: value.action,
      artifactId: value.artifactId,
      runId: value.runId,
      threadId: value.threadId,
    };
  }

  if (
    value.type === "automation" &&
    isAutomationChangeAction(value.action) &&
    typeof value.automationId === "string"
  ) {
    if (value.action === "fired") {
      if (typeof value.runId !== "string") return null;
      return {
        type: value.type,
        action: value.action,
        automationId: value.automationId,
        runId: value.runId,
      };
    }
    return {
      type: value.type,
      action: value.action,
      automationId: value.automationId,
    };
  }

  return decodeIntegrationConnectionChange(value) ?? decodeProviderConnectionChange(value);
}
