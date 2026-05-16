import { afterEach, describe, expect, test } from "bun:test";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { materializeRunInputs, sandboxInputPath } from "../src/uploads/materialize";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";

const storage = new InMemoryArtifactStorage();

afterEach(() => {
  setArtifactStorageForTest(null);
  storage.values.clear();
});

describe("sandbox input materialization", () => {
  test("verifies and uploads exact bytes with restrictive permissions", async () => {
    setArtifactStorageForTest(storage);
    const bytes = new TextEncoder().encode("trusted input bytes");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    await storage.put(sha256, bytes);
    const path = sandboxInputPath("input-id", "report (final).txt");
    const commands: string[] = [];
    const uploaded: Array<{ bytes: Buffer; path: string; timeout?: number }> = [];

    await materializeRunInputs(
      {
        process: {
          executeCommand: async (command) => {
            commands.push(command);
            return { exitCode: 0 };
          },
        },
        fs: {
          uploadFile: async (file, remotePath, timeout) => {
            uploaded.push({ bytes: file, path: remotePath, timeout });
          },
        },
      },
      [
        {
          id: "input-id",
          name: "report (final).txt",
          contentType: "text/plain; charset=utf-8",
          sizeBytes: bytes.byteLength,
          sha256,
          storageKey: sha256,
          sandboxPath: path,
        },
      ],
    );

    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.path).toBe(path);
    expect(uploaded[0]?.timeout).toBe(120);
    expect(new Uint8Array(uploaded[0]!.bytes)).toEqual(bytes);
    expect(commands[0]).toContain("chmod 700 /root/work/.skynet-inputs");
    expect(commands[1]).toContain(`chmod 600 -- '${path}'`);
  });

  test("fails before upload when stored bytes do not match the claimed digest", async () => {
    setArtifactStorageForTest(storage);
    const bytes = new TextEncoder().encode("tampered");
    const storageKey = "c".repeat(64);
    await storage.put(storageKey, bytes);
    let uploadCalled = false;

    await expect(
      materializeRunInputs(
        {
          process: { executeCommand: async () => ({ exitCode: 0 }) },
          fs: {
            uploadFile: async () => {
              uploadCalled = true;
            },
          },
        },
        [
          {
            id: "input-id",
            name: "report.txt",
            contentType: "text/plain",
            sizeBytes: bytes.byteLength,
            sha256: "d".repeat(64),
            storageKey,
            sandboxPath: sandboxInputPath("input-id", "report.txt"),
          },
        ],
      ),
    ).rejects.toThrow("upload digest mismatch");
    expect(uploadCalled).toBe(false);
  });
});
