import type { SkillSections } from "../db/schema";
import {
  discoverSkillFiles,
  fetchSkillFileAtCommit,
  resolveRepoHeadSha,
} from "../github/discovery";
import type { SkillContent } from "./format";
import { importSkillFromSource, listImportedPaths } from "./import-repo";

// ---------------------------------------------------------------------------
// Turn a repo's SKILL.md files into versioned org skills (multi-repo import).
// The GitHub I/O lives in src/github/discovery.ts; this module parses the raw
// markdown into the portable SkillContent shape (frontmatter name/description +
// Overview/Procedure/Verify sections) and orchestrates scan + import over the
// source-keyed data access in import-repo.ts.
//
// Parsing is deterministic, so re-importing identical bytes yields identical
// content and the source-keyed upsert reports "unchanged". A SKILL.md written in
// our own Overview/Procedure/Verify convention round-trips exactly; any other
// markdown is preserved into the Overview section (the substrate has three
// sections, so non-canonical headings fold into Overview rather than being lost).
// ---------------------------------------------------------------------------

export interface SkillCandidate {
  path: string;
  name: string;
  description: string;
  sizeBytes: number;
  /** A skill with this (source_repo, source_path) already exists in the org. */
  alreadyImported: boolean;
}

export interface SkippedFile {
  path: string;
  sizeBytes: number;
  reason: "too_large";
}

export interface ScanResult {
  repo: string;
  sha: string;
  candidates: SkillCandidate[];
  /** SKILL.md files skipped for exceeding the size cap (surfaced, never silent). */
  skipped: SkippedFile[];
  /** The repo tree or candidate set was cut off; the list may be incomplete. */
  truncated: boolean;
}

export interface ImportOutcome {
  path: string;
  action: "created" | "updated" | "unchanged" | "skipped";
  reason?: "not_found" | "too_large";
  skillId?: string;
  version?: number;
}

export interface ImportResult {
  repo: string;
  sha: string;
  results: ImportOutcome[];
}

const FRONTMATTER_FENCE = "---";
const CANONICAL_SECTIONS = ["overview", "procedure", "verify"] as const;
type SectionKey = (typeof CANONICAL_SECTIONS)[number];

/** Split leading YAML frontmatter (if any) from the markdown body, returning the
 *  parsed frontmatter keys we care about plus the remaining body. */
function splitFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) return { frontmatter: {}, body: raw };
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === FRONTMATTER_FENCE);
  if (closeIdx === -1) return { frontmatter: {}, body: raw };

  const frontmatter: Record<string, string> = {};
  const fmLines = lines.slice(1, closeIdx);
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i]!;
    // Indented lines are block-scalar continuations consumed below, never keys.
    if (!line.trim() || /^\s/.test(line)) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    if (!key) continue;
    let value = line.slice(sep + 1).trim();
    const block = /^([>|])[+-]?$/.exec(value);
    if (block) {
      // YAML block scalar: gather the indented lines; fold (`>`) joins with
      // spaces, literal (`|`) keeps line breaks.
      const parts: string[] = [];
      while (i + 1 < fmLines.length && (!fmLines[i + 1]!.trim() || /^\s/.test(fmLines[i + 1]!))) {
        i++;
        const t = fmLines[i]!.trim();
        if (t) parts.push(t);
      }
      value = parts.join(block[1] === ">" ? " " : "\n");
    } else {
      value = value.replace(/^["']|["']$/g, "");
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: lines.slice(closeIdx + 1).join("\n") };
}

/** Classify a `## Heading` as one of the three canonical sections, or null. */
function classifyHeading(heading: string): SectionKey | null {
  const h = heading.trim().toLowerCase().replace(/[:.]+$/, "").trim();
  return (CANONICAL_SECTIONS as readonly string[]).includes(h) ? (h as SectionKey) : null;
}

/** Strip a leading list marker (-, *, +, or `N.` / `N)`) from a line. */
function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
}

/** Turn a block's lines into section items: one item per non-blank content line,
 *  list markers stripped. This is the inverse of formatSkillMarkdown's rendering,
 *  so canonical sections round-trip. */
function toItems(lines: string[]): string[] {
  return lines
    .map((l) => stripListMarker(l))
    .filter((l) => l.length > 0);
}

/** Drop a preamble's H1 title and a first line echoing the frontmatter
 *  description, so canonical docs don't duplicate that text into Overview. */
