import { describe, expect, test } from "bun:test";
import { assertOssSyncSafe } from "./assert-oss-sync-safe";

describe("Pro to OSS sync boundary", () => {
  test("accepts shared product paths", () => {
    expect(() => assertOssSyncSafe([
      "backend/src/middleware/org.ts",
      "frontend/components/chat/conversation.tsx",
    ])).not.toThrow();
  });

  test("rejects private deploy and production Terraform paths", () => {
    expect(() => assertOssSyncSafe(["deploy/hetzner/deploy-release.sh"]))
      .toThrow("OSS sync contains private paths");
    expect(() => assertOssSyncSafe(["infra/terraform/prod/main.tf"]))
      .toThrow("OSS sync contains private paths");
  });
});
