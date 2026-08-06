import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clearRepoCache } from "../src/github/repos";
import { createOrgSession, json, type OrgSession } from "./helpers";

// ---------------------------------------------------------------------------
// GitHub skill-import routes, end-to-end against the real Hono app + test DB,
// with GitHub HTTP mocked at globalThis.fetch (the same seam github-app-auth.test
// uses). A PAT in env forces resolveGithubAuth down the no-network path, so every
// api.github.com call is served from an in-memory repo fixture. Non-github
// requests pass through, so the in-process app fetch is untouched.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;

interface FakeFile {
  text: string;
  /** Declared byte size (defaults to the text length); set large to test the cap. */
  size?: number;
}
interface Fixture {
  defaultBranch: string;
  commitSha: string;
  files: Record<string, FakeFile>;
}

// Module-scoped so the fetch mock (installed once) always reads the current one.
let fixture: Fixture;

function canonicalDoc(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---

# ${name}

${description}

## Overview
- context

## Procedure
1. step a

## Verify
- check
`;
}

function defaultFixture(): Fixture {
  return {
    defaultBranch: "main",
    commitSha: "sha-1111111",
    files: {
      ".claude/skills/deploy/SKILL.md": { text: canonicalDoc("Deploy", "How we ship") },
      "skills/lint/SKILL.md": { text: "# Lint\n\njust lint the code\n" }, // no frontmatter
      "docs/big/SKILL.md": { text: "x", size: 70_000 }, // over the 64KB cap
      "README.md": { text: "not a skill" }, // ignored
    },
  };
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const fileSize = (f: FakeFile): number => f.size ?? Buffer.byteLength(f.text, "utf8");
const blobShaFor = (path: string): string =>
  "blob-" + Buffer.from(path, "utf8").toString("hex").slice(0, 24);
const json200 = (obj: unknown): Response =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function installGithubMock(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "api.github.com") return realFetch(input as never, init);
    const p = url.pathname;

    if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) {
      return json200({ default_branch: fixture.defaultBranch });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/commits\/.+$/.test(p)) {
      return json200({ sha: fixture.commitSha, commit: { tree: { sha: `tree-${fixture.commitSha}` } } });
    }
    if (/^\/repos\/[^/]+\/[^/]+\/git\/trees\/[^/]+$/.test(p)) {
      const tree = Object.entries(fixture.files).map(([path, f]) => ({
        path,
        type: "blob",
        sha: blobShaFor(path),
        size: fileSize(f),
      }));
      return json200({ sha: "tree", tree, truncated: false });
    }
    const blob = /^\/repos\/[^/]+\/[^/]+\/git\/blobs\/(.+)$/.exec(p);
    if (blob) {
      const entry = Object.entries(fixture.files).find(([path]) => blobShaFor(path) === blob[1]);
      if (!entry) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return json200({ content: b64(entry[1].text), encoding: "base64", size: fileSize(entry[1]) });
    }
    const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(p);
    if (contents) {
      const path = decodeURIComponent(contents[1]);
      const f = fixture.files[path];
      if (!f) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return json200({
        type: "file",
        encoding: "base64",
        content: b64(f.text),
        size: fileSize(f),
        sha: blobShaFor(path),
        path,
      });
    }
    throw new Error(`unexpected GitHub fetch: ${url}`);
  }) as unknown as typeof fetch;
}

let A: OrgSession;
let B: OrgSession;

beforeAll(async () => {
  process.env.GITHUB_TOKEN = "ghp_faketest_import"; // PAT path: no network for auth
  clearRepoCache();
  installGithubMock();
  A = await createOrgSession("imp-a");
  B = await createOrgSession("imp-b");
});

afterAll(() => {
  globalThis.fetch = realFetch;
  delete process.env.GITHUB_TOKEN;
  clearRepoCache();
});

beforeEach(() => {
  fixture = defaultFixture();
});

const DEPLOY = ".claude/skills/deploy/SKILL.md";
const LINT = "skills/lint/SKILL.md";
const BIG = "docs/big/SKILL.md";

describe("GET /api/skills/import/scan", () => {
  test("lists SKILL.md candidates, frontmatter vs dir-name, skips oversize + non-SKILL", async () => {
    const scan = await json<any>(`/api/skills/import/scan?repo=acme/tools`, { cookies: A.cookies });
    expect(scan.status).toBe(200);
    expect(scan.body.sha).toBe("sha-1111111");

    const paths = scan.body.candidates.map((c: any) => c.path).sort();
    expect(paths).toEqual([DEPLOY, LINT]);

    const deploy = scan.body.candidates.find((c: any) => c.path === DEPLOY);
    expect(deploy.name).toBe("Deploy"); // from frontmatter
    expect(deploy.description).toBe("How we ship");
    expect(deploy.alreadyImported).toBe(false);

    const lint = scan.body.candidates.find((c: any) => c.path === LINT);
    expect(lint.name).toBe("lint"); // dir-name fallback (no frontmatter)

    // Oversize file surfaced under skipped, never as a candidate.
    expect(scan.body.skipped).toEqual([{ path: BIG, sizeBytes: 70_000, reason: "too_large" }]);
  });

  test("a malformed repo ref is a 400 before any lookup", async () => {
    const bad = await json<any>(`/api/skills/import/scan?repo=notaref`, { cookies: A.cookies });
    expect(bad.status).toBe(400);
  });
});

describe("POST /api/skills/import — created / updated / unchanged idempotency", () => {
  test("first import creates; re-import unchanged; content change updates + bumps version", async () => {
    // Use a repo name unique to this test so imported rows don't collide with others.
    const repo = "acme/idem";

    const imp1 = await json<any>(`/api/skills/import`, {
      method: "POST",
      cookies: A.cookies,
      body: { repo, paths: [DEPLOY, LINT] },
    });
    expect(imp1.status).toBe(200);
    expect(imp1.body.sha).toBe("sha-1111111");
    const a1 = Object.fromEntries(imp1.body.results.map((r: any) => [r.path, r]));
    expect(a1[DEPLOY].action).toBe("created");
    expect(a1[DEPLOY].version).toBe(1);
    expect(a1[LINT].action).toBe("created");

    // Re-import identical bytes -> every path is unchanged (idempotent).
    const imp2 = await json<any>(`/api/skills/import`, {
      method: "POST",
      cookies: A.cookies,
      body: { repo, paths: [DEPLOY, LINT] },
    });
    expect(imp2.status).toBe(200);
    for (const r of imp2.body.results) {
      expect(r.action).toBe("unchanged");
      expect(r.version).toBe(1);
    }

    // Change one file's content and advance HEAD -> that one updates to v2; the
    // untouched one stays unchanged.
    fixture.files[DEPLOY].text = canonicalDoc("Deploy", "How we ship faster");
    fixture.commitSha = "sha-2222222";
    const imp3 = await json<any>(`/api/skills/import`, {
      method: "POST",
      cookies: A.cookies,
      body: { repo, paths: [DEPLOY, LINT] },
    });
    expect(imp3.body.sha).toBe("sha-2222222");
    const a3 = Object.fromEntries(imp3.body.results.map((r: any) => [r.path, r]));
    expect(a3[DEPLOY].action).toBe("updated");
    expect(a3[DEPLOY].version).toBe(2);
    expect(a3[LINT].action).toBe("unchanged");

    // The skill row reflects the new content at version 2.
    const list = await json<{ skills: any[] }>(`/api/skills`, { cookies: A.cookies });
    const deploySkill = list.body.skills.find((s) => s.name === "Deploy");
    expect(deploySkill.current_version).toBe(2);
    expect(deploySkill.description).toBe("How we ship faster");

    // Scan now marks the imported paths as alreadyImported for this org.
    const scan = await json<any>(`/api/skills/import/scan?repo=${repo}`, { cookies: A.cookies });
    const deployC = scan.body.candidates.find((c: any) => c.path === DEPLOY);
    expect(deployC.alreadyImported).toBe(true);
  });

  test("oversize is skipped and an unknown path is not_found", async () => {
    const imp = await json<any>(`/api/skills/import`, {
      method: "POST",
      cookies: A.cookies,
      body: { repo: "acme/skip", paths: [BIG, "nope/SKILL.md"] },
    });
    expect(imp.status).toBe(200);
    const byPath = Object.fromEntries(imp.body.results.map((r: any) => [r.path, r]));
    expect(byPath[BIG]).toMatchObject({ action: "skipped", reason: "too_large" });
    expect(byPath["nope/SKILL.md"]).toMatchObject({ action: "skipped", reason: "not_found" });
  });

  test("empty paths and malformed repo are 400", async () => {
    const noPaths = await json<any>(`/api/skills/import`, {
      method: "POST",
      cookies: A.cookies,
      body: { repo: "acme/tools", paths: [] },
    });
    expect(noPaths.status).toBe(400);
    const badRepo = await json<any>(`/api/skills/import`, {
      method: "POST",
      cookies: A.cookies,
      body: { repo: "bogus", paths: [DEPLOY] },
    });
    expect(badRepo.status).toBe(400);
  });
});

describe("org isolation", () => {
  test("org A's imports are invisible to org B; B imports its own copy", async () => {
    fixture = {
      defaultBranch: "main",
      commitSha: "sha-iso1",
      files: { "pkg/iso/SKILL.md": { text: canonicalDoc("IsoSkill", "only A at first") } },
    };
    const repo = "iso/repo";
    const P = "pkg/iso/SKILL.md";

    const impA = await json<any>(`/api/skills/import`, {
      method: "POST",
      cookies: A.cookies,
      body: { repo, paths: [P] },
    });
    expect(impA.body.results[0].action).toBe("created");

    // A sees the skill; B does not.
    const listA = await json<{ skills: any[] }>(`/api/skills`, { cookies: A.cookies });
    expect(listA.body.skills.some((s) => s.name === "IsoSkill")).toBe(true);
    const listB = await json<{ skills: any[] }>(`/api/skills`, { cookies: B.cookies });
    expect(listB.body.skills.some((s) => s.name === "IsoSkill")).toBe(false);

    // B's scan of the SAME repo path shows alreadyImported:false (A's import is
    // another tenant's data), and B can import its own independent copy.
    const scanB = await json<any>(`/api/skills/import/scan?repo=${repo}`, { cookies: B.cookies });
    const candB = scanB.body.candidates.find((c: any) => c.path === P);
    expect(candB.alreadyImported).toBe(false);

    const impB = await json<any>(`/api/skills/import`, {
      method: "POST",
      cookies: B.cookies,
      body: { repo, paths: [P] },
    });
    expect(impB.body.results[0].action).toBe("created");
    expect(impB.body.results[0].skillId).not.toBe(impA.body.results[0].skillId);
  });
});
