import { afterEach, describe, expect, test } from "bun:test";
import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import type { ArtifactStorage } from "../artifacts/storage";
import { setArtifactStorageForTest } from "../artifacts/storage";
import type { RunInputFile } from "../engines/types";
import {
  formatInputContext,
  materializeRunInputs,
  sandboxInputPath,
} from "./materialize";

const bytes = Buffer.from("hello");
const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

afterEach(() => setArtifactStorageForTest(null));

describe("sandbox input materialization", () => {
  test("rebases stale Cube and Box paths to the actual acquired sandbox", async () => {
    for (const [provisional, actual, expectedRoot] of [
      ["cube", "box", "/home/user/work/.skynet-inputs"],
      ["box", "cube", "/root/work/.skynet-inputs"],
    ] as const) {
      const commands: string[] = [];
      const uploads: Array<{ readonly bytes: Buffer; readonly path: string }> = [];
      const ctx = context(provisional);
      const unrelated = ctx.unrelated;
      setArtifactStorageForTest(storage());

      await materializeRunInputs(sandbox(actual, commands, uploads), ctx, {
        uid: 1000,
        gid: 1000,
      });

      const expectedPath = `${expectedRoot}/input-1-report.txt`;
      expect(uploads).toEqual([{ bytes, path: expectedPath }]);
      expect(ctx.inputFiles?.[0]?.sandboxPath).toBe(expectedPath);
      expect(ctx.inputContext).toBe(formatInputContext(ctx.inputFiles ?? []));
      expect(ctx.inputContext).toContain(expectedPath);
      expect(ctx.inputContext).not.toContain(sandboxInputPath("input-1", "report.txt", provisional));
      expect(commands).toEqual([
        `mkdir -p ${expectedRoot} && chmod 700 ${expectedRoot} && chown 1000:1000 ${expectedRoot}`,
        `chown 1000:1000 -- '${expectedPath}' && chmod 600 -- '${expectedPath}'`,
      ]);
      expect(ctx.unrelated).toBe(unrelated);
    }
  });

  test("publishes rebased descriptors and context only after every file is secured", async () => {
    const commands: string[] = [];
    const uploads: Array<{ readonly bytes: Buffer; readonly path: string }> = [];
    const ctx = context("cube");
    const originalFiles = ctx.inputFiles;
    const originalContext = ctx.inputContext;
    setArtifactStorageForTest(storage());

    await expect(materializeRunInputs(
      sandbox("box", commands, uploads, true),
      ctx,
      { uid: 1000, gid: 1000 },
    )).rejects.toThrow("failed to secure sandbox input: input-1");

    expect(uploads[0]?.bytes).toEqual(bytes);
    expect(ctx.inputFiles).toBe(originalFiles);
    expect(ctx.inputContext).toBe(originalContext);
  });

  test("rejects bytes whose digest does not match before upload or context mutation", async () => {
    const commands: string[] = [];
    const uploads: Array<{ readonly bytes: Buffer; readonly path: string }> = [];
    const ctx = context("cube");
    ctx.inputFiles = [{ ...ctx.inputFiles![0]!, sha256: "0".repeat(64) }];
    const originalContext = ctx.inputContext;
    setArtifactStorageForTest(storage());

    await expect(materializeRunInputs(
      sandbox("box", commands, uploads),
      ctx,
    )).rejects.toThrow("upload digest mismatch: input-1");

    expect(uploads).toEqual([]);
    expect(ctx.inputContext).toBe(originalContext);
  });
});

function context(provisional: SandboxProviderKind) {
  const file: RunInputFile = {
    id: "input-1",
    name: "report.txt",
    contentType: "text/plain",
    sizeBytes: bytes.byteLength,
    sha256: digest,
    storageKey: "storage-key",
    sandboxPath: sandboxInputPath("input-1", "report.txt", provisional),
  };
  return {
    inputFiles: [file] as readonly RunInputFile[],
    inputContext: formatInputContext([file]),
    unrelated: { retained: true },
  };
}

function storage(): ArtifactStorage {
  return {
    async read() { return bytes; },
    async put() {},
    async size() { return bytes.byteLength; },
    async sha256() { return digest; },
  };
}

function sandbox(
  providerKind: SandboxProviderKind,
  commands: string[],
  uploads: Array<{ readonly bytes: Buffer; readonly path: string }>,
  failSecure = false,
) {
  return {
    providerKind,
    process: {
      async executeCommand(command: string) {
        commands.push(command);
        return {
          exitCode: failSecure && command.includes("chmod 600") ? 1 : 0,
          result: "",
        };
      },
    },
    fs: {
      async uploadFile(uploaded: Buffer, path: string) {
        uploads.push({ bytes: uploaded, path });
      },
    },
  };
}