function trimPreamble(lines: string[], description: string): string[] {
  const arr = [...lines];
  while (arr.length && arr[0]!.trim() === "") arr.shift();
  if (arr.length && /^#\s+/.test(arr[0]!)) arr.shift();
  while (arr.length && arr[0]!.trim() === "") arr.shift();
  if (description && arr.length && arr[0]!.trim() === description.trim()) arr.shift();
  return arr;
}

interface Block {
  heading: string | null;
  lines: string[];
}

/** Split a markdown body into blocks at top-level (`## `) headings. Deeper
 *  headings (`### `+) and the H1 title stay as block content. */
function splitByH2(body: string): Block[] {
  const blocks: Block[] = [];
  let current: Block = { heading: null, lines: [] };
  for (const line of body.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      blocks.push(current);
      current = { heading: m[1]!, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks;
}

/**
 * Parse a SKILL.md into the portable SkillContent shape. Frontmatter supplies
 * name/description (name falls back to `fallbackName` — the parent directory —
 * when absent); the body's canonical Overview/Procedure/Verify sections map
 * directly, and any preamble or non-canonical section folds into Overview so no
 * content is dropped. Deterministic: identical input yields identical output.
 */
export function parseSkillMarkdown(raw: string, fallbackName: string): SkillContent {
  const { frontmatter, body } = splitFrontmatter(raw);
  const name = frontmatter.name?.trim() || fallbackName;
  const description = frontmatter.description?.trim() || "";

  const sections: SkillSections = { overview: [], procedure: [], verify: [] };
  for (const block of splitByH2(body)) {
    const key = block.heading ? classifyHeading(block.heading) : null;
    if (key) {
      sections[key].push(...toItems(block.lines));
    } else if (block.heading === null) {
      sections.overview.push(...toItems(trimPreamble(block.lines, description)));
    } else {
      // Non-canonical `## Heading`: keep the label + content in Overview.
      sections.overview.push(block.heading.trim(), ...toItems(block.lines));
    }
  }
  return { name, description, sections };
}

/** Fallback skill name from a SKILL.md path: its parent directory (the skill
 *  folder in the .claude/skills/** / skills/** convention), or the repo name for
 *  a root-level SKILL.md. */
export function deriveFallbackName(path: string, repo: string): string {
  const parts = path.split("/");
  if (parts.length >= 2) return parts[parts.length - 2]!;
  return repo.split("/")[1] ?? repo;
}

/** Scan a repo for importable SKILL.md files, marking which are already imported
 *  into this org. Throws DiscoveryError (mapped to a status by the route). */
export async function scanSkillCandidates(
  orgId: string,
  repo: string,
): Promise<ScanResult> {
  const [discovered, importedPaths] = await Promise.all([
    discoverSkillFiles(repo),
    listImportedPaths(orgId, repo),
  ]);

  const candidates: SkillCandidate[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of discovered.files) {
    if (file.text === null) {
      skipped.push({ path: file.path, sizeBytes: file.sizeBytes, reason: "too_large" });
      continue;
    }
    const parsed = parseSkillMarkdown(file.text, deriveFallbackName(file.path, repo));
    candidates.push({
      path: file.path,
      name: parsed.name,
      description: parsed.description,
      sizeBytes: file.sizeBytes,
      alreadyImported: importedPaths.has(file.path),
    });
  }
  return {
    repo,
    sha: discovered.commitSha,
    candidates,
    skipped,
    truncated: discovered.truncated,
  };
}

/** Import the given SKILL.md paths from a repo at its current HEAD. Fetches each
 *  path's content pinned to that commit, parses it, and upserts by source. */
export async function importSkills(
  orgId: string,
  repo: string,
  paths: string[],
): Promise<ImportResult> {
  const sha = await resolveRepoHeadSha(repo);
  const results: ImportOutcome[] = [];
  for (const path of [...new Set(paths)]) {
    const file = await fetchSkillFileAtCommit(repo, path, sha);
    if (file === null) {
      results.push({ path, action: "skipped", reason: "not_found" });
      continue;
    }
    if (file.text === null) {
      results.push({ path, action: "skipped", reason: "too_large" });
      continue;
    }
    const content = parseSkillMarkdown(file.text, deriveFallbackName(path, repo));
    const outcome = await importSkillFromSource({
      orgId,
      sourceRepo: repo,
      sourcePath: path,
      commitSha: sha,
      content,
    });
    results.push({ path, ...outcome });
  }
  return { repo, sha, results };
}
