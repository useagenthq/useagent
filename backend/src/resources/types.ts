export type RunIntakeSource = "web" | "api" | "slack" | "automation";

export type ResourceKind = "code.repository" | "code.change" | "file" | "web.page";

export type ResourceCapability =
  | "content.read"
  | "code.checkout"
  | "change.read"
  | "change.checks.read"
  | "deployment.read"
  | "file.read"
  | "page.read";

export interface ResourceProvenance {
  readonly source: "explicit" | "user_text" | "legacy_parent";
  readonly channel: RunIntakeSource;
  readonly raw: string;
  readonly start: number | null;
  readonly end: number | null;
}

export interface GitHubRepositoryLocator {
  readonly type: "github.repository";
  readonly repository: string;
  readonly revision: string | null;
}

export interface GitHubPullRequestLocator {
  readonly type: "github.pull_request";
  readonly repository: string;
  readonly number: number;
  readonly revision: string | null;
}

export interface FileLocator {
  readonly type: "file";
  readonly id: string;
  readonly name: string | null;
}

export interface WebPageLocator {
  readonly type: "web.page";
  readonly url: string;
}

interface RunResourceBase {
  readonly provider: string;
  readonly capabilities: readonly ResourceCapability[];
  readonly provenance: readonly ResourceProvenance[];
}

export interface GitHubRepositoryResource extends RunResourceBase {
  readonly kind: "code.repository";
  readonly provider: "github";
  readonly locator: GitHubRepositoryLocator;
}

export interface GitHubPullRequestResource extends RunResourceBase {
  readonly kind: "code.change";
  readonly provider: "github";
  readonly locator: GitHubPullRequestLocator;
}

export interface FileResource extends RunResourceBase {
  readonly kind: "file";
  readonly locator: FileLocator;
}

export interface WebPageResource extends RunResourceBase {
  readonly kind: "web.page";
  readonly locator: WebPageLocator;
}

export type RunResource =
  | GitHubRepositoryResource
  | GitHubPullRequestResource
  | FileResource
  | WebPageResource;

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
