import { describe, expect, test } from "bun:test";
import {
  classifyExcluded,
  extractRepoRecords,
  MAX_FILE_BYTES,
  type RepoFile,
} from "../src/context/code/extractor";
import { codeSourceRef, parseCodeRef, projectCode } from "../src/context/code/projector";

// ---------------------------------------------------------------------------
// Repository code extractor (self_improving.md section 5), unit-tested pure - no
// clone, no DB. Proves: what is indexed vs excluded (5.1/5.2), that a secret
// fixture NEVER lands in a record (section 10), the provenance source_ref shape,
// and the yofix proof (a *.yofix.dev CORS allowlist becomes a searchable record).
// ---------------------------------------------------------------------------

function file(path: string, text: string): RepoFile {
  return { path, text, sizeBytes: Buffer.byteLength(text, "utf8") };
}

describe("classifyExcluded (5.2 what NOT to index)", () => {
  test("excludes vendored, generated, lockfiles, and secret stores; indexes real source", () => {
    expect(classifyExcluded("node_modules/foo/index.js")).toBe("vendored");
    expect(classifyExcluded("vendor/lib/x.go")).toBe("vendored");
    expect(classifyExcluded("dist/bundle.js")).toBe("generated");
    expect(classifyExcluded("build/out.css")).toBe("generated");
    expect(classifyExcluded(".next/static/chunk.js")).toBe("generated");
    expect(classifyExcluded("bun.lock")).toBe("lockfile");
    expect(classifyExcluded("package-lock.json")).toBe("lockfile");
    expect(classifyExcluded("go.sum")).toBe("lockfile");
    // secret stores are excluded by path before ever being read
    expect(classifyExcluded(".env")).toBe("secret_store");
    expect(classifyExcluded(".env.production")).toBe("secret_store");
    expect(classifyExcluded("certs/server.pem")).toBe("secret_store");
    expect(classifyExcluded("config/credentials.json")).toBe("secret_store");
    expect(classifyExcluded("infra/secrets.yaml")).toBe("secret_store");
    expect(classifyExcluded("deploy/id_rsa")).toBe("secret_store");
    // real source + docs are indexable
    expect(classifyExcluded("src/index.ts")).toBeNull();
    expect(classifyExcluded("README.md")).toBeNull();
    expect(classifyExcluded("docs/secrets.md")).toBeNull(); // a human doc, not a store
    expect(classifyExcluded("workers/wrangler.toml")).toBeNull();
  });
});

