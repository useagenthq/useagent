import { describe, expect, test } from "bun:test";
import { artifactQueryForThread } from "./artifacts-rail-model";

describe("artifactQueryForThread", () => {
  test("scopes the durable artifact feed to the open thread", () => {
    expect(artifactQueryForThread("thread/a b")).toBe("/api/artifacts?thread_id=thread%2Fa%20b");
  });
});
