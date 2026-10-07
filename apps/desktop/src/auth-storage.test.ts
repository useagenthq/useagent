import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authScope, createAuthStorage } from "./auth-storage";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test("desktop auth storage persists encrypted client state with owner-only permissions", async () => {
  directory = await mkdtemp(join(tmpdir(), "useagent-auth-"));
  const file = join(directory, "state.json");
  createAuthStorage(file).setItem("better-auth.cookie", "encrypted-cookie-state");

  expect(createAuthStorage(file).getItem("better-auth.cookie")).toBe("encrypted-cookie-state");
  if (process.platform !== "win32") {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  }
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "better-auth.cookie": "encrypted-cookie-state" });
});

test("desktop auth storage fails closed on corrupt state", async () => {
  directory = await mkdtemp(join(tmpdir(), "useagent-auth-"));
  const file = join(directory, "state.json");
  await Bun.write(file, "not-json");
  const storage = createAuthStorage(file);
  expect(() => storage.getItem("better-auth.cookie")).toThrow();
});

test("desktop auth storage scopes never expose or reuse a control-plane origin", () => {
  const first = authScope("http://localhost:3400");
  const second = authScope("http://localhost:3401");
  expect(first).not.toBe(second);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(first).not.toContain("localhost");
});
