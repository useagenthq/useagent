const MAX_CHECK_RUNS = 50;
const MAX_DEPLOYMENTS = 30;
const DEPLOYMENT_STATUS_CONCURRENCY = 5;
const MAX_COMMIT_STATUSES = 50;
const MAX_CHECK_SUMMARY_CHARS = 2_000;
const MAX_CHECK_LINKS = 10;
const MAX_EVIDENCE_ERROR_CHARS = 500;

export interface GithubEvidenceService {
  /** GET an api.github.com path, returning parsed JSON or throwing on a non-2xx. */
  fetchJson(path: string): Promise<unknown>;
}

interface GhCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  details_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  app?: { slug?: string } | null;
  output?: { title?: string | null; summary?: string | null } | null;
}

interface GhCheckRunsResponse {
  total_count?: number;
  check_runs?: GhCheckRun[];
}

interface GhDeployment {
  id?: number;
  environment?: string;
  description?: string | null;
  ref?: string;
  sha?: string;
  transient_environment?: boolean;
  production_environment?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface GhDeploymentStatus {
  state?: string;
  description?: string | null;
  environment_url?: string | null;
  log_url?: string | null;
  created_at?: string;
  updated_at?: string;
  creator?: { login?: string } | null;
}

interface GhCommitStatus {
  id?: number;
  context?: string;
  state?: string;
  description?: string | null;
  target_url?: string | null;
  created_at?: string;
  updated_at?: string;
  creator?: { login?: string } | null;
}

interface GhCombinedStatus {
  state?: string;
  total_count?: number;
  statuses?: GhCommitStatus[];
}

interface GithubCheckLink {
  readonly label: string;
  readonly url: string;
}

interface GithubCheckRunEvidence {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly details_url: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly app: string | null;
  readonly output_title: string | null;
  readonly output_summary: string | null;
  readonly output_summary_truncated: boolean;
  readonly links: readonly GithubCheckLink[];
}

interface GithubCheckRunsEvidence {
  readonly check_runs_available: boolean;
  readonly check_runs_error: string | null;
  readonly check_runs: readonly GithubCheckRunEvidence[];
  readonly check_runs_total: number;
  readonly check_runs_truncated: boolean;
}

interface GithubDeploymentEvidence {
  readonly id: number | null;
  readonly environment: string;
  readonly description: string | null;
  readonly ref: string | null;
  readonly sha: string | null;
  readonly transient_environment: boolean;
  readonly production_environment: boolean;
  readonly created_at: string | null;
  readonly updated_at: string | null;
  readonly status_available: boolean;
  readonly status_error: string | null;
  readonly state: string | null;
  readonly status_description: string | null;
  readonly environment_url: string | null;
  readonly log_url: string | null;
  readonly status_creator: string | null;
  readonly status_created_at: string | null;
  readonly status_updated_at: string | null;
}

interface GithubDeploymentsEvidence {
  readonly deployments_available: boolean;
  readonly deployments_error: string | null;
  readonly deployments: readonly GithubDeploymentEvidence[];
  readonly deployments_truncated: boolean;
}

interface GithubCommitStatusEvidence {
  readonly id: number | null;
  readonly context: string;
  readonly state: string;
  readonly description: string | null;
  readonly target_url: string | null;
  readonly creator: string;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

interface GithubCommitStatusesEvidence {
  readonly commit_statuses_available: boolean;
  readonly commit_statuses_error: string | null;
  readonly commit_status_state: string | null;
  readonly commit_statuses: readonly GithubCommitStatusEvidence[];
  readonly commit_statuses_total: number;
  readonly commit_statuses_truncated: boolean;
}

export type GithubHeadEvidence = GithubCheckRunsEvidence &
  GithubDeploymentsEvidence &
  GithubCommitStatusesEvidence;

export function githubAuthor(user: { login?: string } | null | undefined): string {
  return user?.login ?? "unknown";
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, limit), items.length) },
      () => worker(),
    ),
  );
  return results;
}

function evidenceError(error: unknown): string {
  const message = error instanceof Error ? error.message : "GitHub evidence request failed";
  return message.slice(0, MAX_EVIDENCE_ERROR_CHARS);
}

