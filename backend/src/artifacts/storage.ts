import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ArtifactByteRange {
  readonly start: number;
  readonly end: number;
}

export interface ArtifactStorage {
  put(storageKey: string, bytes: Uint8Array): Promise<void>;
  read(storageKey: string, range?: ArtifactByteRange): Promise<Uint8Array>;
  size(storageKey: string): Promise<number>;
  sha256(storageKey: string): Promise<string>;
}

const STORAGE_KEY = /^[a-f0-9]{64}$/;
const STORAGE_PREFIX = /^[a-f0-9]{2}$/;
const RECLAIMED_KEY = /^([a-f0-9]{64})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.reclaim$/;

export interface ArtifactReclaimWarning {
  readonly code: "permission_denied";
  readonly operation: "lstat" | "readdir" | "stat" | "rename" | "link" | "unlink";
  readonly path: string;
  readonly storageKey?: string;
}

export interface ArtifactReclaimResult {
  readonly scanned: number;
  readonly removed: string[];
  readonly retained: string[];
  readonly warnings: ArtifactReclaimWarning[];
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function alreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function restoreQuarantinedBytes(quarantined: string, canonical: string): Promise<void> {
  try {
    await link(quarantined, canonical);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
  }
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
    // even though the shared useagent-data group can already read it.
    if (await Bun.file(target).exists()) return;
    const directory = dirname(target);
    const createdDirectory = await mkdir(directory, { recursive: true });
    // Backend and trusted gateway run as separate users in the shared
    // useagent-data group. Both services use a restrictive umask, so explicitly
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

  async sha256(storageKey: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(this.path(storageKey))) hash.update(chunk);
    return hash.digest("hex");
  }

  async reclaimUnreferenced(input: {
    readonly referencedKeys: ReadonlySet<string>;
    readonly isReferenced?: (storageKey: string) => Promise<boolean>;
    readonly minAgeMs?: number;
    readonly dryRun?: boolean;
    readonly now?: Date;
  }): Promise<ArtifactReclaimResult> {
    const cutoffMs = (input.now ?? new Date()).getTime() - (input.minAgeMs ?? 24 * 60 * 60 * 1000);
    const removed: string[] = [];
    const retained: string[] = [];
    const warnings: ArtifactReclaimWarning[] = [];
    let scanned = 0;

    const warnPermission = (
      operation: ArtifactReclaimWarning["operation"],
      path: string,
      storageKey?: string,
    ) => warnings.push(storageKey
      ? { code: "permission_denied", operation, path, storageKey }
      : { code: "permission_denied", operation, path });

    let prefixes: string[];
    try {
      prefixes = await readdir(this.root);
    } catch (error) {
      if (missing(error)) return { scanned, removed, retained, warnings };
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
        if (permissionDenied(error)) {
          warnPermission("lstat", directory);
          continue;
        }
        throw error;
      }
      if (!directoryInfo.isDirectory()) continue;
      let keys: string[];
      try {
        keys = await readdir(directory);
      } catch (error) {
        if (missing(error)) continue;
        if (permissionDenied(error)) {
          warnPermission("readdir", directory);
          continue;
        }
        throw error;
      }

      const candidates = new Set<string>();
      for (const entry of keys.toSorted()) {
        const reclaimed = RECLAIMED_KEY.exec(entry);
        if (!reclaimed) {
          if (STORAGE_KEY.test(entry)) candidates.add(entry);
          continue;
        }
        const key = reclaimed[1]!;
        if (!key.startsWith(prefix)) continue;
        const path = join(directory, key);
        const quarantined = join(directory, entry);
        try {
          await restoreQuarantinedBytes(quarantined, path);
          candidates.add(key);
        } catch (error) {
          if (missing(error)) continue;
          if (permissionDenied(error)) {
            warnPermission("link", quarantined, key);
            continue;
          }
          throw error;
        }
        try {
          await unlink(quarantined);
        } catch (error) {
          if (missing(error)) continue;
          if (permissionDenied(error)) {
            warnPermission("unlink", quarantined, key);
            continue;
          }
          throw error;
        }
      }

      for (const key of [...candidates].toSorted()) {
        if (!key.startsWith(prefix)) continue;
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
          if (permissionDenied(error)) {
            retained.push(key);
            warnPermission("stat", path, key);
            continue;
          }
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
          if (permissionDenied(error)) {
            retained.push(key);
            warnPermission("rename", path, key);
            continue;
          }
          throw error;
        }
        try {
          if (await input.isReferenced?.(key)) {
            await restoreQuarantinedBytes(quarantined, path);
            await unlink(quarantined);
            retained.push(key);
          } else {
            await unlink(quarantined).catch((error) => {
              if (!missing(error)) throw error;
            });
            removed.push(key);
          }
        } catch (error) {
          try {
            await restoreQuarantinedBytes(quarantined, path);
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              `artifact reclaim failed and could not restore ${key}`,
            );
          }
          await unlink(quarantined).catch(() => {});
          throw error;
        }
      }
    }

    return { scanned, removed, retained, warnings };
  }
}

