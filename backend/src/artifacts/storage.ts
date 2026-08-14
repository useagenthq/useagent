import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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
const STORAGE_PREFIX = /^[a-f0-9]{2}$/;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

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

  async reclaimUnreferenced(input: {
    readonly referencedKeys: ReadonlySet<string>;
    readonly isReferenced?: (storageKey: string) => Promise<boolean>;
    readonly minAgeMs?: number;
    readonly dryRun?: boolean;
    readonly now?: Date;
  }): Promise<{ scanned: number; removed: string[]; retained: string[] }> {
    const cutoffMs = (input.now ?? new Date()).getTime() - (input.minAgeMs ?? 24 * 60 * 60 * 1000);
    const removed: string[] = [];
    const retained: string[] = [];
    let scanned = 0;

    let prefixes: string[];
    try {
      prefixes = await readdir(this.root);
    } catch (error) {
      if (missing(error)) return { scanned, removed, retained };
      throw error;
    }

    for (const prefix of prefixes.toSorted()) {
      if (!STORAGE_PREFIX.test(prefix)) continue;
      const directory = join(this.root, prefix);
      let directoryInfo;
      try {
        directoryInfo = await lstat(directory);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      if (!directoryInfo.isDirectory()) continue;
      let keys: string[];
      try {
        keys = await readdir(directory);
      } catch (error) {
        if (missing(error)) continue;
        throw error;
      }
      for (const key of keys.toSorted()) {
        if (!STORAGE_KEY.test(key) || !key.startsWith(prefix)) continue;
        scanned += 1;
        if (input.referencedKeys.has(key)) {
          retained.push(key);
          continue;
        }
        const path = join(directory, key);
        let info;
        try {
          info = await stat(path);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        if (info.mtimeMs > cutoffMs) {
          retained.push(key);
          continue;
        }
        if (input.dryRun) {
          if (await input.isReferenced?.(key)) retained.push(key);
          else removed.push(key);
          continue;
        }

        // Quarantine by atomic rename before the final database recheck. A
        // concurrent publisher either inserted its reference before this
        // recheck (restore the quarantined bytes) or observes the canonical
        // path missing and writes a fresh copy. In neither interleaving can GC
        // unlink the publisher's canonical bytes.
        const quarantined = `${path}.${randomUUID()}.reclaim`;
        try {
          await rename(path, quarantined);
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        if (await input.isReferenced?.(key)) {
          if (await Bun.file(path).exists()) await unlink(quarantined);
          else await rename(quarantined, path);
          retained.push(key);
        } else {
          await unlink(quarantined).catch((error) => {
            if (!missing(error)) throw error;
          });
          removed.push(key);
        }
      }
    }

    return { scanned, removed, retained };
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
