import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayApp } from "./gateway-app";

const previousRoot = process.env.ARTIFACT_STORAGE_DIR;
const roots = new Set<string>();

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.ARTIFACT_STORAGE_DIR;
  else process.env.ARTIFACT_STORAGE_DIR = previousRoot;
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("gateway health", () => {
  test("reports ok when the artifact store is writable", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-gateway-health-"));
    roots.add(root);
    process.env.ARTIFACT_STORAGE_DIR = join(root, "artifacts");

    const response = await createGatewayApp().request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", surface: "gateway" });
  });

  test("turns unhealthy when the artifact store cannot be written", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-gateway-health-"));
    roots.add(root);
    const blocked = join(root, "blocked");
    await writeFile(blocked, "");
    process.env.ARTIFACT_STORAGE_DIR = blocked;

    const response = await createGatewayApp().request("/health");

    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; artifact_storage: string };
    expect(body.status).toBe("unhealthy");
    expect(body.artifact_storage).toContain("artifact storage is not writable");
    expect(body.artifact_storage).toContain("ARTIFACT_STORAGE_DIR");
  });
});

describe("gateway error answers", () => {
  test("an unknown path is a JSON 404", async () => {
    const response = await createGatewayApp().request("/api/provider-typo/v1/chat");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  test("an error no route caught is a JSON 500, logged with method and path", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = createGatewayApp();
      app.get("/api/test-only-crash", () => {
        throw new Error("test-only crash");
      });

      const response = await app.request("/api/test-only-crash");

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "internal_error" });
      expect(logged.mock.calls[0]?.[0]).toBe("[gateway] GET /api/test-only-crash failed:");
    } finally {
      logged.mockRestore();
    }
  });
});
