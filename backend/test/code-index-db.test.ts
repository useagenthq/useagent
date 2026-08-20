import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import "../src/index"; // run committed migrations (incl. 0048_context_index) before DB assertions
import { ready as knowledgeReady, sql as knowledgeSql } from "../src/knowledge/store";
import { extractRepoRecords, type RepoFile } from "../src/context/code/extractor";
import { projectCode } from "../src/context/code/projector";
import {
  getContextBySourceRef,
  searchContext,
  upsertContextRow,
} from "../src/context/store";
import {
  executeContextTool,
  setCodeFileReaderForTest,
} from "../src/knowledge/gateway/context-tools";
import type { ToolTokenClaims } from "../src/knowledge/gateway/token";

// ---------------------------------------------------------------------------
// Repository code kind (self_improving.md section 5), DB-backed. Proves code
// records project into context_index, context_search ranks + repo-filters them,
// context_read returns the cited excerpt with provenance and fails closed
// cross-org, and the YOFIX end-to-end proof: a fixture repo with a *.yofix.dev
// CORS allowlist becomes a searchable code record whose context_read returns the
// cited line. In-test fixture only - no live clone (the file reader is injected).
// ---------------------------------------------------------------------------

const org = `org-code-${crypto.randomUUID()}`;
const otherOrg = `org-code-other-${crypto.randomUUID()}`;
const REPO = "upstream-org/loop-dns";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function claimsFor(orgId: string): ToolTokenClaims {
  return {
    orgId,
    userId: "user-code",
    threadId: "thread-code",
    runId: "run-code",
    scope: "run",
    exp: Date.now() + 60_000,
  };
}

function file(path: string, text: string): RepoFile {
  return { path, text, sizeBytes: Buffer.byteLength(text, "utf8") };
}

/** The fixture repo file that carries the *.yofix.dev CORS allowlist. */
const CORS_FILE_PATH = "workers/functions-proxy/src/index.ts";
const CORS_FILE_TEXT = [
  "const ALLOWED_ORIGINS = [",
  '  "https://app.yofix.dev",',
  '  "https://preview.yofix.dev",',
  '  "https://staging.yofix.dev",',
  "];",
  "export function corsAllows(origin: string): boolean {",
  "  return ALLOWED_ORIGINS.includes(origin);",
  "}",
].join("\n");

/** Extract + project a fixture repo's records into context_index for `orgId`. */
async function indexFixtureRepo(orgId: string, files: RepoFile[]): Promise<void> {
  const { records } = extractRepoRecords(files);
  for (const record of records) {
    const projection = projectCode({ repo: REPO, commitSha: SHA }, record);
    await upsertContextRow({ ...projection, orgId });
  }
}

async function cleanupOrg(orgId: string): Promise<void> {
  await knowledgeSql`DELETE FROM context_index WHERE org_id = ${orgId}`;
}

beforeAll(async () => {
  await knowledgeReady();
  await indexFixtureRepo(org, [
    file(CORS_FILE_PATH, CORS_FILE_TEXT),
    file("README.md", "# Loop DNS\n\nEdge proxy for preview traffic."),
    file("wrangler.toml", 'name = "functions-proxy"\nmain = "workers/functions-proxy/src/index.ts"'),
  ]);
});

afterEach(() => setCodeFileReaderForTest(null));

afterAll(async () => {
  await cleanupOrg(org);
  await cleanupOrg(otherOrg);
});

describe("code projection into context_index", () => {
  test("the CORS file's domain record lands as kind=code with a code: source_ref", async () => {
    const ref = `code:${REPO}@${SHA}:${CORS_FILE_PATH}#L2`;
    const row = await getContextBySourceRef(org, ref);
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("code");
    expect(row?.searchable_text).toContain("app.yofix.dev");
  });
});

