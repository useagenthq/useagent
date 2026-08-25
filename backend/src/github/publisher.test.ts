import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { GitHubChangeManifest } from "../db/schema";
import { GitHubPublicationError, publishFrozenGitHubChange } from "./publisher";

const BASE_SHA = "1".repeat(40);
const BASE_TREE_SHA = "2".repeat(40);
const BLOB_SHA = "3".repeat(40);
const TREE_SHA = "4".repeat(40);
const COMMIT_SHA = "5".repeat(40);

function digest(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function inputs() {
	const content = new TextEncoder().encode("export const answer = 42;\n");
	const manifest: GitHubChangeManifest = {
		version: 1,
		files: [
			{
				path: "src/answer.ts",
				action: "modify",
				sha256: digest(content),
				sizeBytes: content.byteLength,
				mode: "100644",
			},
		],
	};
	return {
		repository: "acme/widget",
		baseSha: BASE_SHA,
		targetBranch: "main",
		headBranch: "useagent/change-123",
		manifest,
		payload: {
			version: 1 as const,
			files: [{ path: "src/answer.ts", mode: "100644" as const, content }],
		},
		commitMessage: "Update answer",
		pullRequestTitle: "Update answer",
		pullRequestBody: "Generated from frozen change set 123.",
		draft: true,
	};
}

describe("GitHub Git Data publisher", () => {
	test("publishes a frozen payload on a new branch without updating an existing ref", async () => {
		const requests: Array<{ path: string; method: string; body?: unknown }> =
			[];
		const fetchImpl = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			requests.push({
				path: url.pathname,
				method,
				...(typeof init?.body === "string"
					? { body: JSON.parse(init.body) }
					: {}),
			});
			if (url.pathname.endsWith("/git/ref/heads/main")) {
				return Response.json({ object: { sha: BASE_SHA } });
			}
			if (url.pathname.endsWith("/git/ref/heads/useagent%2Fchange-123")) {
				return new Response("not found", { status: 404 });
			}
			if (url.pathname.endsWith(`/git/commits/${BASE_SHA}`)) {
				return Response.json({ sha: BASE_SHA, tree: { sha: BASE_TREE_SHA } });
			}
			if (url.pathname.endsWith("/git/blobs"))
				return Response.json({ sha: BLOB_SHA });
			if (url.pathname.endsWith("/git/trees"))
				return Response.json({ sha: TREE_SHA });
			if (url.pathname.endsWith("/git/commits"))
				return Response.json({ sha: COMMIT_SHA });
			if (url.pathname.endsWith("/git/refs"))
				return Response.json({ object: { sha: COMMIT_SHA } });
			if (url.pathname.endsWith("/pulls")) {
				return Response.json({
					number: 17,
					html_url: "https://github.com/acme/widget/pull/17",
				});
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;

		const receipt = await publishFrozenGitHubChange(inputs(), {
			resolveToken: async () => "server-only-token",
			fetch: fetchImpl,
			apiBaseUrl: "https://api.github.test",
		});

		expect(receipt).toEqual({
			repository: "acme/widget",
			targetBranch: "main",
			headBranch: "useagent/change-123",
			baseSha: BASE_SHA,
			treeSha: TREE_SHA,
			commitSha: COMMIT_SHA,
			pullRequestNumber: 17,
			pullRequestUrl: "https://github.com/acme/widget/pull/17",
		});
		expect(requests.some((request) => request.method === "PATCH")).toBe(false);
		expect(
			requests.find((request) => request.path.endsWith("/git/refs"))?.body,
		).toEqual({
			ref: "refs/heads/useagent/change-123",
			sha: COMMIT_SHA,
		});
		expect(JSON.stringify(requests)).not.toContain("server-only-token");
	});

	test("rejects stale bases and mismatched payloads before creating Git objects", async () => {
		let requests = 0;
		const staleFetch = (async (input: string | URL | Request) => {
			requests += 1;
			const url = new URL(String(input));
			if (url.pathname.endsWith("/git/ref/heads/main")) {
				return Response.json({ object: { sha: "9".repeat(40) } });
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;
		await expect(
			publishFrozenGitHubChange(inputs(), {
				resolveToken: async () => "token",
				fetch: staleFetch,
			}),
		).rejects.toThrow("target branch moved");
		expect(requests).toBe(1);

		const valid = inputs();
		const [validFile] = valid.payload.files;
		if (!validFile) throw new Error("test payload file is missing");
		const mismatched = {
			...valid,
			payload: {
				...valid.payload,
				files: [
					{
						...validFile,
						content: new TextEncoder().encode("different"),
					},
				],
			},
		};
		await expect(
			publishFrozenGitHubChange(mismatched, {
				resolveToken: async () => "token",
				fetch: staleFetch,
			}),
		).rejects.toThrow("github payload size does not match");
		expect(requests).toBe(1);
	});

	test("publishes the cloned frozen bytes when the caller mutates its buffer", async () => {
		const input = inputs();
		const originalContent = new Uint8Array(
			input.payload.files[0]?.content ?? [],
		);
		let publishedBlob = "";
		const fetchImpl = (async (
			request: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = new URL(String(request));
			if (url.pathname.endsWith("/git/ref/heads/main")) {
				return Response.json({ object: { sha: BASE_SHA } });
			}
			if (url.pathname.endsWith("/git/ref/heads/useagent%2Fchange-123")) {
				return new Response("not found", { status: 404 });
			}
			if (url.pathname.endsWith(`/git/commits/${BASE_SHA}`)) {
				return Response.json({ sha: BASE_SHA, tree: { sha: BASE_TREE_SHA } });
			}
			if (url.pathname.endsWith("/git/blobs")) {
				publishedBlob = (JSON.parse(String(init?.body)) as { content: string })
					.content;
				return Response.json({ sha: BLOB_SHA });
			}
			if (url.pathname.endsWith("/git/trees"))
				return Response.json({ sha: TREE_SHA });
			if (url.pathname.endsWith("/git/commits"))
				return Response.json({ sha: COMMIT_SHA });
			if (url.pathname.endsWith("/git/refs")) return Response.json({});
			if (url.pathname.endsWith("/pulls")) {
				return Response.json({
					number: 17,
					html_url: "https://github.com/acme/widget/pull/17",
				});
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;

		await publishFrozenGitHubChange(input, {
			resolveToken: async () => {
				input.payload.files[0]?.content.fill(0);
				return "token";
			},
			fetch: fetchImpl,
		});

		expect(publishedBlob).toBe(Buffer.from(originalContent).toString("base64"));
	});

	test("marks a pull-request failure after ref creation as reconciliation-required", async () => {
		const fetchImpl = successfulFetch({ pullStatus: 503 });
		try {
			await publishFrozenGitHubChange(inputs(), {
				resolveToken: async () => "token",
				fetch: fetchImpl,
			});
			throw new Error("expected publication failure");
		} catch (error) {
			expect(error).toBeInstanceOf(GitHubPublicationError);
			const publicationError = error as GitHubPublicationError;
			expect(publicationError.stage).toBe("create_pull_request");
			expect(publicationError.reconcileRequired).toBe(true);
			expect(publicationError.commitSha).toBe(COMMIT_SHA);
			expect(publicationError.headRefState).toBe("created");
		}
	});

	test("marks an interrupted head-ref request as an unknown external outcome", async () => {
		const baseFetch = successfulFetch();
		const fetchImpl = (async (
			request: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = new URL(String(request));
			if (url.pathname.endsWith("/git/refs"))
				throw new Error("connection reset");
			return baseFetch(request, init);
		}) as typeof fetch;
		try {
			await publishFrozenGitHubChange(inputs(), {
				resolveToken: async () => "token",
				fetch: fetchImpl,
			});
			throw new Error("expected publication failure");
		} catch (error) {
			expect(error).toBeInstanceOf(GitHubPublicationError);
			const publicationError = error as GitHubPublicationError;
			expect(publicationError.stage).toBe("create_head_ref");
			expect(publicationError.reconcileRequired).toBe(true);
			expect(publicationError.commitSha).toBe(COMMIT_SHA);
			expect(publicationError.headRefState).toBe("unknown");
		}
	});

	test("treats every non-success head-ref response as reconciliation-required", async () => {
		const fetchImpl = successfulFetch({
			onRequest(url) {
				if (url.pathname.endsWith("/git/refs")) {
					return new Response("unavailable", { status: 503 });
				}
				return null;
			},
		});
		try {
			await publishFrozenGitHubChange(inputs(), {
				resolveToken: async () => "token",
				fetch: fetchImpl,
			});
			throw new Error("expected publication failure");
		} catch (error) {
			expect(error).toBeInstanceOf(GitHubPublicationError);
			const publicationError = error as GitHubPublicationError;
			expect(publicationError.stage).toBe("create_head_ref");
			expect(publicationError.reconcileRequired).toBe(true);
			expect(publicationError.commitSha).toBe(COMMIT_SHA);
			expect(publicationError.headRefState).toBe("unknown");
		}
	});

	test("rechecks target freshness immediately before creating the head ref", async () => {
		let targetReads = 0;
		const methods: string[] = [];
		const fetchImpl = successfulFetch({
			onRequest(url, init) {
				methods.push(`${init?.method ?? "GET"} ${url.pathname}`);
				if (url.pathname.endsWith("/git/ref/heads/main")) {
					targetReads += 1;
					return Response.json({
						object: { sha: targetReads === 1 ? BASE_SHA : "9".repeat(40) },
					});
				}
				return null;
			},
		});

		await expect(
			publishFrozenGitHubChange(inputs(), {
				resolveToken: async () => "token",
				fetch: fetchImpl,
			}),
		).rejects.toThrow("target branch moved while");
		expect(
			methods.some((entry) => entry === "POST /repos/acme/widget/git/refs"),
		).toBe(false);
	});

	test("rejects payload modes outside the frozen manifest contract", async () => {
		const input = inputs();
		const [inputFile] = input.payload.files;
		if (!inputFile) throw new Error("test payload file is missing");
		const invalid = {
			...input,
			payload: {
				...input.payload,
				files: [{ ...inputFile, mode: "100664" }],
			},
		};
		await expect(
			publishFrozenGitHubChange(invalid as typeof input, {
				resolveToken: async () => "token",
			}),
		).rejects.toThrow("payload mode");

		const mismatched = {
			...input,
			payload: {
				...input.payload,
				files: [{ ...inputFile, mode: "100755" as const }],
			},
		};
		await expect(
			publishFrozenGitHubChange(mismatched, {
				resolveToken: async () => "token",
			}),
		).rejects.toThrow("payload mode does not match");
	});

	test("publishes the snapshotted draft flag when the caller mutates its input", async () => {
		const input = inputs();
		let publishedDraft: boolean | undefined;
		const fetchImpl = successfulFetch({
			onRequest(url, init) {
				if (url.pathname.endsWith("/pulls")) {
					publishedDraft = (
						JSON.parse(String(init?.body)) as { draft: boolean }
					).draft;
					return Response.json({
						number: 17,
						html_url: "https://github.com/acme/widget/pull/17",
					});
				}
				return null;
			},
		});

		await publishFrozenGitHubChange(input, {
			resolveToken: async () => {
				input.draft = false;
				return "token";
			},
			fetch: fetchImpl,
		});

		expect(publishedDraft).toBe(true);
	});
});

function successfulFetch(
	options: {
		readonly pullStatus?: number;
		readonly onRequest?: (
			url: URL,
			init: RequestInit | undefined,
		) => Response | null;
	} = {},
): typeof fetch {
	return (async (request: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(request));
		const overridden = options.onRequest?.(url, init);
		if (overridden) return overridden;
		if (url.pathname.endsWith("/git/ref/heads/main")) {
			return Response.json({ object: { sha: BASE_SHA } });
		}
		if (url.pathname.endsWith("/git/ref/heads/useagent%2Fchange-123")) {
			return new Response("not found", { status: 404 });
		}
		if (url.pathname.endsWith(`/git/commits/${BASE_SHA}`)) {
			return Response.json({ sha: BASE_SHA, tree: { sha: BASE_TREE_SHA } });
		}
		if (url.pathname.endsWith("/git/blobs"))
			return Response.json({ sha: BLOB_SHA });
		if (url.pathname.endsWith("/git/trees"))
			return Response.json({ sha: TREE_SHA });
		if (url.pathname.endsWith("/git/commits"))
			return Response.json({ sha: COMMIT_SHA });
		if (url.pathname.endsWith("/git/refs")) return Response.json({});
		if (url.pathname.endsWith("/pulls")) {
			if (options.pullStatus)
				return new Response("failed", { status: options.pullStatus });
			return Response.json({
				number: 17,
				html_url: "https://github.com/acme/widget/pull/17",
			});
		}
		return new Response("unexpected", { status: 500 });
	}) as typeof fetch;
}
