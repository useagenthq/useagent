import { describe, expect, test } from "bun:test";
import { isPublicAddress, parseWebhookUrl } from "./url";

describe("webhook destinations", () => {
  test("accepts HTTPS hostnames and rejects unsafe URL forms", () => {
    expect(parseWebhookUrl("https://hooks.example.org/events")?.hostname).toBe("hooks.example.org");
    expect(parseWebhookUrl("http://hooks.example.org/events")).toBeNull();
    expect(parseWebhookUrl("https://user:pass@hooks.example.org/events")).toBeNull();
    expect(parseWebhookUrl("https://127.0.0.1/events")).toBeNull();
    expect(parseWebhookUrl("https://service.internal/events")).toBeNull();
  });

  test("blocks private, loopback, link-local, and reserved IP ranges", () => {
    expect(isPublicAddress("8.8.8.8", 4)).toBe(true);
    expect(isPublicAddress("10.0.0.4", 4)).toBe(false);
    expect(isPublicAddress("169.254.169.254", 4)).toBe(false);
    expect(isPublicAddress("::1", 6)).toBe(false);
    expect(isPublicAddress("fd00::1", 6)).toBe(false);
    expect(isPublicAddress("2606:4700:4700::1111", 6)).toBe(true);
  });
});
