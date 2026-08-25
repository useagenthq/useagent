import { createHash } from "node:crypto";
import type {
	GitHubChangeManifest,
	GitHubChangeManifestFile,
	GitHubFileMode,
} from "../db/schema";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const BLOB_CONCURRENCY = 6;

type GithubFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface FrozenGitHubPayloadFile {
	readonly path: string;
	readonly mode: GitHubFileMode;
	readonly content: Uint8Array;
}

/** Immutable bytes resolved from the frozen payload storage object. Deletes are
 * represented only in the manifest and therefore have no payload entry. */
export interface FrozenGitHubPayload {
	readonly version: 1;
	readonly files: readonly FrozenGitHubPayloadFile[];
}

export interface GitHubPublicationInput {
	readonly repository: string;
	readonly baseSha: string;
	readonly targetBranch: string;
	readonly headBranch: string;
	readonly manifest: GitHubChangeManifest;
	readonly payload: FrozenGitHubPayload;
	readonly commitMessage: string;
	readonly pullRequestTitle: string;
	readonly pullRequestBody: string;
	readonly draft: boolean;
}

export interface GitHubPublicationReceipt {
	readonly repository: string;
	readonly targetBranch: string;
	readonly headBranch: string;
	readonly baseSha: string;
	readonly treeSha: string;
	readonly commitSha: string;
	readonly pullRequestNumber: number;
	readonly pullRequestUrl: string;
}

export type GitHubPublicationStage =
	| "resolve_token"
	| "read_target"
	| "read_head"
	| "read_base_commit"
	| "create_blob"
	| "create_tree"
	| "create_commit"
	| "confirm_target"
	| "create_head_ref"
	| "create_pull_request";

export type GitHubHeadRefState = "not_created" | "unknown" | "created";

/** Publication failures carry enough durable state for a worker to decide
 * whether retrying is safe or external reconciliation is mandatory. */
export class GitHubPublicationError extends Error {
	readonly stage: GitHubPublicationStage;
	readonly reconcileRequired: boolean;
	readonly repository: string;
	readonly headBranch: string;
	readonly commitSha: string | null;
	readonly headRefState: GitHubHeadRefState;

	constructor(input: {
		readonly message: string;
		readonly stage: GitHubPublicationStage;
		readonly reconcileRequired: boolean;
		readonly repository: string;
		readonly headBranch: string;
		readonly commitSha?: string | null;
		readonly headRefState?: GitHubHeadRefState;
	}) {
		super(input.message);
		this.name = "GitHubPublicationError";
		this.stage = input.stage;
		this.reconcileRequired = input.reconcileRequired;
		this.repository = input.repository;
		this.headBranch = input.headBranch;
		this.commitSha = input.commitSha ?? null;
		this.headRefState = input.headRefState ?? "not_created";
	}
}

export interface GitHubPublisherDependencies {
	/** Backend-only token resolver. The token is consumed inside this module and
	 * is never included in the receipt or an error. */
	readonly resolveToken: (repository: string) => Promise<string>;
	readonly fetch?: GithubFetch;
	readonly apiBaseUrl?: string;
}

interface GithubRefResponse {
	readonly object?: { readonly sha?: string };
}

interface GithubCommitResponse {
	readonly sha?: string;
	readonly tree?: { readonly sha?: string };
}

interface GithubShaResponse {
	readonly sha?: string;
}

interface GithubPullResponse {
	readonly number?: number;
	readonly html_url?: string;
}

function sha256(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function exactSha(value: string | undefined, name: string): string {
	const normalized = value?.trim().toLowerCase() ?? "";
	if (!/^[0-9a-f]{40}$/u.test(normalized))
		throw new Error(`${name} is invalid`);
	return normalized;
}

function boundedText(value: string, name: string, maxLength: number): string {
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > maxLength ||
		[...normalized].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || codePoint === 127;
		})
	) {
		throw new Error(`${name} is invalid`);
	}
	return normalized;
}

