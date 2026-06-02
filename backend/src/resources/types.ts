// The typed run-resource wire shapes (RunResource + its locators, capabilities,
// provenance, kinds) live in the agent-client wire contract so the backend
// serializer (`resolved_resources`) and any client share ONE definition. Packages
// never import apps, so the ground truth is the package. Re-exported here so the
// resolver/intake types below - and the backend modules that read these from
// `../resources/types` - keep one import path. The intake/resolver/diagnostic
// types below this block are backend-only and stay here.
export type {
  RunIntakeSource,
  ResourceKind,
  ResourceCapability,
  ResourceProvenance,
  GitHubRepositoryLocator,
  GitHubPullRequestLocator,
  FileLocator,
  WebPageLocator,
  GitHubRepositoryResource,
  GitHubPullRequestResource,
  FileResource,
  WebPageResource,
  RunResource,
} from "@useagent/agent-client/wire";

import type {
  RunResource,
  GitHubRepositoryResource,
  GitHubPullRequestResource,
  FileResource,
  WebPageResource,
  ResourceCapability,
  RunIntakeSource,
} from "@useagent/agent-client/wire";

type ExplicitResource<T extends RunResource> = Omit<T, "capabilities" | "provenance"> & {
  readonly capabilities?: readonly ResourceCapability[];
};

export type ExplicitRunResource =
  | ExplicitResource<GitHubRepositoryResource>
  | ExplicitResource<GitHubPullRequestResource>
  | ExplicitResource<FileResource>
  | ExplicitResource<WebPageResource>;

type WithoutProvenance<T> = T extends RunResource ? Omit<T, "provenance"> : never;

export type ResourceDescriptor = WithoutProvenance<RunResource>;

export interface ResourceReference {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

export type ResourceDiagnosticCode =
  | "resource_invalid"
  | "resource_unsupported"
  | "resource_ambiguous"
  | "resource_unauthorized"
  | "resource_limit_exceeded";

export interface ResourceDiagnostic {
  readonly code: ResourceDiagnosticCode;
  readonly message: string;
  readonly provider: string | null;
  readonly reference: string | null;
  readonly action: string;
}

export class RunIntakeError extends Error {
  readonly code: ResourceDiagnosticCode;
  readonly diagnostic: ResourceDiagnostic;

  constructor(diagnostic: ResourceDiagnostic) {
    super(diagnostic.message);
    this.name = "RunIntakeError";
    this.code = diagnostic.code;
    this.diagnostic = diagnostic;
  }
}

export interface ResourceResolution {
  readonly resources: readonly ResourceDescriptor[];
}

export interface ResourceResolver {
  readonly provider: string;
  supports(reference: ResourceReference): boolean;
  resolve(reference: ResourceReference): ResourceResolution;
}

export interface ResourceAuthorizationDecision {
  readonly available: boolean;
  readonly capabilities?: readonly ResourceCapability[];
  readonly revision?: string | null;
  readonly message?: string;
}

export type ResourceAuthorization = (
  resource: RunResource,
) =>
  | boolean
  | ResourceAuthorizationDecision
  | Promise<boolean | ResourceAuthorizationDecision>;

export interface RunIntakeInput {
  readonly source: RunIntakeSource;
  /** Only user-authored text is eligible for resource discovery. */
  readonly text: string;
  readonly explicitResources?: readonly ExplicitRunResource[];
  /** Previously accepted thread resources. They retain their original provenance. */
  readonly inheritedResources?: readonly RunResource[];
  /** Retrieval/tool/model context is deliberately never scanned for capabilities. */
  readonly untrustedText?: readonly string[];
}

export interface RunIntakeResult {
  readonly resources: readonly RunResource[];
  /** Legacy run projection, including an optional `:revision` suffix. */
  readonly repos: readonly string[];
}
