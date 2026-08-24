import { expect, test } from "bun:test";
import { createGithubResourceCatalogProvider } from "./github-catalog";

function repo(index: number, name = `acme/service-${index}`) {
  return {
    external_id: String(1000 + index),
    full_name: name,
    name: name.split("/").at(-1) as string,
    private: true,
    default_branch: "main",
  };
}

test("GitHub catalog returns bounded opaque inventory pages without connection ids", async () => {
  const provider = createGithubResourceCatalogProvider({
    async list(orgId) {
      expect(orgId).toBe("org-a");
      return {
        configured: true,
        connectionId: "connection-secret-internal-id",
        complete: true,
        nextCursor: null,
        repos: Array.from({ length: 55 }, (_, index) => repo(index)),
      };
    },
  });

  const page = await provider.search(
    { orgId: "org-a", userId: "user-a" },
    { query: "service", cursor: null, limit: 20 },
  );
  expect(page.items).toHaveLength(20);
  expect(page.nextCursor).not.toBeNull();
  expect(page.items[0]).toMatchObject({
    catalogRef: expect.stringMatching(/^rc_/),
    provider: "github",
    kind: "code.repository",
    name: "acme/service-0",
  });
  expect(JSON.stringify(page)).not.toContain("connection-secret-internal-id");

  const next = await provider.search(
    { orgId: "org-a", userId: "user-a" },
    { query: "service", cursor: page.nextCursor, limit: 20 },
  );
  expect(next.items[0]?.name).toBe("acme/service-20");
});

test("GitHub catalog follows provider continuation beyond the first 300 repositories", async () => {
  const calls: Array<string | null> = [];
  const provider = createGithubResourceCatalogProvider({
    async list(_orgId, options) {
      const cursor = options?.cursor ?? null;
      calls.push(cursor);
      const page = cursor ? Number(cursor) : 1;
      return {
        configured: true,
        connectionId: "connection-a",
        repos: Array.from({ length: 100 }, (_, offset) => repo((page - 1) * 100 + offset)),
        complete: page === 4,
        nextCursor: page === 4 ? null : String(page + 1),
      };
    },
  });

  const result = await provider.search(
    { orgId: "org-a", userId: "user-a" },
    { query: "service-350", cursor: null, limit: 10 },
  );

  expect(calls).toEqual([null, "2", "3", "4"]);
  expect(result.items.map((item) => item.name)).toEqual(["acme/service-350"]);
  expect(result.nextCursor).toBeNull();
});

test("GitHub catalog refs remain stable across repository renames", async () => {
  let name = "acme/old-name";
  const provider = createGithubResourceCatalogProvider({
    async list() {
      return {
        configured: true,
        connectionId: "connection-a",
        repos: [repo(7, name)],
        complete: true,
        nextCursor: null,
      };
    },
  });

  const before = await provider.search(
    { orgId: "org-a", userId: "user-a" },
    { query: null, cursor: null, limit: 10 },
  );
  name = "acme/new-name";
  const after = await provider.search(
    { orgId: "org-a", userId: "user-a" },
    { query: null, cursor: null, limit: 10 },
  );

  expect(before.items[0]?.catalogRef).toBe(after.items[0]?.catalogRef);
  expect(after.items[0]?.name).toBe("acme/new-name");
});

test("GitHub catalog excludes repositories without a valid stable numeric id", async () => {
  const provider = createGithubResourceCatalogProvider({
    async list() {
      return {
        configured: true,
        connectionId: "connection-a",
        repos: [
          { ...repo(1), external_id: undefined },
          { ...repo(2), external_id: "name:acme/service-2" },
          { ...repo(3), external_id: "0" },
          repo(4),
        ],
        complete: true,
        nextCursor: null,
      };
    },
  });

  const result = await provider.search(
    { orgId: "org-a", userId: "user-a" },
    { query: null, cursor: null, limit: 10 },
  );

  expect(result.items.map((item) => item.name)).toEqual(["acme/service-4"]);
});
