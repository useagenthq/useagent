import { describe, expect, test } from "bun:test";
import { encodeTaskPageCursor, parseTaskPageCursor } from "./page-cursor";

const CURSOR = {
  orderKey: 2.5,
  createdAtMicros: "1793865600123456",
  id: "0b6f6bb4-4a7e-4a55-9a37-2f1b0a1b9f10",
};

function encodeRaw(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("task page cursor", () => {
  test("round-trips a page's last sort key, fractional and negative positions included", () => {
    expect(parseTaskPageCursor(encodeTaskPageCursor(CURSOR))).toEqual(CURSOR);
    const negative = { ...CURSOR, orderKey: -0.123456789012345 };
    expect(parseTaskPageCursor(encodeTaskPageCursor(negative))).toEqual(negative);
  });

  test("refuses anything that is not a cursor it made", () => {
    for (const value of [
      "",
      "not base64!",
      "a".repeat(600),
      encodeRaw({ orderKey: 1 }),
      encodeRaw([1, "1793865600123456"]),
      encodeRaw(["1", CURSOR.createdAtMicros, CURSOR.id]),
      encodeRaw([null, CURSOR.createdAtMicros, CURSOR.id]),
      encodeRaw([1, 1793865600123456, CURSOR.id]),
      encodeRaw([1, "-5", CURSOR.id]),
      encodeRaw([1, "1.5", CURSOR.id]),
      encodeRaw([1, "999999999999999999", CURSOR.id]),
      encodeRaw([1, CURSOR.createdAtMicros, "not-a-uuid"]),
      Buffer.from("[1,", "utf8").toString("base64url"),
    ]) {
      expect(parseTaskPageCursor(value)).toBeNull();
    }
  });
});
