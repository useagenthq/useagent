import { describe, expect, test } from "bun:test";
import {
  foldedSectionsStorageKey,
  foldedSectionsForUser,
  NOTHING_FOLDED,
  readFoldedSections,
  writeFoldedSections,
} from "./sidebar-section-fold";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("folded sidebar sections", () => {
  test("round-trips per user and defaults to nothing folded", () => {
    const storage = fakeStorage();
    expect(readFoldedSections(() => storage, "user-1")).toEqual(NOTHING_FOLDED);
    writeFoldedSections(() => storage, "user-1", { projects: true, threads: false });
    expect(readFoldedSections(() => storage, "user-1")).toEqual({ projects: true, threads: false });
    expect(readFoldedSections(() => storage, "user-2")).toEqual(NOTHING_FOLDED);
    expect(storage.data.has(foldedSectionsStorageKey("user-1"))).toBe(true);
  });

  test("treats garbage, missing storage and non-boolean values as nothing folded", () => {
    expect(readFoldedSections(() => null, "user-1")).toEqual(NOTHING_FOLDED);
    expect(
      readFoldedSections(
        () => fakeStorage({ [foldedSectionsStorageKey("user-1")]: "{not json" }),
        "user-1",
      ),
    ).toEqual(NOTHING_FOLDED);
    expect(
      readFoldedSections(
        () => fakeStorage({ [foldedSectionsStorageKey("user-1")]: '"yes"' }),
        "user-1",
      ),
    ).toEqual(NOTHING_FOLDED);
    expect(
      readFoldedSections(
        () => fakeStorage({
          [foldedSectionsStorageKey(null)]: '{"projects":"true","threads":true,"extra":true}',
        }),
        null,
      ),
    ).toEqual({ projects: false, threads: true });
  });

  test("swallows storage failures", () => {
    const failing = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeFoldedSections(() => failing, "user-1", NOTHING_FOLDED)).not.toThrow();
  });

  test("swallows a SecurityError thrown by the localStorage getter", () => {
    const getStorage = () => {
      throw new DOMException("Access denied", "SecurityError");
    };

    expect(readFoldedSections(getStorage, "user-1")).toEqual(NOTHING_FOLDED);
    expect(() => writeFoldedSections(getStorage, "user-1", NOTHING_FOLDED)).not.toThrow();
  });

  test("keeps a user preference pending until that user's storage read completes", () => {
    const userOne = { userId: "user-1", value: { projects: true, threads: false } } as const;

    expect(foldedSectionsForUser(null, "user-1")).toBeNull();
    expect(foldedSectionsForUser(userOne, "user-2")).toBeNull();
    expect(foldedSectionsForUser(userOne, "user-1")).toEqual(userOne.value);
  });
});
