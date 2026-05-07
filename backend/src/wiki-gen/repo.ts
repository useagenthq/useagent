/**
 * Read a cloned repository's text files into memory and derive the file-tree /
 * README the structure prompt needs. Pure with respect to the DB and network —
 * it only touches the local clone directory. The exclusion defaults mirror
 * deepwiki-open's repo.json (AsyncFuncAI/deepwiki-open, MIT), trimmed to the
 * common noise, plus a binary/size guard so a page prompt stays bounded.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** Directory names skipped entirely during the walk. */
const EXCLUDED_DIRS = new Set([
  ".git", ".svn", ".hg", ".bzr",
  "node_modules", "bower_components", "jspm_packages", "vendor",
  ".venv", "venv", "env", "virtualenv", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache",
  "dist", "build", "out", "target", "bin", "obj",
  ".idea", ".vscode", ".vs",
  "logs", "log", "tmp", "temp",
]);

/** Exact file names dropped (locks + local noise). */
const EXCLUDED_FILES = new Set([
  "yarn.lock", "pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json",
  "bun.lockb", "poetry.lock", "Pipfile.lock", "Cargo.lock", "composer.lock",
  ".DS_Store", "Thumbs.db", "desktop.ini",
]);

/** Extensions treated as binary/asset content and skipped. */
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "pdf",
  "zip", "gz", "tar", "tgz", "bz2", "xz", "7z", "rar",
  "mp3", "mp4", "mov", "avi", "wav", "webm", "flac", "ogg",
  "woff", "woff2", "ttf", "otf", "eot",
  "so", "dylib", "dll", "exe", "bin", "class", "o", "a",
  "wasm", "pyc", "pdb", "lockb",
]);

const MAX_FILE_BYTES = 200 * 1024; // per-file cap; larger files are skipped
const MAX_FILES = 3000; // total cap so a huge monorepo stays bounded

function ext(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Cheap binary sniff: a NUL byte in the first chunk means "not text". */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Walk a cloned repo directory, returning a map of repo-relative POSIX path ->
 * text content. Excluded dirs/files, binaries, oversized files, and everything
 * past MAX_FILES are dropped.
 */
export async function readRepoFiles(rootDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();

  async function walk(dir: string): Promise<void> {
    if (files.size >= MAX_FILES) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.size >= MAX_FILES) return;
      const name = entry.name;
      const full = join(dir, name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (EXCLUDED_FILES.has(name) || name === ".gitignore" || name === ".gitattributes") continue;
      if (BINARY_EXT.has(ext(name))) continue;
      try {
        const s = await stat(full);
        if (s.size > MAX_FILE_BYTES || s.size === 0) continue;
        const buf = await readFile(full);
        if (looksBinary(buf)) continue;
        const rel = relative(rootDir, full).split("\\").join("/");
        files.set(rel, buf.toString("utf8"));
      } catch {
        // Unreadable file — skip it, never fail the whole walk.
      }
    }
  }

  await walk(rootDir);
  return files;
}

/** Sorted newline-joined list of the repo's file paths (structure-prompt input). */
export function buildFileTree(files: Map<string, string>): string {
  return [...files.keys()].sort().join("\n");
}

/** The repository's top-most README content, or "" (structure-prompt input). */
export function findReadme(files: Map<string, string>): string {
  // Prefer the shallowest README (fewest path segments), matching deepwiki's
  // "shortest path" heuristic for the canonical top-level readme.
  let best: { depth: number; content: string } | null = null;
  for (const [path, content] of files) {
    const base = (path.split("/").pop() ?? "").toLowerCase();
    const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
    if (stem === "readme" || base === "readme") {
      const depth = path.split("/").length;
      if (!best || depth < best.depth) best = { depth, content };
    }
  }
  return best?.content ?? "";
}
