import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTokenStore, type TokenEncryption } from "./token-store";

const directories: string[] = [];
const storage: TokenEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
  getSelectedStorageBackend: () => "keychain",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("runner token store", () => {
  test("writes an origin-bound token atomically with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "useagent-token-"));
    directories.push(directory);
    const file = join(directory, "token");
    const store = createTokenStore(file, "https://plane.example", storage, "darwin");
    await store.write("secret-token");

    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect(await store.read()).toBe("secret-token");
    expect(await createTokenStore(file, "https://other.example", storage, "darwin").read()).toBeUndefined();
    expect(await readFile(file, "utf8")).not.toContain("secret-token");
  });

  test("rejects Linux plaintext storage", async () => {
    const insecure = { ...storage, getSelectedStorageBackend: () => "basic_text" };
    const store = createTokenStore("/unused", "https://plane.example", insecure, "linux");
    await expect(store.write("secret-token")).rejects.toThrow("Secure token storage is unavailable");
  });
});
