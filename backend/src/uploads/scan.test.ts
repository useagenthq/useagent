import { afterEach, describe, expect, test } from "bun:test";
import {
  UploadScanError,
  scanUploadBytes,
  setUploadScannerForTest,
} from "./scan";

afterEach(() => {
  setUploadScannerForTest(null);
  delete process.env.UPLOAD_SCAN_COMMAND;
  delete process.env.UPLOAD_SCAN_REQUIRED;
  delete process.env.UPLOAD_SCAN_TIMEOUT_MS;
});

describe("upload malware scanner boundary", () => {
  test("allows an explicitly optional scanner in development", async () => {
    process.env.UPLOAD_SCAN_REQUIRED = "false";
    await expect(
      scanUploadBytes({
        name: "notes.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode("hello"),
      }),
    ).resolves.toEqual({ scanned: false });
  });

  test("fails closed in production when no scanner is configured", async () => {
    process.env.UPLOAD_SCAN_REQUIRED = "true";

    await expect(
      scanUploadBytes({
        name: "notes.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode("hello"),
      }),
    ).rejects.toThrow("upload scanner is required");
  });

  test("uses a configurable scanner hook without adding an external dependency", async () => {
    const calls: string[] = [];
    setUploadScannerForTest(async (input) => {
      calls.push(`${input.name}:${input.contentType}:${input.bytes.byteLength}`);
      return { scanned: true };
    });

    await expect(
      scanUploadBytes({
        name: "report.csv",
        contentType: "text/csv",
        bytes: new TextEncoder().encode("a,b\n"),
      }),
    ).resolves.toEqual({ scanned: true });
    expect(calls).toEqual(["report.csv:text/csv:4"]);
  });

  test("fails closed when the configured scanner rejects the file", async () => {
    setUploadScannerForTest(async () => {
      throw new UploadScanError("scanner rejected upload");
    });

    await expect(
      scanUploadBytes({
        name: "payload.bin",
        contentType: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toBeInstanceOf(UploadScanError);
  });

  test("terminates a scanner that exceeds its bounded execution window", async () => {
    process.env.UPLOAD_SCAN_COMMAND = "sleep 10 #";
    process.env.UPLOAD_SCAN_TIMEOUT_MS = "25";

    await expect(
      scanUploadBytes({
        name: "payload.bin",
        contentType: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow("upload scanner timed out");
  });
});
