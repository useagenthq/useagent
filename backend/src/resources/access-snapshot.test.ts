import { describe, expect, test } from "bun:test";
import type { ResourceCatalogService } from "./catalog-service";
import { buildResourceAccessSnapshot, formatResourceAccessContext } from "./access-snapshot";
import type { RunResource } from "./types";

const boundRepository: RunResource = {
  provider: "github",
  kind: "code.repository",
  locator: { type: "github.repository", repository: "acme/bound", revision: "main" },
  capabilities: ["content.read", "code.checkout"],
  provenance: [{ source: "explicit", channel: "web", raw: "acme/bound", start: null, end: null }],
};

describe("resource access snapshot", () => {
  test("keeps connected inventory separate from run authorization", async () => {
    const catalog: ResourceCatalogService = {
      providerIds: () => ["github"],
      async search(scope) {
        expect(scope).toEqual({ orgId: "org-a", userId: "user-a" });
        return {
          status: "available",
          items: [{
            catalogRef: "rc_inventory",
            provider: "github",
            kind: "code.repository",
            name: "acme/visible",
            locator: { type: "github.repository", repository: "acme/visible" },
            metadata: {},
          }],
          nextCursor: "next",
          complete: false,
        };
      },
    };

    const snapshot = await buildResourceAccessSnapshot({
      orgId: "org-a",
      userId: "user-a",
      runId: "run-a",
      resources: [boundRepository],
      repos: [],
    }, catalog);

    expect(snapshot.inventory).toEqual([{
      provider: "github",
      status: "available",
      sampleNames: ["acme/visible"],
      sampleCount: 1,
      hasMore: true,
    }]);
    expect(snapshot.runBindings).toEqual([
      expect.objectContaining({
        provider: "github",
        locator: expect.objectContaining({ repository: "acme/bound" }),
      }),
    ]);
    expect(formatResourceAccessContext(snapshot)).toContain('"sandboxFilesystemAuthoritative":false');
  });

  test("reports catalog failures as unavailable instead of confirmed empty", async () => {
    const catalog: ResourceCatalogService = {
      providerIds: () => ["github"],
      async search() {
        throw new Error("provider down");
      },
    };

    const snapshot = await buildResourceAccessSnapshot({
      orgId: "org-a",
      userId: "user-a",
      runId: "run-a",
      resources: [],
      repos: [],
    }, catalog);

    expect(snapshot.inventory).toEqual([{
      provider: "github",
      status: "unavailable",
      sampleNames: [],
      sampleCount: 0,
      hasMore: false,
    }]);
  });
});
