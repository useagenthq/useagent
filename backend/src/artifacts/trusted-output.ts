import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, parse, relative, resolve, sep } from "node:path";

export type TrustedOutputLocator =
  | {
      readonly kind: "isolated_host_output";
      readonly root: string;
      readonly path: string;
    }
  | {
      readonly kind: "trusted_bytes";
      readonly bytes: Uint8Array;
      readonly name: string;
    };

export interface ValidatedTrustedImageOutput {
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

type ReadHookStage = "before_open" | "before_read";
type ReadHook = (stage: ReadHookStage) => void | Promise<void>;
type FileIdentity = { readonly dev: bigint; readonly ino: bigint; readonly nlink: bigint };

const validatedBytes = new WeakMap<ValidatedTrustedImageOutput, Uint8Array>();
let readHookForTest: ReadHook | null = null;

class TrustedOutputError extends Error {
  constructor(code: string) {
    super(code);
  }
}

const IMAGE_SIGNATURES = [
  {
    contentType: "image/png",
    extension: "png",
    matches: (bytes: Uint8Array) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
  },
  {
    contentType: "image/jpeg",
    extension: "jpg",
    matches: (bytes: Uint8Array) =>
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    contentType: "image/gif",
    extension: "gif",
    matches: (bytes: Uint8Array) => {
      if (bytes.length < 6) return false;
      const header = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
      return header === "GIF87a" || header === "GIF89a";
    },
  },
  {
    contentType: "image/webp",
    extension: "webp",
    matches: (bytes: Uint8Array) =>
      bytes.length >= 12 &&
      Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
      Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP",
  },
] as const;

function fail(code: string): never {
  throw new TrustedOutputError(code);
}

function safeOutputName(value: string, extension: string): string {
  const candidate = basename(value.replaceAll("\\", "/"));
  const stem = candidate
    .replace(/\.[^.]*$/, "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .slice(0, 175) || "output";
  return `${stem}.${extension}`;
}

function sniffImage(bytes: Uint8Array): (typeof IMAGE_SIGNATURES)[number] {
  const match = IMAGE_SIGNATURES.find((signature) => signature.matches(bytes));
  return match ?? fail("output_content_type_not_allowed");
}

function assertBoundedBytes(bytes: Uint8Array, maxBytes: number): void {
  if (bytes.byteLength === 0) fail("output_empty");
  if (bytes.byteLength > maxBytes) fail("output_too_large");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function componentPaths(value: string): string[] {
  const root = parse(value).root;
  const parts = value.slice(root.length).split(sep).filter(Boolean);
  const paths = [root];
  for (const part of parts) paths.push(resolve(paths.at(-1)!, part));
  return paths;
}

async function snapshotComponents(paths: readonly string[]): Promise<Map<string, FileIdentity>> {
  const snapshot = new Map<string, FileIdentity>();
  for (const path of paths) {
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) fail("output_symlink_not_allowed");
    snapshot.set(path, { dev: stat.dev, ino: stat.ino, nlink: stat.nlink });
  }
  return snapshot;
}

function sameIdentity(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino &&
    left.nlink === right.nlink;
}

function assertUnchanged(
  before: ReadonlyMap<string, FileIdentity>,
  after: ReadonlyMap<string, FileIdentity>,
): void {
  for (const [path, identity] of before) {
    if (!sameIdentity(identity, after.get(path))) fail("output_path_changed");
  }
}

async function readBounded(handle: FileHandle, maxBytes: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const result = bytes.subarray(0, offset);
  assertBoundedBytes(result, maxBytes);
  return new Uint8Array(result);
}

function validatedImage(bytes: Uint8Array, sourceName: string): ValidatedTrustedImageOutput {
  const signature = sniffImage(bytes);
  const output = Object.freeze({
    name: safeOutputName(sourceName, signature.extension),
    contentType: signature.contentType,
    sizeBytes: bytes.byteLength,
  });
  validatedBytes.set(output, new Uint8Array(bytes));
  return output;
}

function translateError(error: unknown): never {
  if (error instanceof TrustedOutputError) throw error;
  fail("output_path_unavailable");
}

/** Test-only race injection after component inspection and after opening the fd. */
export function setTrustedOutputReadHookForTest(hook: ReadHook | null): void {
  readHookForTest = hook;
}

/** Return an isolated copy only for an object emitted by this module's reader. */
export function validatedTrustedImageBytes(output: ValidatedTrustedImageOutput): Uint8Array {
  const bytes = validatedBytes.get(output);
  if (!bytes) fail("output_not_validated");
  return new Uint8Array(bytes);
}

export async function readTrustedImageOutput(
  locator: TrustedOutputLocator,
  maxBytes: number,
): Promise<ValidatedTrustedImageOutput> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("output_size_limit_invalid");

  if (locator.kind === "trusted_bytes") {
    const bytes = new Uint8Array(locator.bytes);
    assertBoundedBytes(bytes, maxBytes);
    return validatedImage(bytes, locator.name);
  }

  let handle: FileHandle | null = null;
  try {
    if (!isAbsolute(locator.root) || !isAbsolute(locator.path)) fail("output_path_invalid");
    const root = resolve(locator.root);
    const candidate = resolve(locator.path);
    if (root !== locator.root || candidate !== locator.path) fail("output_path_invalid");
    if (!isInsideRoot(root, candidate)) fail("output_path_outside_root");

    const paths = [...new Set([...componentPaths(root), ...componentPaths(candidate)])];
    const before = await snapshotComponents(paths);
    const candidateIdentity = before.get(candidate);
    if (!candidateIdentity) fail("output_path_unavailable");

    await readHookForTest?.("before_open");
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) fail("output_not_regular_file");
    if (candidateIdentity.nlink !== 1n) fail("output_hardlink_not_allowed");
    if (opened.nlink !== 1n) fail("output_hardlink_not_allowed");
    if (!sameIdentity(candidateIdentity, {
      dev: opened.dev,
      ino: opened.ino,
      nlink: opened.nlink,
    })) {
      fail("output_path_changed");
    }

    if (process.platform === "linux") {
      const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
      if (!isInsideRoot(root, openedPath)) fail("output_path_outside_root");
    }

    await readHookForTest?.("before_read");
    const bytes = await readBounded(handle, maxBytes);
    const after = await snapshotComponents(paths);
    assertUnchanged(before, after);
    return validatedImage(bytes, candidate);
  } catch (error) {
    return translateError(error);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
