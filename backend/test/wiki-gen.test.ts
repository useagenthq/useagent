import { beforeAll, describe, expect, test } from "bun:test";
import { createOrgSession, json, type OrgSession } from "./helpers";
import { generateWiki, pageSlug } from "../src/wiki-gen/generate";
import {
  type ChatMessage,
  isRetryableWikiLlmError,
  openRouterLlm,
  type WikiLlm,
  WikiLlmError,
} from "../src/wiki-gen/llm";

// ---------------------------------------------------------------------------
// Repo-wiki generator core (path b of the deepwiki-eval spike). Drives
// generateWiki with in-memory files + an injected deterministic LLM (no clone,
// no network), and proves through the real wiki/knowledge substrate:
//   - a first run publishes one document + revision per page, searchable;
//   - regeneration is idempotent — unchanged inputs append NO new revision;
//   - a changed source file regenerates ONLY that page (new revision);
//   - a transient page failure never overwrites good published content;
//   - documents are org-scoped (another org sees nothing).
// LLM keys are stripped by the test preload, so the route is inert (503); the
// generation core is exercised directly with the injected fake.
// ---------------------------------------------------------------------------

const OWNER = "acme";

test("OpenRouter wiki errors distinguish transient failures from permanent configuration errors", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";

  try {
    globalThis.fetch = (async () => new Response("invalid key", { status: 401 })) as typeof fetch;
    const permanent = await openRouterLlm([{ role: "user", content: "structure" }]).catch(
      (error: unknown) => error,
    );
    expect(permanent).toBeInstanceOf(WikiLlmError);
    expect(isRetryableWikiLlmError(permanent)).toBe(false);

    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    const transient = await openRouterLlm([{ role: "user", content: "structure" }]).catch(
      (error: unknown) => error,
    );
    expect(transient).toBeInstanceOf(WikiLlmError);
    expect(isRetryableWikiLlmError(transient)).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
  }
});
const REPO = "demo";
const CANARY = "zephyrcanary";

const STRUCTURE_XML = `
<wiki_structure>
  <title>Demo Wiki</title>
  <description>A demo repository.</description>
  <pages>
    <page id="page-1">
      <title>Overview</title>
      <importance>high</importance>
      <relevant_files>
        <file_path>README.md</file_path>
        <file_path>src/index.ts</file_path>
      </relevant_files>
    </page>
    <page id="page-2">
      <title>Utilities</title>
      <importance>medium</importance>
      <relevant_files>
        <file_path>src/util.ts</file_path>
      </relevant_files>
    </page>
  </pages>
</wiki_structure>`;

/** Deterministic fake LLM: returns the structure XML for the structure prompt,
 *  and for a page prompt echoes the topic + a canary + a marker derived from the
 *  prompt length (so a changed source file yields changed page content). */
function makeFakeLlm(): { llm: WikiLlm; calls: number } {
  const state = { calls: 0 };
  const llm: WikiLlm = async (messages: ChatMessage[]) => {
    state.calls += 1;
    const prompt = messages[messages.length - 1]!.content;
    if (!prompt.includes("[WIKI_PAGE_TOPIC]")) return STRUCTURE_XML;
    const m = prompt.match(/\[WIKI_PAGE_TOPIC\]:\s*(.+)/);
    const topic = m ? m[1]!.trim() : "Page";
    return (
      `# ${topic}\n\nThis page covers ${topic}. Search token ${CANARY}.\n\n` +
      `<!-- inputlen:${prompt.length} -->\n\n` +
      `Sources: [src/index.ts:1-2]()\n`
    );
  };
  return { llm, calls: 0, get calls() { return state.calls; } } as unknown as { llm: WikiLlm; calls: number };
}

function baseFiles(): Map<string, string> {
  return new Map([
    ["README.md", "# DemoRepo\n\nA small demo repository."],
    ["src/index.ts", "export const x = 1;\nexport const y = 2;\n"],
    ["src/util.ts", "export function add(a: number, b: number) {\n  return a + b;\n}\n"],
  ]);
}

async function revisionCount(cookies: string, documentId: string): Promise<number> {
  const { body } = await json<any>(`/api/knowledge/documents/${documentId}`, { cookies });
  return (body.revisions ?? []).length;
}

let orgA: OrgSession;
let orgB: OrgSession;

