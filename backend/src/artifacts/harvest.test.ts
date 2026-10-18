import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileListCommand,
  MAX_HARVESTED_FILES,
  MAX_LISTING_RECORDS,
  parseFileListing,
  parseRepositoryListing,
  repositoryListCommand,
  TooManyTurnOutputs,
} from "./harvest";
import { SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";

const complete = (records = "") => `${records}__USEAGENT_LISTING_COMPLETE__\0`;

function runListing(command: string): string {
  const localCommand = process.platform === "darwin"
    ? command.replace(/^find /m, "gfind ").replace(/^head -z.*$/m, 'cat "$listing_file"')
    : command;
  const result = Bun.spawnSync(["bash", "-c", localCommand]);
  expect(result.exitCode, Buffer.from(result.stderr).toString()).toBe(0);
  return Buffer.from(result.stdout).toString();
}

describe("listing commands", () => {
  test("prunes depth-one trees without globally suppressing their prune expression", () => {
    const command = repositoryListCommand("/root/work");
    expect(command).toContain("find '/root/work' -xdev \\( -name 'node_modules'");
    expect(command).toContain("-prune -o -name .git -printf '%h\\0' -prune");
    expect(command).not.toContain("-mindepth");
    expect(command).toContain(`head -z -n ${MAX_LISTING_RECORDS + 1}`);
    expect(command).toContain("__USEAGENT_LISTING_COMPLETE__");
  });

  test("prunes every repository and recognizes the expanded deliverable formats", () => {
    const repositories = Array.from({ length: 70 }, (_, index) => `/root/work/repo-${index}`);
    const command = fileListCommand("/root/work", "1757000000.123456789", repositories);
    // The inode change time, never the modification time: a preserved-mtime copy must be found.
    expect(command).toContain("-newerct '@1757000000.123456789'");
    expect(command).not.toContain("-newermt");
    expect(command).toContain(`-name '${SANDBOX_STATE_DIR}-inputs'`);
    expect(command).toContain("-path '/root/work/repo-69'");
    for (const extension of ["pdf", "txt", "json", "xml", "tar", "gz"]) {
      expect(command).toContain(`-iname '*.${extension}'`);
    }
    expect(command).toContain("-printf '%s\\t%p\\0'");
    expect(command).not.toContain("-size");
  });

  test("quotes paths and rejects timestamps before shell construction", () => {
    expect(fileListCommand("/root/it's", "1.0", [])).toContain("'/root/it'\\''s'");
    expect(() => fileListCommand("/root/work", "1; touch /tmp/no", [])).toThrow("timestamp is invalid");
  });
});

describe("listing parsers", () => {
  const root = "/root/work";

  test("keeps every repository root strictly below the workspace", () => {
    expect(parseRepositoryListing(complete("/root/work\0/root/work/b\0/root/work/a\0/root/work/a\0"), root))
      .toEqual(["/root/work/a", "/root/work/b"]);
    expect(() => parseRepositoryListing(complete("/elsewhere\0"), root)).toThrow("escaped");
  });

  test("keeps NUL-framed filenames and excludes repositories and private screenshots", () => {
    const listing = complete([
      "1200\t/root/work/out/report.pdf",
      "40\t/root/work/notes\nfinal.md",
      "9\t/root/work/deep/repo/docs/design.md",
      "7\t/root/work/odd\tname.txt",
      "5\t/root/work/screenshots/screenshot-1786558088313.png",
      "5\t/root/work/screenshots/customer.png",
      "5\t/root/work/screenshots/nested/customer.png",
      "",
    ].join("\0"));
    expect(parseFileListing(listing, root, ["/root/work/deep/repo"]).candidates).toEqual([
      { path: "/root/work/notes\nfinal.md", size: 40 },
      { path: "/root/work/odd\tname.txt", size: 7 },
      { path: "/root/work/out/report.pdf", size: 1200 },
    ]);
  });

  test("throws on incomplete and malformed listings", () => {
    expect(() => parseFileListing("", root, [])).toThrow("incomplete");
    expect(() => parseFileListing(complete("abc\t/root/work/x.pdf\0"), root, [])).toThrow("size is invalid");
  });

  test("withholds empty and oversized files instead of failing the whole listing", () => {
    expect(parseFileListing(complete("0\t/root/work/empty.md\0" + "52428801\t/root/work/big.zip\0" + "12\t/root/work/report.pdf\0"), root, []))
      .toEqual({ candidates: [{ path: "/root/work/report.pdf", size: 12 }], withheldPaths: ["/root/work/empty.md", "/root/work/big.zip"] });
    expect(parseFileListing(complete("12\t/root/work/report.pdf\0"), root, []))
      .toEqual({ candidates: [{ path: "/root/work/report.pdf", size: 12 }], withheldPaths: [] });
  });

  test("reports more outputs than one turn delivers as its own error", () => {
    const tooManyRecords = Array.from(
      { length: MAX_LISTING_RECORDS + 1 },
      (_, index) => `/root/work/repo-${index}\0`,
    ).join("");
    expect(() => parseRepositoryListing(complete(tooManyRecords), root)).toThrow(TooManyTurnOutputs);

    const tooManyCandidates = Array.from(
      { length: MAX_HARVESTED_FILES + 1 },
      (_, index) => `10\t/root/work/file-${index}.pdf\0`,
    ).join("");
    expect(() => parseFileListing(complete(tooManyCandidates), root, [])).toThrow(TooManyTurnOutputs);
  });

  test("the top-level listing stays at the workspace root and Rust build trees are pruned", () => {
    expect(fileListCommand(root, "1.0", [], { topLevelOnly: true })).toContain("find '/root/work' -maxdepth 1 -type f");
    expect(fileListCommand(root, "1.0", [])).toContain("-name 'target'");
  });

  test("real GNU find keeps root-repo outputs, prunes nested trees, and reports invalid sizes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "artifact-harvest-"));
    try {
      for (const directory of [
        ".git",
        "nested/.git",
        "node_modules/dependency",
        ".useagent-inputs",
        ".claude",
        ".config",
        "coverage",
        "screenshots",
      ]) mkdirSync(join(workspace, directory), { recursive: true });
      for (const path of [
        "report.pdf",
        "generated-without-extension",
        "nested/code.json",
        "node_modules/dependency/package.json",
        ".useagent-inputs/user.pdf",
        ".claude/settings.json",
        ".config/auth.json",
        "coverage/index.html",
        "screenshots/screenshot-1786558088313.png",
        "screenshots/customer.png",
      ]) writeFileSync(join(workspace, path), "x");

      const repositories = parseRepositoryListing(runListing(repositoryListCommand(workspace)), workspace);
      expect(repositories).toEqual([join(workspace, "nested")]);
      const listing = runListing(fileListCommand(workspace, "0.0", repositories));
      expect(listing).not.toContain("generated-without-extension");
      expect(listing).not.toContain("nested/code.json");
      expect(listing).not.toContain("node_modules/dependency/package.json");
      expect(listing).not.toContain(".useagent-inputs/user.pdf");
      expect(listing).not.toContain("screenshots/");
      expect(listing).not.toContain(".claude/");
      expect(listing).not.toContain(".config/");
      expect(listing).not.toContain("coverage/");
      const runtimeListing = listing.replaceAll(workspace, "/root/work");
      expect(parseFileListing(runtimeListing, "/root/work", ["/root/work/nested"]))
        .toEqual({ candidates: [{ path: "/root/work/report.pdf", size: 1 }], withheldPaths: [] });

      const topLevel = runListing(fileListCommand(workspace, "0.0", [], { topLevelOnly: true }));
      expect(parseFileListing(topLevel, workspace, []).candidates).toEqual([{ path: join(workspace, "report.pdf"), size: 1 }]);

      const oversized = join(workspace, "oversized.pdf");
      writeFileSync(oversized, "");
      truncateSync(oversized, 50 * 1024 * 1024 + 1);
      const oversizedListing = runListing(fileListCommand(workspace, "0.0", repositories));
      expect(oversizedListing).toContain(`52428801\t${oversized}\0`);
      expect(parseFileListing(oversizedListing, workspace, repositories).withheldPaths).toEqual([oversized]);

      rmSync(oversized);
      const empty = join(workspace, "empty.pdf");
      writeFileSync(empty, "");
      expect(parseFileListing(
        runListing(fileListCommand(workspace, "0.0", repositories)),
        workspace,
        repositories,
      ).withheldPaths).toEqual([empty]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
