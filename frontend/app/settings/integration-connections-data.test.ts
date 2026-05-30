import { describe, expect, test } from "bun:test";
import {
  decodeIntegrationSummaries,
  decodeIntegrationSummary,
} from "./integration-connections-data";

describe("integration summary wire decoder", () => {
  test("fails lifecycle capabilities closed when the backend omits them", () => {
    expect(
      decodeIntegrationSummary({
        provider: "github",
        displayName: "GitHub",
        description: "Native repository workflows.",
        backend: "native",
        managed: true,
        status: "connected",
        connection: null,
      }),
    ).toMatchObject({
      provider: "github",
      managed: true,
      connectAvailable: false,
      disconnectAvailable: false,
    });
  });

  test("drops an entry whose browser-safe connection projection is malformed", () => {
    expect(
      decodeIntegrationSummaries([
        {
          provider: "linear",
          displayName: "Linear",
          description: "Issue tracking.",
          backend: "openconnector",
          managed: false,
          connectAvailable: true,
          disconnectAvailable: false,
          status: "unavailable",
          connection: { id: "secret-only-partial-object" },
        },
      ]),
    ).toEqual([]);
  });
});