describe("repo-wiki generator", () => {
  beforeAll(async () => {
    orgA = await createOrgSession("wg-a");
    orgB = await createOrgSession("wg-b");
  });

  test("first run: publishes one document + revision per page, searchable", async () => {
    const { llm } = makeFakeLlm();
    const res = await generateWiki({
      orgId: orgA.orgId,
      userId: null,
      owner: OWNER,
      repo: REPO,
      defaultBranch: "main",
      files: baseFiles(),
      llm,
    });

    expect(res.counts).toEqual({ created: 2, updated: 0, unchanged: 0, failed: 0 });
    expect(res.pages.map((p) => p.slug).sort()).toEqual([
      pageSlug(OWNER, REPO, "page-1"),
      pageSlug(OWNER, REPO, "page-2"),
    ]);

    // Each page is a published document with exactly one revision.
    const A = { cookies: orgA.cookies };
    const list = await json<any>("/api/knowledge/documents?status=all", A);
    const slugs = new Set(list.body.documents.map((d: any) => d.slug));
    expect(slugs.has(pageSlug(OWNER, REPO, "page-1"))).toBe(true);
    expect(slugs.has(pageSlug(OWNER, REPO, "page-2"))).toBe(true);

    const overview = res.pages.find((p) => p.id === "page-1")!;
    expect(await revisionCount(orgA.cookies, overview.documentId!)).toBe(1);

    // Citations were resolved to real blob links, and the content is searchable.
    const doc = await json<any>(`/api/knowledge/documents/${overview.documentId}`, A);
    expect(doc.body.document.status).toBe("published");
    expect(doc.body.document.content).toContain(
      "https://github.com/acme/demo/blob/main/src/index.ts",
    );
    const search = await json<any>("/api/knowledge/search", {
      method: "POST",
      body: { query: CANARY, k: 10 },
      ...A,
    });
    expect((search.body.results ?? []).length).toBeGreaterThan(0);
  });

  test("regeneration with unchanged inputs appends NO new revision", async () => {
    const { llm } = makeFakeLlm();
    const res = await generateWiki({
      orgId: orgA.orgId,
      userId: null,
      owner: OWNER,
      repo: REPO,
      defaultBranch: "main",
      files: baseFiles(),
      llm,
    });
    expect(res.counts).toEqual({ created: 0, updated: 0, unchanged: 2, failed: 0 });
    for (const p of res.pages) {
      expect(await revisionCount(orgA.cookies, p.documentId!)).toBe(1);
    }
  });

  test("a changed source file regenerates ONLY that page", async () => {
    const files = baseFiles();
    files.set("src/util.ts", "export function add(a: number, b: number) {\n  return a + b; // changed\n}\nexport const VERSION = 2;\n");
    const { llm } = makeFakeLlm();
    const res = await generateWiki({
      orgId: orgA.orgId,
      userId: null,
      owner: OWNER,
      repo: REPO,
      defaultBranch: "main",
      files,
      llm,
    });
    expect(res.counts).toEqual({ created: 0, updated: 1, unchanged: 1, failed: 0 });

    const util = res.pages.find((p) => p.id === "page-2")!;
    const overview = res.pages.find((p) => p.id === "page-1")!;
    expect(util.action).toBe("updated");
    expect(await revisionCount(orgA.cookies, util.documentId!)).toBe(2);
    // The untouched page kept its single revision.
    expect(overview.action).toBe("unchanged");
    expect(await revisionCount(orgA.cookies, overview.documentId!)).toBe(1);
  });

  test("a transient page failure does not overwrite good published content", async () => {
    const A = { cookies: orgA.cookies };
    const FAIL_REPO = "failtest"; // isolated from the idempotency repo above

    // 1. Seed good, published content for this repo.
    const { llm } = makeFakeLlm();
    const seed = await generateWiki({
      orgId: orgA.orgId,
      userId: null,
      owner: OWNER,
      repo: FAIL_REPO,
      defaultBranch: "main",
      files: baseFiles(),
      llm,
    });
    expect(seed.counts.created).toBe(2);
    const overview = seed.pages.find((p) => p.id === "page-1")!;
    const goodRevs = await revisionCount(orgA.cookies, overview.documentId!);

    // 2. Regenerate with a CHANGED source (so the fingerprint short-circuit does
    //    NOT skip page-1) but an LLM that fails on every page prompt.
    const changed = baseFiles();
    changed.set("src/index.ts", "export const x = 99; // changed\n");
    const failingLlm: WikiLlm = async (messages) => {
      const prompt = messages[messages.length - 1]!.content;
      if (!prompt.includes("[WIKI_PAGE_TOPIC]")) return STRUCTURE_XML;
      throw new Error("simulated transient LLM failure");
    };
    const res = await generateWiki({
      orgId: orgA.orgId,
      userId: null,
      owner: OWNER,
      repo: FAIL_REPO,
      defaultBranch: "main",
      files: changed,
      llm: failingLlm,
    });
    // page-1's inputs changed -> it attempts and fails; nothing was overwritten.
    expect(res.counts.created).toBe(0);
    expect(res.counts.updated).toBe(0);
    expect(res.counts.failed).toBeGreaterThanOrEqual(1);

    // The good published content is intact: still published, still the canary,
    // no error placeholder, no new revision appended.
    const doc = await json<any>(`/api/knowledge/documents/${overview.documentId}`, A);
    expect(doc.body.document.status).toBe("published");
    expect(doc.body.document.content).toContain(CANARY);
    expect(await revisionCount(orgA.cookies, overview.documentId!)).toBe(goodRevs);
  });

  test("repairs a malformed structure response before generating pages", async () => {
    let structureCalls = 0;
    let repairMessages: ChatMessage[] = [];
    const llm: WikiLlm = async (messages) => {
      if (messages.some((message) => message.content.includes("[WIKI_PAGE_TOPIC]"))) {
        return "# Generated page\n\nGrounded content.";
      }
      structureCalls += 1;
      if (structureCalls === 1) return "Here is the repository outline without XML.";
      repairMessages = messages;
      return STRUCTURE_XML;
    };

    const result = await generateWiki({
      orgId: orgA.orgId,
      userId: null,
      owner: OWNER,
      repo: "structure-repair",
      defaultBranch: "main",
      files: baseFiles(),
      llm,
    });

    expect(structureCalls).toBe(2);
    expect(result.counts.created).toBe(2);
    expect(repairMessages[0]).toEqual({
      role: "system",
      content: expect.stringContaining("untrusted source data"),
    });
    expect(repairMessages).toContainEqual({
      role: "assistant",
      content: "Here is the repository outline without XML.",
    });
    expect(
      repairMessages.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("No valid <wiki_structure> XML found in response"),
      ),
    ).toBe(true);
  });

  test("retries only retryable structure provider failures", async () => {
    let transientCalls = 0;
    const transientLlm: WikiLlm = async (messages) => {
      if (messages.some((message) => message.content.includes("[WIKI_PAGE_TOPIC]"))) {
        return "# Generated page";
      }
      transientCalls += 1;
      if (transientCalls === 1) {
        throw new WikiLlmError("openrouter 429: rate limited", { retryable: true });
      }
      return STRUCTURE_XML;
    };
    const transient = await generateWiki({
      orgId: orgA.orgId,
      userId: null,
      owner: OWNER,
      repo: "structure-transient-retry",
      defaultBranch: "main",
      files: baseFiles(),
      llm: transientLlm,
    });
    expect(transientCalls).toBe(2);
    expect(transient.counts.created).toBe(2);

    let permanentCalls = 0;
    const permanentLlm: WikiLlm = async () => {
      permanentCalls += 1;
      throw new WikiLlmError("openrouter 401: invalid key");
    };
    await expect(
      generateWiki({
        orgId: orgA.orgId,
        userId: null,
        owner: OWNER,
        repo: "structure-permanent-failure",
        defaultBranch: "main",
        files: baseFiles(),
        llm: permanentLlm,
      }),
    ).rejects.toThrow("openrouter 401: invalid key");
    expect(permanentCalls).toBe(1);
  });

  test("stops after bounded structure repair attempts", async () => {
    let structureCalls = 0;
    const llm: WikiLlm = async () => {
      structureCalls += 1;
      return "Still not the required XML.";
    };

    await expect(
      generateWiki({
        orgId: orgA.orgId,
        userId: null,
        owner: OWNER,
        repo: "structure-repair-exhausted",
        defaultBranch: "main",
        files: baseFiles(),
        llm,
      }),
    ).rejects.toThrow("No valid <wiki_structure> XML found in response");
    expect(structureCalls).toBe(3);
  });

  test("documents are org-scoped: another org sees nothing", async () => {
    const B = { cookies: orgB.cookies };
    const list = await json<any>("/api/knowledge/documents?status=all", B);
    const slugs = new Set(list.body.documents.map((d: any) => d.slug));
    expect(slugs.has(pageSlug(OWNER, REPO, "page-1"))).toBe(false);
    expect(slugs.has(pageSlug(OWNER, REPO, "page-2"))).toBe(false);

    const search = await json<any>("/api/knowledge/search", {
      method: "POST",
      body: { query: CANARY, k: 10 },
      ...B,
    });
    expect((search.body.results ?? []).length).toBe(0);
  });

  test("route is inert without an LLM key (503) and unknown jobs 404", async () => {
    const A = { cookies: orgA.cookies };
    const gen = await json<any>("/api/wiki/generate", { method: "POST", body: { repo: "acme/demo" }, ...A });
    expect(gen.status).toBe(503);
    const poll = await json<any>("/api/wiki/generate/does-not-exist", A);
    expect(poll.status).toBe(404);
  });
});