function boundedCheckSummary(value: unknown): {
  readonly text: string | null;
  readonly truncated: boolean;
} {
  if (typeof value !== "string") return { text: null, truncated: false };
  if (value.length <= MAX_CHECK_SUMMARY_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, MAX_CHECK_SUMMARY_CHARS)}\n[summary truncated]`,
    truncated: true,
  };
}

function markdownHttpsLinks(summary: string | null): GithubCheckLink[] {
  if (!summary) return [];
  const links: GithubCheckLink[] = [];
  const seen = new Set<string>();
  const markdownLink = /\[([^\]\r\n]{1,200})\]\((https:\/\/[^)\s]{1,2048})\)/giu;
  for (const match of summary.matchAll(markdownLink)) {
    const label = match[1];
    const url = match[2];
    if (!label || !url || seen.has(url)) continue;
    try {
      if (new URL(url).protocol !== "https:") continue;
    } catch {
      continue;
    }
    seen.add(url);
    links.push({ label, url });
    if (links.length >= MAX_CHECK_LINKS) break;
  }
  return links;
}

async function readCheckRuns(
  service: GithubEvidenceService,
  repo: string,
  sha: string,
): Promise<GithubCheckRunsEvidence> {
  try {
    const raw = (await service.fetchJson(
      `/repos/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=${MAX_CHECK_RUNS}`,
    )) as GhCheckRunsResponse;
    const rawRuns = Array.isArray(raw.check_runs) ? raw.check_runs : [];
    const checkRuns = rawRuns.slice(0, MAX_CHECK_RUNS).map((check) => {
      const summary = boundedCheckSummary(check.output?.summary);
      return {
        name: check.name ?? "",
        status: check.status ?? "unknown",
        conclusion: check.conclusion ?? null,
        details_url: check.details_url ?? null,
        started_at: check.started_at ?? null,
        completed_at: check.completed_at ?? null,
        app: check.app?.slug ?? null,
        output_title: check.output?.title ?? null,
        output_summary: summary.text,
        output_summary_truncated: summary.truncated,
        links: markdownHttpsLinks(summary.text),
      } satisfies GithubCheckRunEvidence;
    });
    const total = typeof raw.total_count === "number" ? raw.total_count : rawRuns.length;
    return {
      check_runs_available: true,
      check_runs_error: null,
      check_runs: checkRuns,
      check_runs_total: total,
      check_runs_truncated: total > checkRuns.length,
    };
  } catch (error) {
    return {
      check_runs_available: false,
      check_runs_error: evidenceError(error),
      check_runs: [],
      check_runs_total: 0,
      check_runs_truncated: false,
    };
  }
}

async function readDeploymentStatus(
  service: GithubEvidenceService,
  repo: string,
  deployment: GhDeployment,
): Promise<GithubDeploymentEvidence> {
  const base = {
    id: deployment.id ?? null,
    environment: deployment.environment ?? "",
    description: deployment.description ?? null,
    ref: deployment.ref ?? null,
    sha: deployment.sha ?? null,
    transient_environment: Boolean(deployment.transient_environment),
    production_environment: Boolean(deployment.production_environment),
    created_at: deployment.created_at ?? null,
    updated_at: deployment.updated_at ?? null,
  };
  if (typeof deployment.id !== "number") {
    return {
      ...base,
      status_available: false,
      status_error: "deployment response did not include a numeric id",
      state: null,
      status_description: null,
      environment_url: null,
      log_url: null,
      status_creator: null,
      status_created_at: null,
      status_updated_at: null,
    };
  }
  try {
    const raw = await service.fetchJson(
      `/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`,
    );
    const latest = (Array.isArray(raw) ? (raw as GhDeploymentStatus[]) : [])[0];
    return {
      ...base,
      status_available: true,
      status_error: null,
      state: latest?.state ?? null,
      status_description: latest?.description ?? null,
      environment_url: latest?.environment_url ?? null,
      log_url: latest?.log_url ?? null,
      status_creator: latest ? githubAuthor(latest.creator) : null,
      status_created_at: latest?.created_at ?? null,
      status_updated_at: latest?.updated_at ?? null,
    };
  } catch (error) {
    return {
      ...base,
      status_available: false,
      status_error: evidenceError(error),
      state: null,
      status_description: null,
      environment_url: null,
      log_url: null,
      status_creator: null,
      status_created_at: null,
      status_updated_at: null,
    };
  }
}

async function readDeployments(
  service: GithubEvidenceService,
  repo: string,
  sha: string,
): Promise<GithubDeploymentsEvidence> {
  try {
    const raw = await service.fetchJson(
      `/repos/${repo}/deployments?sha=${encodeURIComponent(sha)}&per_page=${MAX_DEPLOYMENTS}`,
    );
    const rawDeployments = Array.isArray(raw) ? (raw as GhDeployment[]) : [];
    const boundedDeployments = rawDeployments.slice(0, MAX_DEPLOYMENTS);
    const deployments = await mapWithConcurrency(
      boundedDeployments,
      DEPLOYMENT_STATUS_CONCURRENCY,
      (deployment) => readDeploymentStatus(service, repo, deployment),
    );
    return {
      deployments_available: true,
      deployments_error: null,
      deployments,
      deployments_truncated: rawDeployments.length >= MAX_DEPLOYMENTS,
    };
  } catch (error) {
    return {
      deployments_available: false,
      deployments_error: evidenceError(error),
      deployments: [],
      deployments_truncated: false,
    };
  }
}

async function readCommitStatuses(
  service: GithubEvidenceService,
  repo: string,
  sha: string,
): Promise<GithubCommitStatusesEvidence> {
  try {
    const raw = (await service.fetchJson(
      `/repos/${repo}/commits/${encodeURIComponent(sha)}/status?per_page=${MAX_COMMIT_STATUSES}`,
    )) as GhCombinedStatus;
    const rawStatuses = Array.isArray(raw.statuses) ? raw.statuses : [];
    const commitStatuses = rawStatuses.slice(0, MAX_COMMIT_STATUSES).map((status) => ({
      id: status.id ?? null,
      context: status.context ?? "",
      state: status.state ?? "unknown",
      description: status.description ?? null,
      target_url: status.target_url ?? null,
      creator: githubAuthor(status.creator),
      created_at: status.created_at ?? null,
      updated_at: status.updated_at ?? null,
    }));
    const total = typeof raw.total_count === "number" ? raw.total_count : rawStatuses.length;
    return {
      commit_statuses_available: true,
      commit_statuses_error: null,
      commit_status_state: raw.state ?? "unknown",
      commit_statuses: commitStatuses,
      commit_statuses_total: total,
      commit_statuses_truncated: total > commitStatuses.length,
    };
  } catch (error) {
    return {
      commit_statuses_available: false,
      commit_statuses_error: evidenceError(error),
      commit_status_state: null,
      commit_statuses: [],
      commit_statuses_total: 0,
      commit_statuses_truncated: false,
    };
  }
}

export async function readGithubHeadEvidence(
  service: GithubEvidenceService,
  repo: string,
  sha: string,
): Promise<GithubHeadEvidence> {
  const [checkRuns, deployments, commitStatuses] = await Promise.all([
    readCheckRuns(service, repo, sha),
    readDeployments(service, repo, sha),
    readCommitStatuses(service, repo, sha),
  ]);
  return { ...checkRuns, ...deployments, ...commitStatuses };
}

export function githubHeadEvidenceText(evidence: GithubHeadEvidence): string[] {
  const lines: string[] = [];
  if (!evidence.check_runs_available) {
    lines.push(`Check runs unavailable: ${String(evidence.check_runs_error)}`);
  } else {
    for (const check of evidence.check_runs) {
      const result = check.conclusion ?? check.status;
      lines.push(
        `Check ${check.name}: ${result}` +
          (check.details_url ? ` ${check.details_url}` : ""),
      );
      for (const link of check.links) lines.push(`  ${link.label}: ${link.url}`);
    }
  }

  if (!evidence.deployments_available) {
    lines.push(`Deployments unavailable: ${String(evidence.deployments_error)}`);
  } else {
    for (const deployment of evidence.deployments) {
      const environment = deployment.environment || "unnamed environment";
      if (!deployment.status_available) {
        lines.push(`${environment}: status unavailable (${String(deployment.status_error)})`);
      } else {
        lines.push(
          `${environment}: ${deployment.state ?? "no status"}` +
            (deployment.environment_url ? ` ${deployment.environment_url}` : ""),
        );
      }
    }
  }

  if (!evidence.commit_statuses_available) {
    lines.push(`Commit statuses unavailable: ${String(evidence.commit_statuses_error)}`);
  } else {
    for (const status of evidence.commit_statuses) {
      lines.push(
        `Commit status ${status.context}: ${status.state}` +
          (status.target_url ? ` ${status.target_url}` : ""),
      );
    }
  }
  return lines;
}
