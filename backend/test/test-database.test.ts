import { describe, expect, test } from "bun:test";
import { DEFAULT_TEST_DATABASE_URL, testDatabaseName, testDatabaseUrl } from "./test-database";

describe("test database selection", () => {
  test("prepare-db resets the database TEST_DATABASE_URL points at, not a hardcoded name", () => {
    const url = "postgres://postgres@127.0.0.1:5433/useagent_fix_test_f";
    expect(testDatabaseUrl({ TEST_DATABASE_URL: url })).toBe(url);
    expect(testDatabaseName(testDatabaseUrl({ TEST_DATABASE_URL: url }))).toBe("useagent_fix_test_f");
  });

  test("falls back to the stock local database when the variable is unset or blank", () => {
    expect(testDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(testDatabaseUrl({ TEST_DATABASE_URL: "  " })).toBe(DEFAULT_TEST_DATABASE_URL);
    expect(testDatabaseName(DEFAULT_TEST_DATABASE_URL)).toBe("useagent_test");
  });

  test("refuses names that are not plain identifiers before they reach DROP DATABASE", () => {
    expect(() => testDatabaseName("postgres://postgres@localhost:5432/")).toThrow(/plain database identifier/);
    expect(() => testDatabaseName("postgres://postgres@localhost:5432/a%20b")).toThrow(/plain database identifier/);
    expect(() => testDatabaseName("postgres://postgres@localhost:5432/x;drop")).toThrow(/plain database identifier/);
    expect(() => testDatabaseName("not a url")).toThrow(/valid URL/);
  });
});
