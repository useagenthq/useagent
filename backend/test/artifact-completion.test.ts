import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { renderArtifactExport } from "@useagent/artifact-formats";
import { csvToWorkbook, migrateSlidesToDeck } from "@useagent/artifact-workspace";
import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { setOfficePreviewConverterForTest } from "../src/artifacts/office-preview";
import { materializePptxImages } from "../src/artifacts/publish";
import * as artifactRepo from "../src/artifacts/repo";
import { setArtifactStorageForTest, type ArtifactStorage } from "../src/artifacts/storage";
import { recordOutputBaseline } from "../src/artifacts/harvest";
import { acceptRunCancel } from "../src/commands/cancel";
import { db } from "../src/db/client";
import {
  artifacts,
  finishedWorkObligations,
  finishedWorkReceipts,
  providerEvents,
  runs,
} from "../src/db/schema";
import { finalizeRun } from "../src/runs/finalize";
import { createRun, getRun, setRunSandbox, setRunStatus } from "../src/runs/repo";
import * as sandboxBindings from "../src/sandboxes/binding";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { startSlackOutbox, type SlackClient } from "../src/slack";
import { processDue, stopSlackOutboxRelay } from "../src/slack/outbox";
import { createSlackRunResponse, linkSlackThread } from "../src/slack/repo";
import {
  setSandboxDownloaderForTest,
  setSandboxPathResolverForTest,
} from "../src/slack/sandbox-file";
import { createOrgSession, fetchApi, json, type OrgSession } from "./helpers";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";
import { and, eq, sql } from "drizzle-orm";

const storage = new InMemoryArtifactStorage();
const sandboxFiles = new Map<string, Buffer>();
const resolvedPaths = new Map<string, string>();
let downloadCount = 0;
let pdfBytes: Buffer;
let owner: OrgSession;
let outsider: OrgSession;

function installDownloader(): void {
  setSandboxDownloaderForTest(async (_sandboxId, path) => {
    downloadCount += 1;
    const bytes = sandboxFiles.get(path);
    if (!bytes) throw new Error("missing sandbox file");
    return { bytes, size: bytes.byteLength };
  });
}

beforeAll(async () => {
  owner = await createOrgSession("artifact-completion-owner");
  outsider = await createOrgSession("artifact-completion-outsider");
  pdfBytes = Buffer.from((await renderArtifactExport({ pdfText: "Artifact completion" }, "pdf")).bytes);
  setArtifactStorageForTest(storage);
  setOfficePreviewConverterForTest(async () => null);
  setSandboxPathResolverForTest(async (_sandboxId, path) => resolvedPaths.get(path) ?? path);
  stopSlackOutboxRelay();
});

beforeEach(async () => {
  // One processDue pass claims the twenty oldest due rows in the shared table,
  // and other suites leave undrained rows behind; start every case from an
  // empty outbox so their leftovers cannot starve this run's own delivery.
  await db.execute(sql`delete from slack_outbox`);
  sandboxFiles.clear();
  resolvedPaths.clear();
  downloadCount = 0;
  setArtifactStorageForTest(storage);
  installDownloader();
});

afterAll(() => {
  setSandboxDownloaderForTest(null);
  setSandboxPathResolverForTest(null);
  setOfficePreviewConverterForTest(null);
  setArtifactStorageForTest(null);
  startSlackOutbox();
});

async function createSandboxRun(
  session: OrgSession,
  provider: SandboxProviderKind = "cube",
): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "Create and share the requested file",
    model: "test",
    engine: "codex",
    orgId: session.orgId,
    userId: session.email,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  await setRunSandbox(runId, `sandbox-${runId}`, { kind: provider, credential: "env" });
  return runId;
}

async function createContinuationRun(session: OrgSession, threadId: string): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "Update the requested file",
    model: "test",
    engine: "codex",
    orgId: session.orgId,
    userId: session.email,
    parentRunId: threadId,
    threadId,
    repos: [],
    memoryScope: "org",
  });
  await setRunSandbox(runId, `sandbox-${threadId}`, { kind: "cube", credential: "env" });
  return runId;
}

async function listArtifacts(session: OrgSession, threadId: string) {
  return json<{ artifacts: Array<{
    id: string;
    run_id: string;
    thread_id: string;
    name: string;
    sha256: string;
    download_url: string;
  }> }>(`/api/artifacts?thread_id=${threadId}`, { cookies: session.cookies });
}

function recordingSlack(uploads: Array<{ filename: string; bytes: Uint8Array }>): SlackClient {
  return {
    postMessage: async () => ({ ok: true, ts: "message.1" }),
    updateMessage: async () => ({ ok: true }),
    addReaction: async () => ({ ok: true }),
    setSessionStatus: async () => ({ ok: true }),
    setThreadStatus: async () => ({ ok: true }),
    startStream: async () => ({ ok: true, ts: "stream.1" }),
    appendStream: async () => ({ ok: true }),
    stopStream: async () => ({ ok: true }),
    uploadFile: async ({ filename, bytes }) => {
      uploads.push({ filename, bytes });
      return { ok: true };
    },
  };
}