let override: ArtifactStorage | null = null;
const local = new LocalArtifactStorage();

export function artifactStorage(): ArtifactStorage {
  return override ?? local;
}

/** The directory the local adapter writes into, as configured for this process. */
export function artifactStorageRoot(): string {
  return process.env.ARTIFACT_STORAGE_DIR ?? join(import.meta.dir, "..", "..", ".artifacts");
}

/**
 * Prove at boot that this process can write artifact bytes. Every service that
 * publishes (the backend and the sandbox gateway) calls this before it serves,
 * so a deployment whose container lacks the mount or points ARTIFACT_STORAGE_DIR
 * at a read-only path fails its health check instead of shipping a gateway
 * where every artifact_publish returns EROFS to the agent.
 */
export async function assertArtifactStorageWritable(root = artifactStorageRoot()): Promise<void> {
  const probe = join(root, `.write-probe.${randomUUID()}`);
  const committedProbe = `${probe}.done`;
  try {
    await mkdir(root, { recursive: true });
    const file = await open(probe, "wx");
    try {
      // An empty file can succeed on a full disk. Allocate and flush real bytes.
      await file.writeFile("useagent artifact storage probe\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(probe, 0o660);
    await rename(probe, committedProbe);
    await unlink(committedProbe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    throw new Error(
      `artifact storage is not writable (${code}) at ${root}: ` +
        "mount a writable directory there or point ARTIFACT_STORAGE_DIR at one",
    );
  } finally {
    await unlink(probe).catch(() => {});
    await unlink(committedProbe).catch(() => {});
  }
}

export type ArtifactStorageHealth = { readonly ok: true } | { readonly ok: false; readonly error: string };

const HEALTH_CACHE_MS = 30_000;
const healthCache = new Map<string, { at: number; result: ArtifactStorageHealth }>();

/**
 * The same probe for a health endpoint, cached per root so a 5-second
 * container health check does not write a file every time. A mount that
 * disappears or a disk that fills is checked again after the cache expires.
 * This proves root writability, not every existing digest directory's permissions.
 */
export async function artifactStorageHealth(root = artifactStorageRoot(), now = Date.now()): Promise<ArtifactStorageHealth> {
  const cached = healthCache.get(root);
  if (cached && now - cached.at < HEALTH_CACHE_MS) return cached.result;
  let result: ArtifactStorageHealth;
  try {
    await assertArtifactStorageWritable(root);
    result = { ok: true };
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  healthCache.set(root, { at: now, result });
  return result;
}

/** Test-only storage substitution. Production always uses the configured
 * storage adapter. */
export function setArtifactStorageForTest(storage: ArtifactStorage | null): void {
  override = storage;
}
