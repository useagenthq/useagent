import { describe, expect, test } from "bun:test";
import {
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

  test("GET /api/commands serves the current default snapshot cache", async () => {
    // The test database is intentionally durable across invocations, so the
    // default snapshot may already be primed by an earlier run. Upsert a unique
    // command and assert the route reads that current value rather than making
    // test order or database freshness part of the product contract.
    const commandName = uid("review");
    await cacheCommandCatalog(
      defaultSnapshot(),
      JSON.stringify([{ name: commandName, description: "review the diff" }]),
    );
    const populated = await json<{
      commands: { name: string; description: string | null }[];
      fetched_at: string | null;
    }>("/api/commands");
    expect(populated.status).toBe(200);
    expect(populated.body.commands).toContainEqual({
      name: commandName,
      description: "review the diff",
    });
    expect(typeof populated.body.fetched_at).toBe("string");
  });
});