function repository(value: string): {
	fullName: string;
	owner: string;
	name: string;
} {
	const fullName = boundedText(value, "repository", 255);
	const match = /^([^/\s]+)\/([^/\s]+)$/u.exec(fullName);
	if (!match?.[1] || !match[2]) throw new Error("repository is invalid");
	return { fullName, owner: match[1], name: match[2] };
}

function branch(value: string, name: string): string {
	const normalized = boundedText(value, name, 255);
	const containsForbiddenCharacter = ["~", "^", ":", "?", "*", "[", "\\"].some(
		(character) => normalized.includes(character),
	);
	if (
		normalized.startsWith("/") ||
		normalized.endsWith("/") ||
		normalized.endsWith(".") ||
		normalized.includes("..") ||
		normalized.includes("@{") ||
		containsForbiddenCharacter ||
		/\s/u.test(normalized)
	) {
		throw new Error(`${name} is invalid`);
	}
	return normalized;
}

function path(value: string): string {
	const normalized = boundedText(value, "github change path", 4_096);
	if (
		normalized.startsWith("/") ||
		normalized.includes("\\") ||
		normalized.split("/").includes("..")
	) {
		throw new Error("github change path must be repository-relative");
	}
	return normalized;
}

function validateFrozenInputs(input: GitHubPublicationInput): {
	readonly repository: ReturnType<typeof repository>;
	readonly baseSha: string;
	readonly targetBranch: string;
	readonly headBranch: string;
	readonly commitMessage: string;
	readonly pullRequestTitle: string;
	readonly pullRequestBody: string;
	readonly draft: boolean;
	readonly payloadByPath: ReadonlyMap<string, FrozenGitHubPayloadFile>;
	readonly manifestFiles: readonly GitHubChangeManifestFile[];
} {
	const parsedRepository = repository(input.repository);
	const baseSha = exactSha(input.baseSha, "baseSha");
	const targetBranch = branch(input.targetBranch, "targetBranch");
	const headBranch = branch(input.headBranch, "headBranch");
	if (headBranch === targetBranch) {
		throw new Error("headBranch must differ from targetBranch");
	}
	if (input.manifest.version !== 1 || input.payload.version !== 1) {
		throw new Error("github publication input version is invalid");
	}
	if (typeof input.draft !== "boolean") {
		throw new Error("github publication draft flag is invalid");
	}
	if (
		input.manifest.files.length < 1 ||
		input.manifest.files.length > MAX_FILES ||
		input.payload.files.length > MAX_FILES
	) {
		throw new Error(`github publication must contain 1-${MAX_FILES} files`);
	}

	const payloadByPath = new Map<string, FrozenGitHubPayloadFile>();
	let totalBytes = 0;
	for (const file of input.payload.files) {
		const normalizedPath = path(file.path);
		if (payloadByPath.has(normalizedPath)) {
			throw new Error(`github payload repeats ${normalizedPath}`);
		}
		if (
			file.mode !== "100644" &&
			file.mode !== "100755" &&
			file.mode !== "120000"
		) {
			throw new Error(`github payload mode for ${normalizedPath} is invalid`);
		}
		if (!(file.content instanceof Uint8Array)) {
			throw new Error(`github payload file ${normalizedPath} is invalid`);
		}
		const content = new Uint8Array(file.content);
		if (content.byteLength > MAX_FILE_BYTES) {
			throw new Error(`github payload file ${normalizedPath} is invalid`);
		}
		totalBytes += content.byteLength;
		if (totalBytes > MAX_PAYLOAD_BYTES)
			throw new Error("github payload is too large");
		payloadByPath.set(normalizedPath, {
			path: normalizedPath,
			mode: file.mode,
			content,
		});
	}

	const expectedPayloadPaths = new Set<string>();
	const manifestPaths = new Set<string>();
	const manifestFiles: GitHubChangeManifestFile[] = [];
	for (const file of input.manifest.files) {
		const normalizedPath = path(file.path);
		if (manifestPaths.has(normalizedPath)) {
			throw new Error(`github manifest repeats ${normalizedPath}`);
		}
		manifestPaths.add(normalizedPath);
		if (!["add", "modify", "delete", "rename"].includes(file.action)) {
			throw new Error(`github action for ${normalizedPath} is invalid`);
		}
		if (
			file.mode !== undefined &&
			file.mode !== "100644" &&
			file.mode !== "100755" &&
			file.mode !== "120000"
		) {
			throw new Error(`github manifest mode for ${normalizedPath} is invalid`);
		}
		const previousPath = file.previousPath
			? path(file.previousPath)
			: undefined;
		manifestFiles.push({
			path: normalizedPath,
			action: file.action,
			...(file.sha256 ? { sha256: file.sha256.toLowerCase() } : {}),
			...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
			...(file.mode ? { mode: file.mode } : {}),
			...(previousPath ? { previousPath } : {}),
		});
		if (file.action === "delete") continue;
		const payloadFile = payloadByPath.get(normalizedPath);
		if (!payloadFile)
			throw new Error(`github payload is missing ${normalizedPath}`);
		if (file.sizeBytes !== payloadFile.content.byteLength) {
			throw new Error(`github payload size does not match ${normalizedPath}`);
		}
		if (file.sha256?.toLowerCase() !== sha256(payloadFile.content)) {
			throw new Error(`github payload digest does not match ${normalizedPath}`);
		}
		if (file.mode !== payloadFile.mode) {
			throw new Error(`github payload mode does not match ${normalizedPath}`);
		}
		expectedPayloadPaths.add(normalizedPath);
		if (file.action === "rename") {
			if (!previousPath || previousPath === normalizedPath) {
				throw new Error(`github rename for ${normalizedPath} is invalid`);
			}
		}
	}
	for (const payloadPath of payloadByPath.keys()) {
		if (!expectedPayloadPaths.has(payloadPath)) {
			throw new Error(`github payload contains undeclared file ${payloadPath}`);
		}
	}

	return {
		repository: parsedRepository,
		baseSha,
		targetBranch,
		headBranch,
		commitMessage: boundedText(input.commitMessage, "commitMessage", 255),
		pullRequestTitle: boundedText(
			input.pullRequestTitle,
			"pullRequestTitle",
			255,
		),
		pullRequestBody: boundedText(
			input.pullRequestBody,
			"pullRequestBody",
			64 * 1024,
		),
		draft: input.draft,
		payloadByPath,
		manifestFiles,
	};
}

