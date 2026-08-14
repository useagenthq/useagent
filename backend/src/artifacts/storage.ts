import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ArtifactByteRange {
  readonly start: number;
  readonly end: number;
}

export interface ArtifactStorage {
  put(storageKey: string, bytes: Uint8Array): Promise<void>;
  read(storageKey: string, range?: ArtifactByteRange): Promise<Uint8Array>;
  size(storageKey: string): Promise<number>;
}

const STORAGE_KEY = /^[a-f0-9]{64}$/;

function checkedKey(storageKey: string): string {
  if (!STORAGE_KEY.test(storageKey)) throw new Error("invalid artifact storage key");
  return storageKey;
}

export class LocalArtifactStorage implements ArtifactStorage {
  constructor(
    private readonly root =
      process.env.ARTIFACT_STORAGE_DIR ?? join(import.meta.dir, "..", "..", ".artifacts"),
  ) {}

  private path(storageKey: string): string {
    const key = checkedKey(storageKey);
    return join(this.root, key.slice(0, 2), key);
  }

  async put(storageKey: string, bytes: Uint8Array): Promise<void> {
    const target = this.path(storageKey);
    // Content-addressed bytes may already have been published by the other
    // trusted service account. That process owns the file, so chmod would fail
    // even though the shared skynet-data group can already read it.
    if (await Bun.file(target).exists()) return;
    const directory = dirname(target);
    const createdDirectory = await mkdir(directory, { recursive: true });
    // Backend and trusted gateway run as separate users in the shared
    // skynet-data group. Both services use a restrictive umask, so explicitly
    // restore group traversal/read after creation rather than producing rows
    // whose bytes only the publishing process can serve.
    // An existing digest-prefix directory may be owned by the sibling trusted
    // service account. It already inherits the shared-group mode from the
    // deployment root; only chmod a directory this process actually created.
    if (createdDirectory) await chmod(directory, 0o2770);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await chmod(temporary, 0o660);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async read(storageKey: string, range?: ArtifactByteRange): Promise<Uint8Array> {
    const file = Bun.file(this.path(storageKey));
    if (!(await file.exists())) throw new Error("artifact bytes are missing");
    const selected = range ? file.slice(range.start, range.end + 1) : file;
    return new Uint8Array(await selected.arrayBuffer());
  }

  async size(storageKey: string): Promise<number> {
    const file = Bun.file(this.path(storageKey));
    if (!(await file.exists())) throw new Error("artifact bytes are missing");
    return file.size;
  }
}

let override: ArtifactStorage | null = null;
const local = new LocalArtifactStorage();

export function artifactStorage(): ArtifactStorage {
  return override ?? local;
}

/** Test-only storage substitution. Production always uses the configured
 * storage adapter. */
export function setArtifactStorageForTest(storage: ArtifactStorage | null): void {
  override = storage;
}
