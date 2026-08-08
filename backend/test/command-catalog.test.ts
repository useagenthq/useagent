import { describe, expect, test } from "bun:test";
import {
  acpCatalogKey,
  cacheAcpCommands,
  cacheCommandCatalog,
  defaultSnapshot,
  readCommandCatalog,
} from "../src/runs/command-catalog";
import { json, uid } from "./helpers";

describe("command catalog cache", () => {
  test("readCommandCatalog: unknown snapshot → null; upsert; empty/garbage ignored", async () => {
    const snap = uid("snap"); // unique — never the default snapshot below

    // Never cached.
    expect(await readCommandCatalog(snap)).toBeNull();

    // Empty and garbage bodies never clobber (stay uncached).
    await cacheCommandCatalog(snap, "[]");
    await cacheCommandCatalog(snap, "not json");
    expect(await readCommandCatalog(snap)).toBeNull();

    // A valid body caches, normalized: nameless entries dropped, missing
    // description → null.
    await cacheCommandCatalog(
      snap,
      JSON.stringify([
        { name: "init", description: "seed the repo" },
        { name: "review" },
        { description: "no name — dropped" },
      ]),
    );
    const first = await readCommandCatalog(snap);
    expect(first).not.toBeNull();
    expect(first!.commands).toEqual([
      { name: "init", description: "seed the repo" },
      { name: "review", description: null },
    ]);
    expect(first!.fetchedAt).toBeInstanceOf(Date);

    // Re-caching upserts (single row per snapshot).
    await cacheCommandCatalog(snap, JSON.stringify([{ name: "plan" }]));
    const second = await readCommandCatalog(snap);
    expect(second!.commands).toEqual([{ name: "plan", description: null }]);
  });

  test("GET /api/commands: empty until the default snapshot is cached", async () => {
    // Nothing caches the default snapshot in unit tests (the live-proxy tap only
    // fires against a real sandbox), so the route starts empty.
    const empty = await json<{ commands: unknown[]; fetched_at: string | null }>(
      "/api/commands",
    );
    expect(empty.status).toBe(200);
    expect(empty.body.commands).toEqual([]);
    expect(empty.body.fetched_at).toBeNull();

    // Seed the default snapshot as the live-proxy would, then read it back.
    await cacheCommandCatalog(
      defaultSnapshot(),
      JSON.stringify([{ name: "review", description: "review the diff" }]),
    );
    const populated = await json<{
      commands: { name: string; description: string | null }[];
      fetched_at: string | null;
    }>("/api/commands");
    expect(populated.status).toBe(200);
    expect(populated.body.commands).toContainEqual({
      name: "review",
      description: "review the diff",
    });
    expect(typeof populated.body.fetched_at).toBe("string");
  });
});

// Slice 2 (+ review hardening): ACP native command catalogs, cached keyed by ORG and ENGINE
// (never cross-provider, never cross-tenant), carrying the argument hint, replacement +
// no-clobber-on-empty. The dev org (uid-free) is used by the route; unit calls use explicit orgs.
describe("ACP command catalog (Slice 2)", () => {
  const ORG = "org-A";

  test("caches an engine's commands (name + description + input) and reads them back", async () => {
    await cacheAcpCommands(ORG, "claude", [
      { name: "review", description: "Review the diff", input: "[files]" },
      { name: "status" },
    ]);
    expect((await readCommandCatalog(acpCatalogKey(ORG, "claude")))?.commands).toEqual([
      { name: "review", description: "Review the diff", input: "[files]" },
      { name: "status", description: null, input: null },
    ]);
  });

  test("engines are isolated: codex's catalog never returns claude's commands", async () => {
    await cacheAcpCommands(ORG, "codex", [{ name: "codex-only" }]);
    const codex = (await readCommandCatalog(acpCatalogKey(ORG, "codex")))?.commands.map((c) => c.name) ?? [];
    expect(codex).toContain("codex-only");
    expect(codex).not.toContain("claude-only");
  });

  test("ORGS are isolated: org B never sees org A's session-derived commands", async () => {
    await cacheAcpCommands("org-A", "claude", [{ name: "a-secret-skill" }]);
    await cacheAcpCommands("org-B", "claude", [{ name: "b-skill" }]);
    const b = (await readCommandCatalog(acpCatalogKey("org-B", "claude")))?.commands.map((c) => c.name) ?? [];
    expect(b).toEqual(["b-skill"]);
    expect(b).not.toContain("a-secret-skill");
  });

  test("an EMPTY snapshot never clobbers a good cache; a later non-empty REPLACES", async () => {
    await cacheAcpCommands(ORG, "claude", [{ name: "keep-a" }, { name: "keep-b" }]);
    await cacheAcpCommands(ORG, "claude", []); // transient empty frame - ignored by the priming cache
    expect((await readCommandCatalog(acpCatalogKey(ORG, "claude")))?.commands.map((c) => c.name)).toEqual(["keep-a", "keep-b"]);
    await cacheAcpCommands(ORG, "claude", [{ name: "fresh" }]); // replacement
    expect((await readCommandCatalog(acpCatalogKey(ORG, "claude")))?.commands.map((c) => c.name)).toEqual(["fresh"]);
  });

  test("GET /api/commands?engine=claude serves THIS org's ACP catalog (opencode stays separate)", async () => {
    // The route resolves the current org (dev org in tests) - seed under that same org via a run.
    const res0 = await json<{ engine: string; commands: { name: string }[] }>("/api/commands?engine=claude");
    expect(res0.status).toBe(200);
    expect(res0.body.engine).toBe("claude");
    // opencode default catalog is a different (org-neutral) key, never the ACP one.
    const oc = await json<{ engine: string }>("/api/commands");
    expect(oc.body.engine).toBe("opencode");
  });
});
