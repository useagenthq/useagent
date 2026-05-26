import { createSecretRedactor, type SecretRedactor } from "../../secrets/redact";

// ---------------------------------------------------------------------------
// Repository code extractor (self_improving.md section 5). Turns the files of a
// cloned repo into a bounded set of searchable CODE records for context_index.
// PURE + DB-free: it takes {path, text} pairs and returns records; the sweep
// (index-sweep.ts) owns the clone/pacing/projection. Every extracted value runs
// through the secret redactor (section 10) BEFORE it leaves this module, and a
// file that LOOKS like a secret store is skipped whole (never opened for text).
//
// What we index (5.1): markdown/runbooks, SKILL.md metadata, non-secret config
// keys+values, domain names + service endpoints, exported symbols + filenames,
// deployment manifests + CI workflow names. What we do NOT index (5.2): generated
// output, lockfiles, vendored deps, binaries, secrets/encrypted values, and never
// every source line. Each record carries repo + commit + file + line provenance.
// ---------------------------------------------------------------------------

/** A file the sweep read from the clone (repo-relative path + raw bytes as text). */
export interface RepoFile {
  path: string;
  text: string;
  sizeBytes: number;
}

/** One extracted, redacted code record ready to project as kind="code". The line
 *  is the anchor of the extracted content (1-based); provenance is built from
 *  repo + commit + file + line at projection time. */
export interface CodeRecord {
  /** Repo-relative file path this record came from. */
  file: string;
  /** 1-based line the extracted content anchors to (for the `#Ln` provenance). */
  line: number;
  /** What kind of evidence this is (drives the title prefix + ranking hints). */
  facet: "doc" | "skill" | "config" | "domain" | "symbol" | "manifest";
  /** Short human title, e.g. "config workers/wrangler.toml" or "domains index.ts". */
  title: string;
  /** The extracted identifiers/config/domains + a small surrounding context
   *  window, already secret-redacted. This is the FTS corpus for the record. */
  searchableText: string;
}

/** Why a file was skipped (surfaced in the sweep summary, never silent). */
export type SkipReason =
  | "secret_store"
  | "generated"
  | "lockfile"
  | "vendored"
  | "binary"
  | "too_large"
  | "unindexed_extension";

export interface ExtractOutcome {
  records: CodeRecord[];
  skipped: { path: string; reason: SkipReason }[];
}

// --- Bounds (per file) -----------------------------------------------------
/** Files above this are skipped as too_large (a huge doc/config is noise + risk). */
export const MAX_FILE_BYTES = 512 * 1024;
/** Cap the extracted corpus per file so one file cannot dominate the index. */
const MAX_RECORD_TEXT = 4_000;
/** Cap records emitted from a single file. */
const MAX_RECORDS_PER_FILE = 40;

// --- Classification --------------------------------------------------------

/** A path segment (dir or filename) that marks vendored / generated trees. Any
 *  file UNDER one of these is skipped whole. */
const EXCLUDED_DIR_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "third_party",
  "bower_components",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".terraform",
  "generated",
  "__generated__",
]);

/** Lockfiles (deps pin state, never org evidence). Matched on basename. */
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "cargo.lock",
  "go.sum",
  "pipfile.lock",
]);

/** Filenames / suffixes that mark a SECRET STORE - never opened for text. Section
 *  10: never index a file that looks like a secret store. */
const SECRET_STORE_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
  ".ppk",
  ".asc",
  ".gpg",
];

/** Basenames (and basename prefixes) that mark a secret store. */
function looksLikeSecretStore(path: string): boolean {
  const base = (path.split("/").pop() ?? "").toLowerCase();
  if (SECRET_STORE_SUFFIXES.some((s) => base.endsWith(s))) return true;
  // .env, .env.local, .env.production ...
  if (base === ".env" || base.startsWith(".env.")) return true;
  // secrets.* / credentials.* (but keep human docs like secrets.md indexable)
  if (/(^|[._-])secrets?([._-]|$)/.test(base) && !base.endsWith(".md")) return true;
  if (/(^|[._-])credentials?([._-]|$)/.test(base) && !base.endsWith(".md")) return true;
  if (base === "id_rsa" || base === "id_ed25519" || base.startsWith("id_rsa.")) return true;
  return false;
}

