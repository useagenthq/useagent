import { afterEach, describe, expect, test } from "bun:test";
import {
  assertThreadRelationshipRolloutConfig,
  productChildThreadsEnabled,
  threadRelationshipReadEnabled,
} from "./thread-relationship-rollout";

const original = {
  write: process.env.THREAD_RELATIONSHIPS_WRITE,
  read: process.env.THREAD_RELATIONSHIPS_READ,
  children: process.env.PRODUCT_CHILD_THREADS,
  canary: process.env.PRODUCT_CHILD_CANARY_ORG_IDS,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    THREAD_RELATIONSHIPS_WRITE: original.write,
    THREAD_RELATIONSHIPS_READ: original.read,
    PRODUCT_CHILD_THREADS: original.children,
    PRODUCT_CHILD_CANARY_ORG_IDS: original.canary,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("thread relationship rollout", () => {
  test("fails boot configuration when product children outrun relationship truth", () => {
    process.env.THREAD_RELATIONSHIPS_WRITE = "off";
    process.env.THREAD_RELATIONSHIPS_READ = "off";
    process.env.PRODUCT_CHILD_THREADS = "on";
    expect(() => assertThreadRelationshipRolloutConfig()).toThrow();
  });

  test("accepts the staged and fully-on configurations without a composer switch", () => {
    process.env.THREAD_RELATIONSHIPS_WRITE = "shadow";
    process.env.THREAD_RELATIONSHIPS_READ = "read";
    process.env.PRODUCT_CHILD_THREADS = "on";
    // A stale PRODUCT_CHILD_COMPOSER line in an env file is inert, never a gate.
    process.env.PRODUCT_CHILD_COMPOSER = "off";
    expect(() => assertThreadRelationshipRolloutConfig()).not.toThrow();
    expect(productChildThreadsEnabled("org-any")).toBe(true);
    delete process.env.PRODUCT_CHILD_COMPOSER;
  });

  test("enables read and child threads only for bounded allowlisted orgs", () => {
    process.env.THREAD_RELATIONSHIPS_WRITE = "shadow";
    process.env.THREAD_RELATIONSHIPS_READ = "off";
    process.env.PRODUCT_CHILD_THREADS = "off";
    process.env.PRODUCT_CHILD_CANARY_ORG_IDS = "org-canary,org-canary";
    expect(() => assertThreadRelationshipRolloutConfig()).not.toThrow();
    expect(threadRelationshipReadEnabled("org-canary")).toBe(true);
    expect(productChildThreadsEnabled("org-canary")).toBe(true);
    expect(threadRelationshipReadEnabled("org-other")).toBe(false);
    expect(productChildThreadsEnabled("org-other")).toBe(false);
  });

  test("fails closed for invalid or write-disabled canary configuration", () => {
    process.env.THREAD_RELATIONSHIPS_WRITE = "shadow";
    process.env.PRODUCT_CHILD_CANARY_ORG_IDS = "org-good,bad org";
    expect(() => assertThreadRelationshipRolloutConfig()).toThrow(/comma-separated/);
    process.env.PRODUCT_CHILD_CANARY_ORG_IDS = "org-good";
    process.env.THREAD_RELATIONSHIPS_WRITE = "off";
    expect(() => assertThreadRelationshipRolloutConfig()).toThrow(/WRITE=shadow/);
  });
});