describe("context_search (code)", () => {
  test("yofix is discoverable via search and the hit is kind=code", async () => {
    const hits = await searchContext({ orgId: org, query: "yofix" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.kind === "code")).toBe(true);
    expect(hits.some((h) => h.snippet.includes("yofix.dev"))).toBe(true);
  });

  test("the repo filter narrows to that repo's code rows", async () => {
    const inRepo = await searchContext({ orgId: org, query: "yofix", repo: REPO });
    expect(inRepo.length).toBeGreaterThan(0);
    expect(inRepo.every((h) => h.source_ref.startsWith(`code:${REPO}@`))).toBe(true);

    const otherRepo = await searchContext({
      orgId: org,
      query: "yofix",
      repo: "Someone/unrelated-repo",
    });
    expect(otherRepo).toHaveLength(0);
  });

  test("is org-scoped: another org's code rows never appear", async () => {
    await indexFixtureRepo(otherOrg, [file(CORS_FILE_PATH, CORS_FILE_TEXT)]);
    const hits = await searchContext({ orgId: org, query: "yofix" });
    // every hit resolves to THIS org (the row exists in org's projection)
    for (const h of hits) {
      expect(await getContextBySourceRef(org, h.source_ref)).not.toBeNull();
    }
  });

  test("the tool surfaces code kind results with source_ref", async () => {
    const result = await executeContextTool(claimsFor(org), "context_search", {
      query: "yofix preview",
    });
    expect(result.isError).toBeUndefined();
    const results = (result.structuredContent?.results ?? []) as Array<Record<string, unknown>>;
    expect(results.some((r) => r.kind === "code")).toBe(true);
  });
});

describe("context_read (code excerpt + provenance)", () => {
  test("YOFIX PROOF: context_read returns the cited *.yofix.dev line + provenance", async () => {
    // The file reader is injected with the in-test fixture (no live clone).
    setCodeFileReaderForTest(async (repo, sha, path) => {
      expect(repo).toBe(REPO);
      expect(sha).toBe(SHA);
      expect(path).toBe(CORS_FILE_PATH);
      return CORS_FILE_TEXT;
    });
    const ref = `code:${REPO}@${SHA}:${CORS_FILE_PATH}#L2`;
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: ref,
    });
    expect(result.isError).toBeUndefined();
    // the cited line is returned...
    expect(result.content[0]?.text).toContain("app.yofix.dev");
    // ...with full provenance (repo@sha:file#Lline)
    expect(result.content[0]?.text).toContain(`${REPO}@${SHA}:${CORS_FILE_PATH}#L2`);
    expect(result.structuredContent?.kind).toBe("code");
    expect(result.structuredContent?.repo).toBe(REPO);
    expect(result.structuredContent?.line).toBe(2);
  });

  test("cross-org read fails closed: a valid code ref for another org is refused", async () => {
    // otherOrg indexed the same file in the org-scoped test above; a caller in
    // `org` must not read a ref that only exists in otherOrg's projection.
    const onlyOtherRef = `code:${REPO}@${SHA}:only-in-other.ts#L1`;
    await upsertContextRow({
      ...projectCode(
        { repo: REPO, commitSha: SHA },
        { file: "only-in-other.ts", line: 1, facet: "symbol", title: "x", searchableText: "x" },
      ),
      orgId: otherOrg,
    });
    setCodeFileReaderForTest(async () => "should never be read");
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: onlyOtherRef,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not available to your organization");
  });

  test("an unindexed code ref is refused (org gate fires before any repo fetch)", async () => {
    // The org gate (projection lookup) runs first, so a ref this org never
    // indexed is refused without ever touching the repo. (Malformed-ref PARSING
    // is covered purely in code-index-extractor.test.ts via parseCodeRef.)
    setCodeFileReaderForTest(async () => "should never be read");
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: `code:${REPO}@notasha:file.ts#L1`,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not available to your organization");
  });

  test("a file that vanished at the commit is reported honestly (not fabricated)", async () => {
    setCodeFileReaderForTest(async () => null);
    const ref = `code:${REPO}@${SHA}:${CORS_FILE_PATH}#L2`;
    const result = await executeContextTool(claimsFor(org), "context_read", {
      source_ref: ref,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no longer readable");
  });
});
