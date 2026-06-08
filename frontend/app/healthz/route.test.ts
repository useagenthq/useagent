import { describe, expect, test } from "bun:test";

import { GET } from "./route";

describe("frontend release health", () => {
  test("reports the build commit", async () => {
    const previous = process.env.NEXT_PUBLIC_USEAGENT_RELEASE_COMMIT;
    process.env.NEXT_PUBLIC_USEAGENT_RELEASE_COMMIT = "abcdef1234567890";
    try {
      expect(await GET().json()).toEqual({
        status: "ok",
        release: { commit: "abcdef1234567890" },
      });
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_USEAGENT_RELEASE_COMMIT;
      else process.env.NEXT_PUBLIC_USEAGENT_RELEASE_COMMIT = previous;
    }
  });
});
