import { describe, expect, test } from "bun:test";
import { productionComposeReleaseConfig } from "./release-config";

const valid = {
  USEAGENT_RELEASE_COLOR: "green",
  USEAGENT_RELEASE_COMMIT: "a".repeat(40),
  USEAGENT_GATEWAY_PUBLIC_URL: "https://gateway.useagent.example",
  USEAGENT_BACKEND_IMAGE: `ghcr.io/useagenthq/useagent-backend@sha256:${"b".repeat(64)}`,
  USEAGENT_GATEWAY_IMAGE: `ghcr.io/useagenthq/useagent-gateway@sha256:${"c".repeat(64)}`,
  USEAGENT_FRONTEND_IMAGE: `ghcr.io/useagenthq/useagent-frontend@sha256:${"d".repeat(64)}`,
  USEAGENT_BACKEND_PORT: "3211",
  USEAGENT_GATEWAY_PORT: "3212",
  USEAGENT_FRONTEND_PORT: "3410",
} as const;

describe("production Compose release config", () => {
  test("accepts exact digests and the fixed inactive-color ports", () => {
    expect(productionComposeReleaseConfig(valid)).toEqual({
      color: "green",
      commit: "a".repeat(40),
      publicGatewayUrl: "https://gateway.useagent.example",
      images: {
        backend: valid.USEAGENT_BACKEND_IMAGE,
        gateway: valid.USEAGENT_GATEWAY_IMAGE,
        frontend: valid.USEAGENT_FRONTEND_IMAGE,
      },
      ports: { backend: 3211, gateway: 3212, frontend: 3410 },
    });
  });

  test("rejects tags, digest drift, and a color/port mismatch", () => {
    expect(() => productionComposeReleaseConfig({
      ...valid,
      USEAGENT_BACKEND_IMAGE: "ghcr.io/useagenthq/useagent-backend:latest",
    })).toThrow("immutable sha256 reference");
    expect(() => productionComposeReleaseConfig({
      ...valid,
      USEAGENT_GATEWAY_IMAGE: `${valid.USEAGENT_GATEWAY_IMAGE}0`,
    })).toThrow("immutable sha256 reference");
    expect(() => productionComposeReleaseConfig({
      ...valid,
      USEAGENT_RELEASE_COLOR: "blue",
    })).toThrow("USEAGENT_BACKEND_PORT must be 3201 for blue");
    expect(() => productionComposeReleaseConfig({
      ...valid,
      USEAGENT_GATEWAY_PUBLIC_URL: "http://gateway:3202",
    })).toThrow("absolute HTTPS origin");
    expect(() => productionComposeReleaseConfig({
      ...valid,
      USEAGENT_GATEWAY_PUBLIC_URL: "https://gateway.useagent.example/path",
    })).toThrow("absolute HTTPS origin");
  });
});
