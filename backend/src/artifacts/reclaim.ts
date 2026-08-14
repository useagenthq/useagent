import { db } from "../db/client";
import { artifacts, userUploads } from "../db/schema";
import { artifactStorage, LocalArtifactStorage } from "./storage";
import { eq, sql } from "drizzle-orm";

export async function listReferencedArtifactStorageKeys(): Promise<Set<string>> {
  const [artifactRows, uploadRows] = await Promise.all([
    db.select({ storageKey: artifacts.storageKey }).from(artifacts),
    db.select({ storageKey: userUploads.storageKey }).from(userUploads),
  ]);
  return new Set([
    ...artifactRows.map((row) => row.storageKey),
    ...uploadRows.map((row) => row.storageKey),
  ]);
}

export async function artifactStorageKeyIsReferenced(storageKey: string): Promise<boolean> {
  const [artifactRows, uploadRows] = await Promise.all([
    db
      .select({ found: sql<number>`1` })
      .from(artifacts)
      .where(eq(artifacts.storageKey, storageKey))
      .limit(1),
    db
      .select({ found: sql<number>`1` })
      .from(userUploads)
      .where(eq(userUploads.storageKey, storageKey))
      .limit(1),
  ]);
  return artifactRows.length > 0 || uploadRows.length > 0;
}

export async function reclaimUnreferencedLocalArtifacts(input: {
  readonly dryRun?: boolean;
  readonly minAgeMs?: number;
  readonly now?: Date;
} = {}): Promise<{ scanned: number; removed: string[]; retained: string[] }> {
  const storage = artifactStorage();
  if (!(storage instanceof LocalArtifactStorage)) {
    throw new Error("artifact orphan reclamation is only supported by local artifact storage");
  }
  const referencedKeys = await listReferencedArtifactStorageKeys();
  return storage.reclaimUnreferenced({
    ...input,
    referencedKeys,
    isReferenced: artifactStorageKeyIsReferenced,
  });
}