async function within<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not settle before publication resumed")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("artifact completion", () => {
  test("cannot complete a local-file claim without an attached sandbox", async () => {
    const runId = await createSandboxRun(owner);
    await db.update(runs).set({ sandboxId: null }).where(eq(runs.id, runId));
    const finalized = await finalizeRun(runId, "completed", "[Report](/root/work/report.pdf)", 1);
    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test("publishes an explicitly linked local PDF before completing the run", async () => {
    const path = "/home/user/work/Quarterly Report (final).pdf";
    const runId = await createSandboxRun(owner, "box");
    sandboxFiles.set(path, pdfBytes);

    const finalized = await finalizeRun(
      runId,
      "completed",
      `Completed the report: [Download PDF](<${path}>)`,
      100,
    );

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    if (!finalized.applied) throw new Error("run was not finalized");
    expect(finalized.summary).not.toContain(path);

    const listed = await listArtifacts(owner, runId);
    expect(listed.status).toBe(200);
    expect(listed.body.artifacts).toHaveLength(1);
    const artifact = listed.body.artifacts[0]!;
    expect(finalized.summary).toContain(artifact.download_url);
    expect(artifact).toMatchObject({
      run_id: runId,
      thread_id: runId,
      sha256: createHash("sha256").update(pdfBytes).digest("hex"),
    });
    const [obligation] = await db.select().from(finishedWorkObligations)
      .where(eq(finishedWorkObligations.runId, runId));
    const [receipt] = await db.select().from(finishedWorkReceipts)
      .where(eq(finishedWorkReceipts.runId, runId));
    expect(obligation).toMatchObject({
      state: "satisfied",
      materializedArtifactId: artifact.id,
      materializedArtifactRevision: 0,
    });
    expect(receipt).toMatchObject({
      obligationId: obligation?.id,
      artifactId: artifact.id,
      artifactRevision: 0,
      metadata: {
        digest: artifact.sha256,
        mime: "application/pdf",
        byteCount: pdfBytes.byteLength,
      },
    });

    const content = await fetchApi(`/api/artifacts/${artifact.id}/content`, {
      cookies: owner.cookies,
    });
    expect(content.status).toBe(200);
    expect(Buffer.from(await content.arrayBuffer())).toEqual(pdfBytes);

    const denied = await fetchApi(`/api/artifacts/${artifact.id}/content`, {
      cookies: outsider.cookies,
    });
    expect(denied.status).toBe(404);
  });

  test("discovers a new sandbox output from the turn baseline before finalizing and delivering it", async () => {
    const runId = await createSandboxRun(owner);
    const path = "/root/work/discovered-report.pdf";
    sandboxFiles.set(path, pdfBytes);
    const sandbox = {
      id: `sandbox-${runId}`,
      process: {
        async executeCommand(command: string) {
          if (command === "date +%s.%N") return { exitCode: 0, result: "1757000000.100000000\n" };
          if (command.includes("-name .git")) return { exitCode: 0, result: "__USEAGENT_LISTING_COMPLETE__\0" };
          return {
            exitCode: 0,
            result: `${pdfBytes.byteLength}\t${path}\0__USEAGENT_LISTING_COMPLETE__\0`,
          };
        },
      },
    } as SandboxHandle;
    await recordOutputBaseline(runId, sandbox, "/root/work");
    const channel = `C${runId.slice(0, 8)}`;
    const threadTs = `${runId.slice(0, 8)}.1`;
    await linkSlackThread({ teamId: "T0TESTTEAM", channel, threadTs, rootRunId: runId, orgId: owner.orgId });
    await createSlackRunResponse({ runId, teamId: "T0TESTTEAM", channel, threadTs });
    const resolver = spyOn(sandboxBindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    let finalized;
    try {
      finalized = await finalizeRun(runId, "completed", "Done", 100);
    } finally {
      resolver.mockRestore();
    }

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    const listed = await listArtifacts(owner, runId);
    expect(listed.body.artifacts).toHaveLength(1);
    const artifact = listed.body.artifacts[0]!;
    if (!finalized?.applied) throw new Error("run was not finalized");
    expect(finalized.summary).toContain(artifact.id);
    const content = await fetchApi(`/api/artifacts/${artifact.id}/content`, { cookies: owner.cookies });
    expect(Buffer.from(await content.arrayBuffer())).toEqual(pdfBytes);

    const uploads: Array<{ filename: string; bytes: Uint8Array }> = [];
    await processDue(recordingSlack(uploads));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.filename).toBe("discovered-report.pdf");
    expect(Buffer.from(uploads[0]!.bytes)).toEqual(pdfBytes);
  });

  test("a turn that changed a whole project tree completes and says what it left out", async () => {
    // Prod 2026-10-11: 500+ changed project files failed the finished run with
    // "Artifact delivery failed"; now the top-level output is delivered instead.
    const runId = await createSandboxRun(owner);
    const path = "/root/work/final-report.pdf";
    sandboxFiles.set(path, pdfBytes);
    const tree = Array.from({ length: 30 }, (_, index) => `10\t/root/work/app/icons/icon-${index}.png\0`).join("");
    const sandbox = {
      id: `sandbox-${runId}`,
      process: {
        async executeCommand(command: string) {
          if (command === "date +%s.%N") return { exitCode: 0, result: "1757000000.100000000\n" };
          if (command.includes("-name .git")) return { exitCode: 0, result: "__USEAGENT_LISTING_COMPLETE__\0" };
          const top = `${pdfBytes.byteLength}\t${path}\0`;
          return { exitCode: 0, result: `${command.includes("-maxdepth 1") ? top : tree + top}__USEAGENT_LISTING_COMPLETE__\0` };
        },
      },
    } as SandboxHandle;
    await recordOutputBaseline(runId, sandbox, "/root/work");
    const resolver = spyOn(sandboxBindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    let finalized;
    try {
      finalized = await finalizeRun(runId, "completed", "Built the app.", 100);
    } finally {
      resolver.mockRestore();
    }

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    if (!finalized?.applied) throw new Error("run was not finalized");
    expect(finalized.summary).toContain("final-report.pdf");
    expect(finalized.summary).toContain("not delivered automatically");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(1);
  });

  test("a sandbox listing that drops once is retried and the output still delivers", async () => {
    // Prod 2026-10-12: one E2B SandboxError on the listing failed a finished
    // run with "Artifact delivery failed"; the user's resend worked.
    const runId = await createSandboxRun(owner);
    const path = "/root/work/price-notes.pdf";
    sandboxFiles.set(path, pdfBytes);
    let dropped = 0;
    const sandbox = {
      id: `sandbox-${runId}`,
      process: {
        async executeCommand(command: string) {
          if (command === "date +%s.%N") return { exitCode: 0, result: "1757000000.100000000\n" };
          if (command.includes("-name .git")) return { exitCode: 0, result: "__USEAGENT_LISTING_COMPLETE__\0" };
          if (dropped++ === 0) throw Object.assign(new Error("2: connection reset"), { name: "SandboxError" });
          return { exitCode: 0, result: `${pdfBytes.byteLength}\t${path}\0__USEAGENT_LISTING_COMPLETE__\0` };
        },
      },
    } as SandboxHandle;
    await recordOutputBaseline(runId, sandbox, "/root/work");
    const resolver = spyOn(sandboxBindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    let finalized;
    try {
      finalized = await finalizeRun(runId, "completed", "Found both prices.", 100);
    } finally {
      resolver.mockRestore();
    }

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    if (!finalized?.applied) throw new Error("run was not finalized");
    expect(dropped).toBe(2);
    expect(finalized.summary).toContain("price-notes.pdf");
    expect(finalized.summary).not.toContain("could not be collected");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(1);
  });

  test("a sandbox that still answers but will not list the turn's files completes the run with a note and keeps linked files", async () => {
    const runId = await createSandboxRun(owner);
    const linked = "/root/work/linked-report.pdf";
    sandboxFiles.set(linked, pdfBytes);
    let listings = 0;
    const sandbox = {
      id: `sandbox-${runId}`,
      process: {
        async executeCommand(command: string) {
          if (command === "date +%s.%N") return { exitCode: 0, result: "1757000000.100000000\n" };
          if (command === "true") return { exitCode: 0, result: "" };
          listings += 1;
          throw Object.assign(new Error("13: stream closed"), { name: "SandboxError" });
        },
      },
    } as SandboxHandle;
    await recordOutputBaseline(runId, sandbox, "/root/work");
    const warn = spyOn(console, "warn");
    const resolver = spyOn(sandboxBindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    let finalized;
    let warnings: unknown[][] = [];
    try {
      finalized = await finalizeRun(runId, "completed", `Here it is: [Report](<${linked}>)`, 100);
    } finally {
      warnings = [...warn.mock.calls];
      resolver.mockRestore();
      warn.mockRestore();
    }

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    if (!finalized?.applied) throw new Error("run was not finalized");
    expect(listings).toBe(3);
    expect(finalized.summary).toContain("could not be collected automatically");
    expect(finalized.summary).not.toContain(linked);
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(1);
    expect(warnings.some((call) => String(call[0]).includes("output discovery failed") && call[1] === "SandboxError rpc 13"))
      .toBe(true);
  });

  test("a sandbox that no longer answers at all still fails delivery", async () => {
    const runId = await createSandboxRun(owner);
    const sandbox = {
      id: `sandbox-${runId}`,
      process: {
        async executeCommand(command: string) {
          if (command === "date +%s.%N") return { exitCode: 0, result: "1757000000.100000000\n" };
          throw Object.assign(new Error("14: sandbox gone"), { name: "SandboxError" });
        },
      },
    } as SandboxHandle;
    await recordOutputBaseline(runId, sandbox, "/root/work");
    const resolver = spyOn(sandboxBindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    let finalized;
    try {
      finalized = await finalizeRun(runId, "completed", "Found both prices.", 100);
    } finally {
      resolver.mockRestore();
    }

    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    if (!finalized?.applied) throw new Error("run was not finalized");
    expect(finalized.summary).toContain("Artifact delivery failed");
  });

  test("a listing the sandbox answers with an error exit still fails delivery", async () => {
    // Review round 2: the workspace vanished while the sandbox lived; find
    // exited 1 every time and `true` still ran, which must not complete.
    const runId = await createSandboxRun(owner);
    let listings = 0;
    const sandbox = {
      id: `sandbox-${runId}`,
      process: {
        async executeCommand(command: string) {
          if (command === "date +%s.%N") return { exitCode: 0, result: "1757000000.100000000\n" };
          if (command === "true") return { exitCode: 0, result: "" };
          listings += 1;
          return { exitCode: 1, result: "find: '/root/work': No such file or directory" };
        },
      },
    } as SandboxHandle;
    await recordOutputBaseline(runId, sandbox, "/root/work");
    const resolver = spyOn(sandboxBindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    let finalized;
    try {
      finalized = await finalizeRun(runId, "completed", "Done.", 100);
    } finally {
      resolver.mockRestore();
    }

    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    expect(listings).toBe(1);
  });

  test("a listing that comes back wrong still fails delivery", async () => {
    const runId = await createSandboxRun(owner);
    const sandbox = {
      id: `sandbox-${runId}`,
      process: {
        async executeCommand(command: string) {
          if (command === "date +%s.%N") return { exitCode: 0, result: "1757000000.100000000\n" };
          if (command === "true") return { exitCode: 0, result: "" };
          if (command.includes("-name .git")) return { exitCode: 0, result: "__USEAGENT_LISTING_COMPLETE__\0" };
          return { exitCode: 0, result: "10\t/etc/passwd\0__USEAGENT_LISTING_COMPLETE__\0" };
        },
      },
    } as SandboxHandle;
    await recordOutputBaseline(runId, sandbox, "/root/work");
    const resolver = spyOn(sandboxBindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    let finalized;
    try {
      finalized = await finalizeRun(runId, "completed", "Done.", 100);
    } finally {
      resolver.mockRestore();
    }

    expect(finalized).toMatchObject({ applied: true, status: "failed" });
  });

  test("a run rebound to another sandbox after its baseline still fails delivery", async () => {
    const runId = await createSandboxRun(owner);
    const original = {
      id: `sandbox-${runId}`,
      process: { async executeCommand() { return { exitCode: 0, result: "1757000000.100000000\n" }; } },
    } as SandboxHandle;
    await recordOutputBaseline(runId, original, "/root/work");
    await setRunSandbox(runId, `replacement-${runId}`, { kind: "cube", credential: "env" });

    const finalized = await finalizeRun(runId, "completed", "Done.", 100);
    expect(finalized).toMatchObject({ applied: true, status: "failed" });
  });

  test("an empty file the summary links is not reported as left out", async () => {
    const runId = await createSandboxRun(owner);
    const path = "/root/work/notes.txt";
    sandboxFiles.set(path, Buffer.from("written later"));
    const sandbox = {
      id: `sandbox-${runId}`,
      process: {
        async executeCommand(command: string) {
          if (command === "date +%s.%N") return { exitCode: 0, result: "1757000000.100000000\n" };
          if (command.includes("-name .git")) return { exitCode: 0, result: "__USEAGENT_LISTING_COMPLETE__\0" };
          return { exitCode: 0, result: `0\t${path}\0__USEAGENT_LISTING_COMPLETE__\0` };
        },
      },
    } as SandboxHandle;
    await recordOutputBaseline(runId, sandbox, "/root/work");
    const resolver = spyOn(sandboxBindings, "resolveRunSandbox").mockResolvedValue(sandbox as never);
    let finalized;
    try {
      finalized = await finalizeRun(runId, "completed", `Notes: [notes.txt](${path})`, 100);
    } finally {
      resolver.mockRestore();
    }
    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    if (!finalized?.applied) throw new Error("run was not finalized");
    expect(finalized.summary).not.toContain("not delivered automatically");
  });

  const formats = [
    { name: "PDF", provider: "box", path: "/home/user/work/output.pdf", target: "</home/user/work/output.pdf>", image: false },
    { name: "DOCX", provider: "cube", path: "/root/work/output.docx", target: "/root/work/output.docx", image: false },
    { name: "XLSX", provider: "daytona", path: "/root/work/output.xlsx", target: "file:///root/work/output.xlsx", image: false },
    { name: "PPTX", provider: "box", path: "/home/user/work/output.pptx", target: "sandbox:/home/user/work/output.pptx", image: false },
    { name: "CSV", provider: "cube", path: "/root/work/output.csv", target: "</root/work/output.csv>", image: false },
    { name: "PNG", provider: "daytona", path: "/root/work/output.png", target: "file:///root/work/output.png", image: true },
    { name: "WebM", provider: "box", path: "/home/user/work/output.webm", target: "/home/user/work/output.webm", image: false },
    { name: "ZIP", provider: "cube", path: "/root/work/output.zip", target: "sandbox:/root/work/output.zip", image: false },
    { name: "extensionless", provider: "local", path: "/home/user/work/output", target: "/home/user/work/output", image: false },
  ] as const;

  test.each(formats)("publishes an explicitly linked $name file without changing its bytes", async ({ provider, path, target, image }) => {
    const rendered = path.endsWith(".pdf")
      ? pdfBytes
      : path.endsWith(".docx")
        ? Buffer.from((await renderArtifactExport({ text: "Document" }, "docx")).bytes)
        : path.endsWith(".xlsx")
          ? Buffer.from((await renderArtifactExport({ workbook: csvToWorkbook("name,value\nrun,42") }, "xlsx")).bytes)
          : path.endsWith(".pptx")
            ? Buffer.from((await renderArtifactExport({ deck: migrateSlidesToDeck([{ title: "Deck", body: "Ready" }]) }, "pptx")).bytes)
            : path.endsWith(".csv")
              ? Buffer.from("name,value\nrun,42\n")
              : path.endsWith(".png")
                ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
                : path.endsWith(".webm")
                  ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80])
                  : path.endsWith(".zip")
                    ? Buffer.from(await new JSZip().file("proof.txt", "ready\n").generateAsync({ type: "uint8array" }))
                    : Buffer.from("extensionless deliverable\n");
    const runId = await createSandboxRun(owner, provider);
    sandboxFiles.set(path, rendered);

    const finalized = await finalizeRun(runId, "completed", `Ready: ${image ? "!" : ""}[Output](${target})`, 100);

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    const listed = await listArtifacts(owner, runId);
    expect(listed.body.artifacts).toHaveLength(1);
    const artifact = listed.body.artifacts[0]!;
    const content = await fetchApi(`/api/artifacts/${artifact.id}/content`, { cookies: owner.cookies });
    expect(Buffer.from(await content.arrayBuffer())).toEqual(rendered);
  });

  test.each(["png", "zip", "webm"] as const)(
    "revises one stable artifact when a later turn changes raw %s bytes",
    async (extension) => {
      const initial = extension === "png"
        ? Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
        : extension === "zip"
          ? Buffer.from(await new JSZip().file("version.txt", "one").generateAsync({ type: "uint8array" }))
          : Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x01]);
      const changed = extension === "zip"
        ? Buffer.from(await new JSZip().file("version.txt", "two").generateAsync({ type: "uint8array" }))
        : Buffer.concat([initial, Buffer.from([0x02])]);
      const threadId = await createSandboxRun(owner);
      const path = `/root/work/revision.${extension}`;
      sandboxFiles.set(path, initial);
      await finalizeRun(threadId, "completed", `Ready: [Output](${path})`, 100);
      const [first] = await db.select().from(artifacts).where(and(
        eq(artifacts.threadId, threadId),
        eq(artifacts.sourcePath, path),
      ));
      if (!first) throw new Error("initial artifact was not published");
      const continuation = await createContinuationRun(owner, threadId);
      sandboxFiles.set(path, changed);

      const finalized = await finalizeRun(continuation, "completed", `Updated: [Output](${path})`, 100);

      expect(finalized).toMatchObject({ applied: true, status: "completed" });
      const [revised] = await db.select().from(artifacts).where(eq(artifacts.id, first.id));
      expect(revised).toMatchObject({
        id: first.id,
        workpieceRevision: first.workpieceRevision + 1,
        sha256: createHash("sha256").update(changed).digest("hex"),
      });
      expect(await db.select().from(artifacts).where(and(
        eq(artifacts.threadId, threadId),
        eq(artifacts.sourcePath, path),
      ))).toHaveLength(1);
      const content = await fetchApi(`/api/artifacts/${first.id}/content`, { cookies: owner.cookies });
      expect(Buffer.from(await content.arrayBuffer())).toEqual(changed);
    },
  );

  test("reuses artifact identity and revision when a later turn republishes unchanged bytes", async () => {
    const threadId = await createSandboxRun(owner);
    const path = "/root/work/unchanged.zip";
    const bytes = Buffer.from(await new JSZip().file("stable.txt", "same").generateAsync({ type: "uint8array" }));
    sandboxFiles.set(path, bytes);
    await finalizeRun(threadId, "completed", `Ready: [Output](${path})`, 100);
    const [first] = await db.select().from(artifacts).where(and(
      eq(artifacts.threadId, threadId),
      eq(artifacts.sourcePath, path),
    ));
    if (!first) throw new Error("initial artifact was not published");
    const continuation = await createContinuationRun(owner, threadId);

    const finalized = await finalizeRun(continuation, "completed", `Still ready: [Output](${path})`, 100);

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    const [unchanged] = await db.select().from(artifacts).where(eq(artifacts.id, first.id));
    expect(unchanged).toMatchObject({
      id: first.id,
      workpieceRevision: first.workpieceRevision,
      sha256: first.sha256,
    });
    expect(await db.select().from(artifacts).where(and(
      eq(artifacts.threadId, threadId),
      eq(artifacts.sourcePath, path),
    ))).toHaveLength(1);
  });

  test("does not complete when an explicitly linked local file is missing", async () => {
    const runId = await createSandboxRun(owner);

    const finalized = await finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/missing.pdf)",
      100,
    );

    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test("deduplicates publication when completion races for the same run", async () => {
    const runId = await createSandboxRun(owner);
    const path = "/root/work/race.pdf";
    sandboxFiles.set(path, pdfBytes);
    const summary = `Ready: [Download](${path})`;

    const results = await Promise.all([
      finalizeRun(runId, "completed", summary, 100),
      finalizeRun(runId, "completed", summary, 100),
    ]);

    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(1);
  });

  test("advances one revision when identical changed-byte finalizers race", async () => {
    const threadId = await createSandboxRun(owner);
    const path = "/root/work/concurrent-revision.webm";
    const initialBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x01]);
    const changedBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x02]);
    sandboxFiles.set(path, initialBytes);
    await finalizeRun(threadId, "completed", `Ready: [Video](${path})`, 100);
    const [prior] = await db.select().from(artifacts).where(and(
      eq(artifacts.threadId, threadId),
      eq(artifacts.sourcePath, path),
    ));
    if (!prior) throw new Error("prior artifact was not published");
    const continuation = await createContinuationRun(owner, threadId);
    sandboxFiles.set(path, changedBytes);

    const original = artifactRepo.getArtifactForOrg;
    let targetReads = 0;
    let releaseReaders!: () => void;
    const readersReady = new Promise<void>((resolve) => { releaseReaders = resolve; });
    const targetRead = spyOn(artifactRepo, "getArtifactForOrg").mockImplementation(
      async (...args: Parameters<typeof original>) => {
        const record = await original(...args);
        if (args[1] === prior.id && targetReads < 2) {
          targetReads += 1;
          if (targetReads === 2) releaseReaders();
          await readersReady;
        }
        return record;
      },
    );
    let results: Awaited<ReturnType<typeof finalizeRun>>[];
    try {
      results = await Promise.all([
        finalizeRun(continuation, "completed", `Updated: [Video](${path})`, 100),
        finalizeRun(continuation, "completed", `Updated: [Video](${path})`, 100),
      ]);
    } finally {
      targetRead.mockRestore();
    }

    expect(targetReads).toBe(2);
    expect(results.filter((result) => result.applied)).toHaveLength(1);
    expect((await getRun(continuation))?.status).toBe("completed");
    const rows = await db.select().from(artifacts).where(and(
      eq(artifacts.threadId, threadId),
      eq(artifacts.sourcePath, path),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: prior.id,
      workpieceRevision: prior.workpieceRevision + 1,
      sha256: createHash("sha256").update(changedBytes).digest("hex"),
    });
    const content = await fetchApi(`/api/artifacts/${prior.id}/content`, { cookies: owner.cookies });
    expect(Buffer.from(await content.arrayBuffer())).toEqual(changedBytes);
  });

  test("does not read or publish linked files after a finalization claim is lost", async () => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set("/root/work/unclaimed.pdf", pdfBytes);

    const finalized = await finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/unclaimed.pdf)",
      100,
      { claim: async () => false },
    );

    expect(finalized).toEqual({ applied: false });
    expect(downloadCount).toBe(0);
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test("a recovery owner publishes through both publication and terminal claim fences", async () => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set("/root/work/recovered.pdf", pdfBytes);
    let publicationChecks = 0;
    let terminalClaims = 0;

    const finalized = await finalizeRun(
      runId,
      "completed",
      "Recovered: [Download](/root/work/recovered.pdf)",
      100,
      {
        publicationClaim: async () => {
          publicationChecks += 1;
          return true;
        },
        claim: async () => {
          terminalClaims += 1;
          return true;
        },
      },
    );

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    expect(publicationChecks).toBeGreaterThanOrEqual(2);
    expect(terminalClaims).toBe(1);
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(1);
  });

  test("a recovery owner that loses its publication claim during download publishes nothing", async () => {
    const runId = await createSandboxRun(owner);
    await setRunStatus(runId, "running");
    let claimHeld = true;
    let terminalClaims = 0;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    setSandboxDownloaderForTest(async () => {
      markStarted();
      await released;
      return { bytes: pdfBytes, size: pdfBytes.byteLength };
    });
    const finalizing = finalizeRun(
      runId,
      "completed",
      "Recovered: [Download](/root/work/lost-claim.pdf)",
      100,
      {
        publicationClaim: async () => claimHeld,
        claim: async () => {
          terminalClaims += 1;
          return true;
        },
      },
    );
    await started;

    claimHeld = false;
    release();
    const finalized = await finalizing;

    expect(finalized).toEqual({ applied: false });
    expect(terminalClaims).toBe(0);
    expect((await getRun(runId))?.status).toBe("running");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test.each([
    { scenario: "initial publication", revised: false },
    { scenario: "changed-byte revision", revised: true },
  ])("reuses a satisfied $scenario after publication commits but terminal claim is lost", async ({ revised }) => {
    const path = "/root/work/restart-replay.webm";
    const initialBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x01]);
    const publishedBytes = revised
      ? Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x02])
      : initialBytes;
    const threadId = await createSandboxRun(owner);
    let runId = threadId;
    let priorId: string | null = null;
    if (revised) {
      sandboxFiles.set(path, initialBytes);
      await finalizeRun(threadId, "completed", `Ready: [Video](${path})`, 100);
      const [prior] = await db.select().from(artifacts).where(and(
        eq(artifacts.threadId, threadId),
        eq(artifacts.sourcePath, path),
      ));
      if (!prior) throw new Error("prior artifact was not published");
      priorId = prior.id;
      runId = await createContinuationRun(owner, threadId);
    }
    sandboxFiles.set(path, publishedBytes);

    const interrupted = await finalizeRun(
      runId,
      "completed",
      `Ready: [Video](${path})`,
      100,
      { publicationClaim: async () => true, claim: async () => false },
    );

    expect(interrupted).toEqual({ applied: false });
    expect((await getRun(runId))?.status).toBe("queued");
    const [published] = await db.select().from(artifacts).where(and(
      eq(artifacts.threadId, threadId),
      eq(artifacts.sourcePath, path),
    ));
    if (!published) throw new Error("interrupted publication did not persist its artifact");
    expect(published).toMatchObject({
      ...(priorId ? { id: priorId } : {}),
      workpieceRevision: revised ? 1 : 0,
      sha256: createHash("sha256").update(publishedBytes).digest("hex"),
    });
    const receiptsBefore = await db.select().from(finishedWorkReceipts)
      .where(eq(finishedWorkReceipts.runId, runId));
    expect(receiptsBefore).toHaveLength(1);

    const retried = await finalizeRun(runId, "completed", `Ready: [Video](${path})`, 100);

    expect(retried).toMatchObject({ applied: true, status: "completed" });
    const [afterRetry] = await db.select().from(artifacts).where(eq(artifacts.id, published.id));
    expect(afterRetry).toMatchObject({
      id: published.id,
      workpieceRevision: published.workpieceRevision,
      sha256: published.sha256,
    });
    const receiptsAfter = await db.select().from(finishedWorkReceipts)
      .where(eq(finishedWorkReceipts.runId, runId));
    expect(receiptsAfter).toHaveLength(1);
    expect(receiptsAfter[0]?.id).toBe(receiptsBefore[0]?.id);
  });

  test("a cancel accepted before publication prevents completed artifact delivery", async () => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set("/root/work/cancelled.pdf", pdfBytes);
    await acceptRunCancel({ orgId: owner.orgId, actorId: owner.email, runId });

    const finalized = await finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/cancelled.pdf)",
      100,
    );

    expect(finalized).toEqual({ applied: false });
    expect(downloadCount).toBe(0);
    expect((await getRun(runId))?.status).toBe("failed");
  });

  test("a cancel accepted while publication is downloading prevents completion", async () => {
    const runId = await createSandboxRun(owner);
    await setRunStatus(runId, "running");
    const controller = new AbortController();
    let publicationReleased = false;
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = () => {
        publicationReleased = true;
        resolve();
      };
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    setSandboxDownloaderForTest(async () => {
      markStarted();
      await released;
      return { bytes: pdfBytes, size: pdfBytes.byteLength };
    });
    const finalizing = finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/cancel-race.pdf)",
      100,
      { signal: controller.signal },
    );
    await started;

    const cancelling = acceptRunCancel({ orgId: owner.orgId, actorId: owner.email, runId });
    let cancelOutcome: Awaited<typeof cancelling> | null = null;
    let boundedError: unknown;
    try {
      cancelOutcome = await within(cancelling);
      expect(publicationReleased).toBe(false);
      controller.abort(new Error("cancel accepted"));
    } catch (error) {
      boundedError = error;
    } finally {
      release();
    }
    const [finalized] = await Promise.all([finalizing, cancelling]);
    if (boundedError) throw boundedError;

    expect(cancelOutcome).toMatchObject({ status: "accepted", runStatusWas: "running" });
    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    expect((await getRun(runId))?.status).toBe("failed");
  });

  test("does not complete when durable artifact storage rejects the bytes", async () => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set("/root/work/storage-failure.pdf", pdfBytes);
    const failingStorage: ArtifactStorage = {
      put: async () => { throw new Error("injected storage failure"); },
      read: (key, range) => storage.read(key, range),
      size: (key) => storage.size(key),
      sha256: (key) => storage.sha256(key),
    };
    setArtifactStorageForTest(failingStorage);

    const finalized = await finalizeRun(
      runId,
      "completed",
      "Ready: [Download](/root/work/storage-failure.pdf)",
      100,
    );

    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test("uploads every final linked file to Slack and records delivery only after accepted bytes", async () => {
    const runId = await createSandboxRun(owner);
    const channel = `C${runId.slice(0, 8)}`;
    const threadTs = `${runId.slice(0, 8)}.1`;
    await linkSlackThread({ teamId: "T0TESTTEAM", channel, threadTs, rootRunId: runId, orgId: owner.orgId });
    await createSlackRunResponse({ runId, teamId: "T0TESTTEAM", channel, threadTs });
    const expected = new Map<string, Buffer>();
    const links = Array.from({ length: 6 }, (_, index) => {
      const filename = `final-${runId.slice(0, 6)}-${index}.txt`;
      const path = `/root/work/${filename}`;
      const bytes = Buffer.from(`linked file ${index}\n`);
      sandboxFiles.set(path, bytes);
      expected.set(filename, bytes);
      return `[File ${index}](${path})`;
    });

    const finalized = await finalizeRun(runId, "completed", links.join("\n"), 100);

    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    const before = await db.select().from(providerEvents).where(and(
      eq(providerEvents.runId, runId),
      eq(providerEvents.eventType, "artifact.delivered"),
    ));
    expect(before).toHaveLength(0);

    const uploads: Array<{ filename: string; bytes: Uint8Array }> = [];
    await processDue(recordingSlack(uploads));

    expect(uploads).toHaveLength(6);
    for (const upload of uploads) expect(Buffer.from(upload.bytes)).toEqual(expected.get(upload.filename));
    const after = await db.select().from(providerEvents).where(and(
      eq(providerEvents.runId, runId),
      eq(providerEvents.eventType, "artifact.delivered"),
    ));
    expect(after).toHaveLength(6);
  });

  test("uploads a finalized presentation without separately uploading its derived pictures", async () => {
    const runId = await createSandboxRun(owner);
    const channel = `C${runId.slice(0, 8)}`;
    const threadTs = `${runId.slice(0, 8)}.1`;
    await linkSlackThread({ teamId: "T0TESTTEAM", channel, threadTs, rootRunId: runId, orgId: owner.orgId });
    await createSlackRunResponse({ runId, teamId: "T0TESTTEAM", channel, threadTs });
    const deckName = `presentation-${runId.slice(0, 8)}.pptx`;
    const deckPath = `/root/work/${deckName}`;
    const deck = migrateSlidesToDeck([{ title: "Results", body: "Ready" }]);
    const deckBytes = Buffer.from((await renderArtifactExport({ deck }, "pptx")).bytes);
    const deckDigest = createHash("sha256").update(deckBytes).digest("hex");
    await storage.put(deckDigest, deckBytes);
    const parent = await artifactRepo.createArtifactRecord({
      orgId: owner.orgId,
      userId: owner.email,
      runId,
      threadId: runId,
      sourcePath: deckPath,
      name: deckName,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      sizeBytes: deckBytes.byteLength,
      sha256: deckDigest,
      storageKey: deckDigest,
      workpieceKind: "presentation",
      workpieceState: null,
    });
    const imageSeed = Buffer.from(crypto.randomUUID());
    await materializePptxImages({
      deck,
      images: [
        { slideIndex: 0, role: "background", x: 0, y: 0, w: 100, h: 100, bytes: imageSeed, contentType: "image/png" },
        { slideIndex: 0, role: "block", x: 10, y: 10, w: 20, h: 20, bytes: Buffer.concat([imageSeed, Buffer.from("-2")]), contentType: "image/png" },
      ],
    }, {
      orgId: owner.orgId,
      userId: owner.email,
      run: { id: runId, threadId: runId },
      sourcePath: deckPath,
      deckName,
    });
    expect(await db.select().from(artifacts).where(eq(artifacts.runId, runId))).toHaveLength(3);

    const finalized = await finalizeRun(runId, "completed", "Done", 100);
    expect(finalized).toMatchObject({ applied: true, status: "completed" });
    const uploads: Array<{ filename: string; bytes: Uint8Array }> = [];
    await processDue(recordingSlack(uploads));

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.filename).toBe(deckName);
    expect(Buffer.from(uploads[0]!.bytes)).toEqual(deckBytes);
    const delivered = await db.select({ payload: providerEvents.payload }).from(providerEvents).where(and(
      eq(providerEvents.runId, runId),
      eq(providerEvents.eventType, "artifact.delivered"),
    ));
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]!.payload ?? "{}")).toMatchObject({ id: parent.row.id });
  });

  test("does not harvest remote links or local links shown in code samples", async () => {
    const runId = await createSandboxRun(owner);
    const summary = [
      "Reference: [remote PDF](https://example.com/report.pdf)",
      "```markdown",
      "[example](/root/work/example.pdf)",
      "```",
    ].join("\n");

    const finalized = await finalizeRun(runId, "completed", summary, 100);

    expect(finalized).toEqual({ applied: true, status: "completed", summary });
    expect(downloadCount).toBe(0);
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });

  test.each([
    { name: "secret path", path: "/root/work/.env" },
    { name: "path traversal", path: "/root/work/../private.txt" },
    { name: "private inspection screenshot", path: "/root/work/screenshots/screenshot-1786558088313.png" },
    { name: "renamed private inspection screenshot", path: "/root/work/screenshots/customer.png" },
    { name: "nested private inspection screenshot", path: "/root/work/screenshots/nested/customer.png" },
    { name: "workspace symlink", path: "/root/work/symlink.pdf", resolved: "/etc/passwd" },
  ])("does not complete a download claim for a $name", async ({ path, resolved }) => {
    const runId = await createSandboxRun(owner);
    sandboxFiles.set(path, pdfBytes);
    if (resolved) resolvedPaths.set(path, resolved);

    const finalized = await finalizeRun(runId, "completed", `Ready: [Download](${path})`, 100);

    expect(finalized).toMatchObject({ applied: true, status: "failed" });
    expect((await getRun(runId))?.status).toBe("failed");
    expect((await listArtifacts(owner, runId)).body.artifacts).toHaveLength(0);
  });
});
