import { describe, expect, test } from "bun:test";
import {
  currentReleaseFingerprint,
  isClientReleaseCompatible,
  USEAGENT_API_COMPAT,
} from "./release";

describe("release fingerprint", () => {
  test("normalizes the configured commit into the API compatibility fingerprint", () => {
    expect(
      currentReleaseFingerprint({
        USEAGENT_RELEASE_COMMIT: "ABCDEF1234567890",
        USEAGENT_RELEASE_COMMIT_FILE: "/definitely/missing",
      }),
    ).toEqual({
      apiCompat: USEAGENT_API_COMPAT,
      commit: "abcdef1234567890",
      fingerprint: `${USEAGENT_API_COMPAT}:abcdef1234567890`,
    });
  });

  test("allows absent clients and dev servers but rejects stale concrete fingerprints", () => {
    const server = `${USEAGENT_API_COMPAT}:2222222`;

    expect(isClientReleaseCompatible(undefined, server)).toBe(true);
    expect(isClientReleaseCompatible(`${USEAGENT_API_COMPAT}:2222222`, `${USEAGENT_API_COMPAT}:dev`)).toBe(true);
    expect(isClientReleaseCompatible(server, server)).toBe(true);
    expect(isClientReleaseCompatible(`${USEAGENT_API_COMPAT}:dev`, server)).toBe(false);
    expect(isClientReleaseCompatible(`${USEAGENT_API_COMPAT}:1111111`, server)).toBe(false);
  });
});