async function mapBounded<T, R>(
	values: readonly T[],
	concurrency: number,
	work: (value: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(values.length);
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, async () => {
			while (cursor < values.length) {
				const index = cursor++;
				const value = values[index];
				if (value === undefined)
					throw new Error("bounded work index is invalid");
				results[index] = await work(value);
			}
		}),
	);
	return results;
}

/** Publish one already-frozen change bundle through GitHub's Git Data API.
 * The function never updates an existing ref: the target must still equal the
 * frozen base commit and the new branch must not exist. */
export async function publishFrozenGitHubChange(
	input: GitHubPublicationInput,
	dependencies: GitHubPublisherDependencies,
): Promise<GitHubPublicationReceipt> {
	const normalized = validateFrozenInputs(input);
	const apiBaseUrl = new URL(dependencies.apiBaseUrl ?? DEFAULT_API_BASE_URL);
	if (
		apiBaseUrl.protocol !== "https:" &&
		!["127.0.0.1", "localhost"].includes(apiBaseUrl.hostname)
	) {
		throw new Error("GitHub API base URL must use HTTPS");
	}
	const origin = apiBaseUrl.toString().replace(/\/$/u, "");
	const fetchImpl = dependencies.fetch ?? fetch;
	let commitSha: string | null = null;
	let headRefState: GitHubHeadRefState = "not_created";

	function stagedError(
		stage: GitHubPublicationStage,
		message: string,
		overrides: {
			readonly reconcileRequired?: boolean;
			readonly headRefState?: GitHubHeadRefState;
		} = {},
	): GitHubPublicationError {
		return new GitHubPublicationError({
			message,
			stage,
			reconcileRequired:
				overrides.reconcileRequired ?? headRefState !== "not_created",
			repository: normalized.repository.fullName,
			headBranch: normalized.headBranch,
			commitSha,
			headRefState: overrides.headRefState ?? headRefState,
		});
	}

	let token: string;
	try {
		token = await dependencies.resolveToken(normalized.repository.fullName);
	} catch {
		throw stagedError(
			"resolve_token",
			"GitHub publication credential resolution failed",
		);
	}
	if (!token.trim())
		throw stagedError(
			"resolve_token",
			"GitHub publication credential is unavailable",
		);
	const repoPath = `/repos/${encodeURIComponent(normalized.repository.owner)}/${encodeURIComponent(normalized.repository.name)}`;

	async function requestRaw(
		stage: GitHubPublicationStage,
		pathName: string,
		init: RequestInit = {},
	): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			return await fetchImpl(`${origin}${repoPath}${pathName}`, {
				...init,
				signal: controller.signal,
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": GITHUB_API_VERSION,
					"User-Agent": "useagent",
					Authorization: `Bearer ${token}`,
					...(init.body ? { "Content-Type": "application/json" } : {}),
					...init.headers,
				},
			});
		} catch {
			if (stage === "create_head_ref") {
				headRefState = "unknown";
				throw stagedError(
					stage,
					"GitHub head-ref creation outcome is unknown",
					{
						reconcileRequired: true,
						headRefState: "unknown",
					},
				);
			}
			throw stagedError(stage, `GitHub request failed during ${stage}`);
		} finally {
			clearTimeout(timer);
		}
	}

	async function request<T>(
		stage: GitHubPublicationStage,
		pathName: string,
		init: RequestInit = {},
	): Promise<T> {
		const response = await requestRaw(stage, pathName, init);
		if (!response.ok) {
			throw stagedError(
				stage,
				`GitHub ${init.method ?? "GET"} ${pathName} failed: HTTP ${response.status}`,
			);
		}
		try {
			return (await response.json()) as T;
		} catch {
			throw stagedError(
				stage,
				`GitHub returned an invalid response during ${stage}`,
			);
		}
	}

	const targetRef = await request<GithubRefResponse>(
		"read_target",
		`/git/ref/heads/${encodeURIComponent(normalized.targetBranch)}`,
	);
	const targetSha = exactSha(targetRef.object?.sha, "target branch sha");
	if (targetSha !== normalized.baseSha) {
		throw new Error("target branch moved after the change set was frozen");
	}

	const headResponse = await requestRaw(
		"read_head",
		`/git/ref/heads/${encodeURIComponent(normalized.headBranch)}`,
	);
	if (headResponse.ok)
		throw stagedError("read_head", "headBranch already exists");
	if (headResponse.status !== 404) {
		throw stagedError(
			"read_head",
			`GitHub GET head branch failed: HTTP ${headResponse.status}`,
		);
	}

	const baseCommit = await request<GithubCommitResponse>(
		"read_base_commit",
		`/git/commits/${encodeURIComponent(normalized.baseSha)}`,
	);
	if (exactSha(baseCommit.sha, "base commit sha") !== normalized.baseSha) {
		throw new Error("GitHub returned a different base commit");
	}
	const baseTreeSha = exactSha(baseCommit.tree?.sha, "base tree sha");

	const payloadFiles = [...normalized.payloadByPath.values()].sort(
		(left, right) => left.path.localeCompare(right.path),
	);
	const blobs = await mapBounded(
		payloadFiles,
		BLOB_CONCURRENCY,
		async (file) => {
			const response = await request<GithubShaResponse>(
				"create_blob",
				"/git/blobs",
				{
					method: "POST",
					body: JSON.stringify({
						content: Buffer.from(file.content).toString("base64"),
						encoding: "base64",
					}),
				},
			);
			return {
				path: file.path,
				mode: file.mode,
				sha: exactSha(response.sha, "blob sha"),
			};
		},
	);
	const blobsByPath = new Map(blobs.map((blob) => [blob.path, blob]));

	const treeEntries: Array<{
		path: string;
		mode: GitHubFileMode;
		type: "blob";
		sha: string | null;
	}> = [];
	for (const file of [...normalized.manifestFiles].sort((left, right) =>
		left.path.localeCompare(right.path),
	)) {
		if (file.action === "delete") {
			treeEntries.push({
				path: path(file.path),
				mode: "100644",
				type: "blob",
				sha: null,
			});
			continue;
		}
		const blob = blobsByPath.get(path(file.path));
		if (!blob) throw new Error(`github blob is missing ${file.path}`);
		if (file.action === "rename") {
			treeEntries.push({
				path: path(file.previousPath ?? ""),
				mode: "100644",
				type: "blob",
				sha: null,
			});
		}
		treeEntries.push({
			path: blob.path,
			mode: blob.mode,
			type: "blob",
			sha: blob.sha,
		});
	}

	const tree = await request<GithubShaResponse>("create_tree", "/git/trees", {
		method: "POST",
		body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
	});
	const treeSha = exactSha(tree.sha, "tree sha");
	const commit = await request<GithubShaResponse>(
		"create_commit",
		"/git/commits",
		{
			method: "POST",
			body: JSON.stringify({
				message: normalized.commitMessage,
				tree: treeSha,
				parents: [normalized.baseSha],
			}),
		},
	);
	commitSha = exactSha(commit.sha, "commit sha");

	const freshTargetRef = await request<GithubRefResponse>(
		"confirm_target",
		`/git/ref/heads/${encodeURIComponent(normalized.targetBranch)}`,
	);
	if (
		exactSha(freshTargetRef.object?.sha, "fresh target branch sha") !==
		normalized.baseSha
	) {
		throw stagedError(
			"confirm_target",
			"target branch moved while the publication was being prepared",
		);
	}

	const createRefResponse = await requestRaw("create_head_ref", "/git/refs", {
		method: "POST",
		body: JSON.stringify({
			ref: `refs/heads/${normalized.headBranch}`,
			sha: commitSha,
		}),
	});
	if (!createRefResponse.ok) {
		headRefState = "unknown";
		throw stagedError(
			"create_head_ref",
			`GitHub POST /git/refs failed: HTTP ${createRefResponse.status}`,
			{ reconcileRequired: true, headRefState: "unknown" },
		);
	}
	headRefState = "created";

	const pull = await request<GithubPullResponse>(
		"create_pull_request",
		"/pulls",
		{
			method: "POST",
			body: JSON.stringify({
				title: normalized.pullRequestTitle,
				head: normalized.headBranch,
				base: normalized.targetBranch,
				body: normalized.pullRequestBody,
				draft: normalized.draft,
			}),
		},
	);
	if (!Number.isSafeInteger(pull.number) || (pull.number ?? 0) < 1) {
		throw stagedError(
			"create_pull_request",
			"GitHub pull request response is invalid",
		);
	}
	const pullRequestNumber = pull.number as number;
	let pullRequestUrl: URL;
	try {
		pullRequestUrl = new URL(pull.html_url ?? "");
	} catch {
		throw stagedError(
			"create_pull_request",
			"GitHub pull request URL is invalid",
		);
	}
	if (
		pullRequestUrl.protocol !== "https:" ||
		pullRequestUrl.hostname !== "github.com"
	) {
		throw stagedError(
			"create_pull_request",
			"GitHub pull request URL is invalid",
		);
	}

	return {
		repository: normalized.repository.fullName,
		targetBranch: normalized.targetBranch,
		headBranch: normalized.headBranch,
		baseSha: normalized.baseSha,
		treeSha,
		commitSha,
		pullRequestNumber,
		pullRequestUrl: pullRequestUrl.toString(),
	};
}
