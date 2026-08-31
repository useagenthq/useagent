import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, link, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTrustedImageOutput,
  setTrustedOutputReadHookForTest,
  validatedTrustedImageBytes,
  type ValidatedTrustedImageOutput,
} from "./trusted-output";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const roots: string[] = [];

afterEach(async () => {
  setTrustedOutputReadHookForTest(null);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(join(await realpath(tmpdir()), "trusted-output-"));
  roots.push(base);
  const root = join(base, "allowed");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}

describe("readTrustedImageOutput", () => {
  test("reads a regular image inside the trusted root and sniffs its MIME", async () => {
    const { root } = await fixture();
    const path = join(root, "generated.png");
    await writeFile(path, PNG);

    const output = await readTrustedImageOutput({ kind: "isolated_host_output", root, path }, 1024);
    expect(output).toEqual({ name: "generated.png", contentType: "image/png", sizeBytes: PNG.length });
    expect(validatedTrustedImageBytes(output)).toEqual(PNG);
  });

  test("rejects outside-root paths and symlink escapes", async () => {
    const { root, outside } = await fixture();
    const outsidePath = join(outside, "secret.png");
    const linkPath = join(root, "link.png");
    await writeFile(outsidePath, PNG);
    await symlink(outsidePath, linkPath);

    await expect(readTrustedImageOutput({ kind: "isolated_host_output", root, path: outsidePath }, 1024))
      .rejects.toThrow("output_path_outside_root");
    await expect(readTrustedImageOutput({ kind: "isolated_host_output", root, path: linkPath }, 1024))
      .rejects.toThrow("output_symlink_not_allowed");
  });

  test("rejects a symlink even when it resolves inside the trusted root", async () => {
    const { root } = await fixture();
    const target = join(root, "target.png");
    const linkPath = join(root, "inside-link.png");
    await writeFile(target, PNG);
    await symlink(target, linkPath);

    await expect(readTrustedImageOutput({ kind: "isolated_host_output", root, path: linkPath }, 1024))
      .rejects.toThrow("output_symlink_not_allowed");
  });

  test("rejects a file hardlinked across the trusted root boundary", async () => {
    const { root, outside } = await fixture();
    const outsidePath = join(outside, "secret.png");
    const insidePath = join(root, "image.png");
    await writeFile(outsidePath, PNG);
    await link(outsidePath, insidePath);

    await expect(readTrustedImageOutput({
      kind: "isolated_host_output",
      root,
      path: insidePath,
    }, 1024)).rejects.toThrow("output_hardlink_not_allowed");
  });

  test("rejects symlinks in the root and in an ancestor directory", async () => {
    const { root, outside } = await fixture();
    const realRoot = join(root, "real-root");
    const rootLink = join(root, "root-link");
    const ancestorLink = join(root, "ancestor-link");
    await mkdir(realRoot);
    await writeFile(join(realRoot, "image.png"), PNG);
    await writeFile(join(outside, "image.png"), PNG);
    await symlink(realRoot, rootLink);
    await symlink(outside, ancestorLink);

    await expect(readTrustedImageOutput({
      kind: "isolated_host_output",
      root: rootLink,
      path: join(rootLink, "image.png"),
    }, 1024)).rejects.toThrow("output_symlink_not_allowed");
    await expect(readTrustedImageOutput({
      kind: "isolated_host_output",
      root,
      path: join(ancestorLink, "image.png"),
    }, 1024)).rejects.toThrow("output_symlink_not_allowed");
  });

  test("rejects final-component and ancestor swaps between inspection and open", async () => {
    const { root, outside } = await fixture();
    const finalPath = join(root, "final.png");
    await writeFile(finalPath, PNG);
    setTrustedOutputReadHookForTest(async (stage) => {
      if (stage !== "before_open") return;
      await rename(finalPath, join(root, "original.png"));
      await writeFile(finalPath, PNG);
    });
    await expect(readTrustedImageOutput({ kind: "isolated_host_output", root, path: finalPath }, 1024))
      .rejects.toThrow("output_path_changed");

    setTrustedOutputReadHookForTest(null);
    const ancestor = join(root, "ancestor");
    const outsideFile = join(outside, "image.png");
    await mkdir(ancestor);
    await writeFile(join(ancestor, "image.png"), PNG);
    await writeFile(outsideFile, PNG);
    setTrustedOutputReadHookForTest(async (stage) => {
      if (stage !== "before_open") return;
      await rename(ancestor, join(root, "original-ancestor"));
      await symlink(outside, ancestor);
    });
    await expect(readTrustedImageOutput({
      kind: "isolated_host_output",
      root,
      path: join(ancestor, "image.png"),
    }, 1024)).rejects.toThrow(/output_(path_changed|path_outside_root)/);
  });

  test("rejects directories, oversized output, and extension-only images", async () => {
    const { root } = await fixture();
    const directory = join(root, "folder.png");
    const oversized = join(root, "oversized.png");
    const fake = join(root, "fake.png");
    await mkdir(directory);
    await writeFile(oversized, new Uint8Array([...PNG, 0x01, 0x02]));
    await writeFile(fake, "not an image");

    await expect(readTrustedImageOutput({ kind: "isolated_host_output", root, path: directory }, 1024))
      .rejects.toThrow("output_not_regular_file");
    await expect(readTrustedImageOutput({ kind: "isolated_host_output", root, path: oversized }, PNG.length))
      .rejects.toThrow("output_too_large");
    await expect(readTrustedImageOutput({ kind: "isolated_host_output", root, path: fake }, 1024))
      .rejects.toThrow("output_content_type_not_allowed");
  });

  test("supports already-trusted bytes without accepting empty output", async () => {
    await expect(readTrustedImageOutput({ kind: "trusted_bytes", bytes: PNG, name: "photo.html" }, 1024))
      .resolves.toEqual({ name: "photo.png", contentType: "image/png", sizeBytes: PNG.length });
    await expect(
      readTrustedImageOutput({ kind: "trusted_bytes", bytes: new Uint8Array(), name: "empty.png" }, 1024),
    ).rejects.toThrow("output_empty");
    expect(() => validatedTrustedImageBytes({
      name: "forged.png",
      contentType: "image/png",
      sizeBytes: PNG.length,
    } as ValidatedTrustedImageOutput)).toThrow("output_not_validated");
  });

  test("bounds a file that grows after open and never leaks filesystem paths", async () => {
    const { root } = await fixture();
    const path = join(root, "growing.png");
    await writeFile(path, PNG);
    setTrustedOutputReadHookForTest(async (stage) => {
      if (stage === "before_read") await appendFile(path, new Uint8Array([0x01]));
    });
    await expect(readTrustedImageOutput({ kind: "isolated_host_output", root, path }, PNG.length))
      .rejects.toThrow("output_too_large");

    setTrustedOutputReadHookForTest(null);
    const missing = join(root, "private-customer-name.png");
    try {
      await readTrustedImageOutput({ kind: "isolated_host_output", root, path: missing }, 1024);
      throw new Error("expected missing output to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("output_path_unavailable");
      expect((error as Error).message).not.toContain(missing);
    }
  });
});
