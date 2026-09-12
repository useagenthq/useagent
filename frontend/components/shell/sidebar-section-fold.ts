// Which rail sections the user folded away (Projects, Threads), remembered per
// user like the per-project expand state. Best-effort: private mode, SSR and
// garbage in storage all read as "nothing folded".
export type SidebarSection = "projects" | "threads";
export type FoldedSections = Readonly<Record<SidebarSection, boolean>>;
export type LoadedFoldedSections = Readonly<{
  userId: string | null;
  value: FoldedSections;
}>;

const STORAGE_KEY = "useagent.sidebar.folded";

export const NOTHING_FOLDED: FoldedSections = { projects: false, threads: false };

export function foldedSectionsForUser(
  loaded: LoadedFoldedSections | null,
  userId: string | null,
): FoldedSections | null {
  return loaded?.userId === userId ? loaded.value : null;
}

export function foldedSectionsStorageKey(userId: string | null): string {
  return `${STORAGE_KEY}:${userId ?? "anonymous"}`;
}

export function readFoldedSections(
  getStorage: () => Pick<Storage, "getItem"> | null,
  userId: string | null,
): FoldedSections {
  try {
    const storage = getStorage();
    if (!storage) return NOTHING_FOLDED;
    const raw = storage.getItem(foldedSectionsStorageKey(userId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return NOTHING_FOLDED;
    const record = parsed as Record<string, unknown>;
    return { projects: record.projects === true, threads: record.threads === true };
  } catch {
    return NOTHING_FOLDED;
  }
}

export function writeFoldedSections(
  getStorage: () => Pick<Storage, "setItem"> | null,
  userId: string | null,
  value: FoldedSections,
): void {
  try {
    const storage = getStorage();
    storage?.setItem(foldedSectionsStorageKey(userId), JSON.stringify(value));
  } catch {
    /* private mode / storage full - fold state is best-effort */
  }
}