describe("extractRepoRecords (5.1 what to index)", () => {
  test("indexes markdown headings, SKILL.md metadata, config pairs, symbols, CI + manifests", () => {
    const { records } = extractRepoRecords([
      file("README.md", "# Loop DNS\n\nProxies preview traffic.\n## Setup\nRun it."),
      file(
        ".claude/skills/deploy/SKILL.md",
        "---\nname: Deploy Preview\ndescription: Ship a PR preview\n---\n# body",
      ),
      // a plain (non-manifest) config file -> facet "config"
      file("config/app.ini", "region = us-east\nreplicas = 3"),
      // wrangler.toml is a deployment manifest -> facet "manifest"
      file("workers/wrangler.toml", 'name = "functions-proxy"\nmain = "src/index.ts"'),
      file("src/index.ts", "export function handleRequest() {}\nexport const ROUTES = [];"),
      file(".github/workflows/ci.yml", "name: CI\njobs:\n  test:\n    steps:\n      - name: Run tests"),
      file("Dockerfile", "FROM node:20\nENV PORT=8080"),
    ]);
    const byFacet = (f: string) => records.filter((r) => r.facet === f);
    expect(byFacet("doc").some((r) => r.searchableText.includes("Loop DNS"))).toBe(true);
    expect(byFacet("skill").some((r) => r.title.includes("Deploy Preview"))).toBe(true);
    expect(byFacet("config").some((r) => r.searchableText.includes("us-east"))).toBe(true);
    expect(
      byFacet("manifest").some((r) => r.searchableText.includes("functions-proxy")),
    ).toBe(true);
    expect(byFacet("symbol").some((r) => r.searchableText.includes("handleRequest"))).toBe(
      true,
    );
    expect(byFacet("symbol").some((r) => r.searchableText.includes("ROUTES"))).toBe(true);
    expect(byFacet("manifest").some((r) => r.searchableText.includes("CI"))).toBe(true);
    // the Dockerfile is captured as a manifest record (by path)
    expect(byFacet("manifest").some((r) => r.title.includes("Dockerfile"))).toBe(true);
  });

  test("never indexes an excluded/secret-store file (skips it whole)", () => {
    const { records, skipped } = extractRepoRecords([
      file(".env", "OPENAI_API_KEY=sk-verysecretvalue1234567890abcdef"),
      file("node_modules/pkg/index.js", "export const x = 1;"),
      file("bun.lock", "lockfile content"),
    ]);
    expect(records).toHaveLength(0);
    expect(skipped.map((s) => s.reason).sort()).toEqual(
      ["lockfile", "secret_store", "vendored"].sort(),
    );
    // the secret VALUE never appears in any record text
    expect(records.every((r) => !r.searchableText.includes("sk-verysecret"))).toBe(true);
  });

  test("SECRET SAFETY: an inline credential in an INDEXED file is redacted before it lands", () => {
    // A config file that is legitimately indexed but carries an inline secret in a
    // value: the extractor drops secret-NAMED keys and the redactor scrubs the rest.
    const { records } = extractRepoRecords([
      file(
        "config/app.toml",
        [
          'service_url = "https://api.yofix.dev"',
          'api_key = "sk-livesecretkey0123456789abcdefabcd"',
          "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
        ].join("\n"),
      ),
    ]);
    const allText = records.map((r) => r.searchableText).join("\n");
    // the non-secret endpoint survives
    expect(allText).toContain("api.yofix.dev");
    // the secret key (name matched) is dropped; its value never appears
    expect(allText).not.toContain("sk-livesecretkey");
    expect(allText).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  test("does not index every source line: a code file yields NAMES/filename, not the body", () => {
    const body = "export function foo() {\n  const secretInternal = computeThing(42);\n  return secretInternal + 1;\n}";
    const { records } = extractRepoRecords([file("src/thing.ts", body)]);
    const text = records.map((r) => r.searchableText).join("\n");
    expect(text).toContain("foo"); // exported symbol name
    expect(text).toContain("src/thing.ts"); // filename
    expect(text).not.toContain("computeThing(42)"); // NOT the body
  });

  test("an over-size file is skipped as too_large, never read into a record", () => {
    const huge = file("docs/BIG.md", "x");
    huge.sizeBytes = MAX_FILE_BYTES + 1;
    const { records, skipped } = extractRepoRecords([huge]);
    expect(records).toHaveLength(0);
    expect(skipped[0]?.reason).toBe("too_large");
  });
});

describe("yofix proof (extractor)", () => {
  test("a *.yofix.dev CORS allowlist produces a searchable domain record", () => {
    const corsFile = file(
      "workers/functions-proxy/src/index.ts",
      [
        "const ALLOWED_ORIGINS = [",
        '  "https://app.yofix.dev",',
        '  "https://preview.yofix.dev",',
        '  "https://staging.yofix.dev",',
        "];",
        "export function cors(origin: string) {",
        "  return ALLOWED_ORIGINS.includes(origin);",
        "}",
      ].join("\n"),
    );
    const { records } = extractRepoRecords([corsFile]);
    const domainRec = records.find((r) => r.facet === "domain");
    expect(domainRec).toBeDefined();
    expect(domainRec!.searchableText).toContain("app.yofix.dev");
    // the anchored line is where the first domain appears (for provenance)
    expect(domainRec!.line).toBe(2);
  });
});

describe("code source_ref provenance", () => {
  const prov = { repo: "upstream-org/loop-dns", commitSha: "a".repeat(40) };

  test("codeSourceRef builds code:<repo>@<sha>:<file>#L<line>", () => {
    const ref = codeSourceRef(prov, {
      file: "workers/functions-proxy/src/index.ts",
      line: 17,
      facet: "domain",
      title: "domains index.ts",
      searchableText: "app.yofix.dev",
    });
    expect(ref).toBe(
      `code:upstream-org/loop-dns@${"a".repeat(40)}:workers/functions-proxy/src/index.ts#L17`,
    );
  });

  test("parseCodeRef round-trips the ref back to repo/commit/file/line", () => {
    const ref = `code:upstream-org/loop-dns@${"a".repeat(40)}:workers/functions-proxy/src/index.ts#L17`;
    const parsed = parseCodeRef(ref);
    expect(parsed).toEqual({
      repo: "upstream-org/loop-dns",
      commitSha: "a".repeat(40),
      file: "workers/functions-proxy/src/index.ts",
      line: 17,
    });
  });

  test("parseCodeRef fails closed on malformed refs", () => {
    expect(parseCodeRef("knowledge:abc")).toBeNull();
    expect(parseCodeRef("code:no-slash@sha:file#L1")).toBeNull();
    expect(parseCodeRef("code:o/n@notasha:file#L1")).toBeNull();
    expect(parseCodeRef("code:o/n@" + "a".repeat(40) + ":file")).toBeNull(); // no #L
    expect(parseCodeRef("code:o/n@" + "a".repeat(40) + ":file#L0")).toBeNull(); // line >= 1
  });

  test("projectCode emits kind=code with the provenance source_ref and title", () => {
    const p = projectCode(prov, {
      file: "workers/functions-proxy/src/index.ts",
      line: 2,
      facet: "domain",
      title: "domains index.ts",
      searchableText: "app.yofix.dev\npreview.yofix.dev",
    });
    expect(p.kind).toBe("code");
    expect(p.sourceRef).toBe(
      `code:upstream-org/loop-dns@${"a".repeat(40)}:workers/functions-proxy/src/index.ts#L2`,
    );
    expect(p.title).toContain("upstream-org/loop-dns");
    expect(p.searchableText).toContain("yofix.dev");
    expect(p.version).toBeNull();
  });
});