/** Binary sniff: a NUL byte in the first slice means "not text". */
function looksBinary(text: string): boolean {
  const end = Math.min(text.length, 8_000);
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}

const MARKDOWN_EXT = new Set([".md", ".mdx", ".markdown", ".rst", ".txt"]);
const CONFIG_EXT = new Set([
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
]);
const YAML_EXT = new Set([".yml", ".yaml"]);
const JSON_EXT = new Set([".json", ".json5", ".jsonc"]);
const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".php",
  ".c",
  ".h",
  ".cpp",
  ".cs",
  ".swift",
]);

function ext(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function isSkillMd(path: string): boolean {
  return basename(path).toLowerCase() === "skill.md";
}

/** A GitHub Actions / CI workflow file (`.github/workflows/*.yml`). */
function isCiWorkflow(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

/** A deployment manifest by well-known basename (k8s/compose/wrangler/etc.). */
const MANIFEST_BASENAMES = new Set([
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "wrangler.toml",
  "vercel.json",
  "netlify.toml",
  "fly.toml",
  "render.yaml",
  "procfile",
  "serverless.yml",
  "serverless.yaml",
  "kustomization.yaml",
  "kustomization.yml",
]);

function isManifest(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (MANIFEST_BASENAMES.has(base)) return true;
  if (base.startsWith("dockerfile.")) return true;
  // k8s manifests under a deploy/ or k8s/ tree
  if (/(^|\/)(k8s|deploy|manifests|charts)\//.test(path) && YAML_EXT.has(ext(path))) {
    return true;
  }
  return false;
}

/** First reason a path is excluded whole, or null if the path is indexable. */
export function classifyExcluded(path: string): SkipReason | null {
  const parts = path.split("/");
  if (parts.some((p) => EXCLUDED_DIR_SEGMENTS.has(p))) {
    if (
      parts.some(
        (p) =>
          p === "node_modules" ||
          p === "vendor" ||
          p === "third_party" ||
          p === "bower_components",
      )
    ) {
      return "vendored";
    }
    return "generated";
  }
  if (LOCKFILE_BASENAMES.has(basename(path).toLowerCase())) return "lockfile";
  if (looksLikeSecretStore(path)) return "secret_store";
  return null;
}

// --- Extractors (per facet) ------------------------------------------------

/** TLD-position tokens that are really file extensions, not domains. */
const CODE_LIKE_TLDS = new Set([
  "ts", "js", "py", "go", "rs", "md", "json", "yml", "yaml", "toml", "css",
  "html", "sh", "lock", "sum", "tsx", "jsx", "mjs", "cjs", "png", "jpg", "svg",
]);

/** Domain names + service endpoints in a blob. Captures bare hosts and URLs;
 *  loopback/private/example/file-suffix hosts are dropped as noise. */
const DOMAIN_RE =
  /\b(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;
const DOMAIN_NOISE = new Set([
  "example.com",
  "example.org",
  "localhost.localdomain",
  "schemas.microsoft.com",
  "www.w3.org",
  "schema.org",
]);

function extractDomains(text: string): string[] {
  // Two token sets: the full hosts (exact evidence) and the distinctive bare
  // labels. Postgres FTS parses "app.yofix.dev" as ONE `host` lexeme, so a search
  // for "yofix" never matches the host alone; emitting the labels ("yofix",
  // "yofix.dev") makes an org-specific term in a domain searchable by that word.
  const hosts = new Set<string>();
  const labels = new Set<string>();
  for (const m of text.matchAll(DOMAIN_RE)) {
    const host = m[1]!.toLowerCase();
    if (DOMAIN_NOISE.has(host)) continue;
    if (host.endsWith(".local") || host.endsWith(".internal")) continue;
    const parts = host.split(".");
    const tld = parts[parts.length - 1]!;
    if (CODE_LIKE_TLDS.has(tld)) continue; // .ts/.js/.py etc. are file suffixes
    hosts.add(host);
    // registrable label (second-level) + "label.tld" - the org-identifying words
    if (parts.length >= 2) {
      const second = parts[parts.length - 2]!;
      if (second.length >= 3 && !GENERIC_LABELS.has(second)) {
        labels.add(second);
        labels.add(`${second}.${tld}`);
      }
    }
  }
  return [...hosts, ...labels];
}
/** Second-level labels too generic to add as a bare search token. */
const GENERIC_LABELS = new Set([
  "www", "api", "app", "cdn", "static", "assets", "github", "githubusercontent",
  "google", "googleapis", "amazonaws", "cloudflare", "vercel", "netlify",
]);

/** Exported symbol names from a JS/TS/Python/Go file (best-effort, regex-based -
 *  we index NAMES for discovery, not the bodies). */
function extractExportedSymbols(text: string): string[] {
  const names = new Set<string>();
  const patterns: RegExp[] = [
    /\bexport\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s*\{([^}]*)\}/g,
    /\bexport\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
    /^(?:def|class)\s+([A-Za-z_][\w]*)/gm,
    /\bfunc\s+([A-Z][\w]*)/g,
    /\btype\s+([A-Z][\w]*)\s+(?:struct|interface)\b/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const capture = m[1] ?? "";
      for (const raw of capture.split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }
  return [...names];
}

/** NON-secret config keys + values from a config/YAML/JSON blob, one "key=value"
 *  per line kept. Values still pass through the redactor at the end, so a stray
 *  secret is scrubbed; keys whose NAME implies a secret are dropped outright. */
const SECRET_KEY_RE =
  /(pass(word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|client[_-]?secret)/i;

function extractConfigPairs(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const m = line.match(/^"?([A-Za-z0-9_.\-]+)"?\s*[:=]\s*(.+?)\s*,?$/);
    if (!m) continue;
    const key = m[1]!;
    if (SECRET_KEY_RE.test(key)) continue; // drop secret-named keys entirely
    let value = m[2]!.replace(/^["']|["'],?$/g, "").trim();
    if (!value || value === "{" || value === "[" || value === "|" || value === ">") continue;
    if (value.length > 200) value = `${value.slice(0, 200)}…`;
    out.push({ line: i + 1, text: `${key}=${value}` });
  }
  return out;
}

/** Markdown headings + a lead paragraph -> a compact doc summary corpus. */
function extractMarkdown(text: string): string {
  const lines = text.split("\n");
  const headings: string[] = [];
  const body: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s+/.test(line)) headings.push(line.replace(/^#+\s+/, ""));
    else if (line && !line.startsWith("```") && body.join(" ").length < 1_500) body.push(line);
  }
  return [...headings, "", ...body].join("\n");
}

/** SKILL.md frontmatter name/description (metadata, section 5.1). */
function extractSkillMeta(text: string): { name: string; body: string } {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  let name = "";
  let description = "";
  if (fm) {
    name = fm[1]!.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
    description = fm[1]!.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  }
  if (!name) name = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  return { name, body: [name, description, extractMarkdown(text)].filter(Boolean).join("\n") };
}

/** CI workflow name + job/step names (section 5.1: "CI workflow names"). */
function extractCiWorkflow(text: string): string {
  const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const jobs = [...text.matchAll(/^\s{2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]!);
  const steps = [...text.matchAll(/^\s*-?\s*name:\s*(.+)$/gm)].map((m) => m[1]!.trim());
  return [name, jobs.join(" "), steps.join("\n")].filter(Boolean).join("\n");
}

// --- Orchestration ---------------------------------------------------------

function clampText(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Extract records from ONE file. Returns a SkipReason string when the file is
 *  skipped whole. Every emitted searchableText is redacted here. */
function extractFile(file: RepoFile, redact: SecretRedactor): CodeRecord[] | SkipReason {
  const excluded = classifyExcluded(file.path);
  if (excluded) return excluded;
  if (file.sizeBytes > MAX_FILE_BYTES) return "too_large";
  if (looksBinary(file.text)) return "binary";

  const e = ext(file.path);
  const records: CodeRecord[] = [];
  const add = (r: CodeRecord): void => {
    if (records.length >= MAX_RECORDS_PER_FILE) return;
    const safe = redact.text(clampText(r.searchableText, MAX_RECORD_TEXT)).trim();
    if (safe) records.push({ ...r, searchableText: safe });
  };

  // Harvest domains + endpoints from any text file (CORS allowlists, DNS configs,
  // service endpoints hide across many file types) -> the yofix case.
  const domains = extractDomains(file.text);
  if (domains.length) {
    const first = domains[0]!;
    const lineIdx = file.text.split("\n").findIndex((l) => l.toLowerCase().includes(first));
    add({
      file: file.path,
      line: lineIdx >= 0 ? lineIdx + 1 : 1,
      facet: "domain",
      title: `domains ${basename(file.path)}`,
      searchableText: `${basename(file.path)}\n${domains.join("\n")}`,
    });
  }

  if (isSkillMd(file.path)) {
    const { name, body } = extractSkillMeta(file.text);
    add({
      file: file.path,
      line: 1,
      facet: "skill",
      title: name ? `skill ${name}` : `skill ${file.path}`,
      searchableText: body,
    });
    return records;
  }

  if (isCiWorkflow(file.path)) {
    add({
      file: file.path,
      line: 1,
      facet: "manifest",
      title: `ci ${basename(file.path)}`,
      searchableText: `${file.path}\n${extractCiWorkflow(file.text)}`,
    });
    return records;
  }

  if (isManifest(file.path)) {
    const pairs = extractConfigPairs(file.text);
    add({
      file: file.path,
      line: pairs[0]?.line ?? 1,
      facet: "manifest",
      title: `manifest ${basename(file.path)}`,
      searchableText: [file.path, ...pairs.map((p) => p.text)].join("\n"),
    });
    return records;
  }

  if (MARKDOWN_EXT.has(e)) {
    add({
      file: file.path,
      line: 1,
      facet: "doc",
      title: `doc ${file.path}`,
      searchableText: `${file.path}\n${extractMarkdown(file.text)}`,
    });
    return records;
  }

  if (CONFIG_EXT.has(e) || YAML_EXT.has(e) || JSON_EXT.has(e)) {
    const pairs = extractConfigPairs(file.text);
    if (pairs.length) {
      add({
        file: file.path,
        line: pairs[0]!.line,
        facet: "config",
        title: `config ${file.path}`,
        searchableText: [file.path, ...pairs.map((p) => p.text)].join("\n"),
      });
    }
    return records;
  }

  if (CODE_EXT.has(e)) {
    const symbols = extractExportedSymbols(file.text);
    // Index the FILENAME always (5.1: "exported symbols and filenames") plus any
    // exported symbol names. We never index source bodies.
    add({
      file: file.path,
      line: 1,
      facet: "symbol",
      title: `symbols ${file.path}`,
      searchableText: [file.path, basename(file.path), ...symbols].join("\n"),
    });
    return records;
  }

  // Unknown extension with no domains harvested -> nothing to index.
  if (records.length === 0) return "unindexed_extension";
  return records;
}

/**
 * Extract redacted CODE records from a set of repo files. The redactor is built
 * from any known secret VALUES the caller injects (usually none for a clone -
 * pattern scrubbing still applies) plus the module's inline-credential patterns.
 * Bounded per file; the sweep bounds the file set.
 */
export function extractRepoRecords(
  files: readonly RepoFile[],
  opts: { secretValues?: readonly string[] } = {},
): ExtractOutcome {
  const redact = createSecretRedactor(opts.secretValues ?? []);
  const records: CodeRecord[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];
  for (const file of files) {
    const out = extractFile(file, redact);
    if (typeof out === "string") {
      skipped.push({ path: file.path, reason: out });
      continue;
    }
    if (out.length === 0) {
      skipped.push({ path: file.path, reason: "unindexed_extension" });
      continue;
    }
    records.push(...out);
  }
  return { records, skipped };
}
