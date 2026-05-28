import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ArtifactWorkpieceProposalDescriptor } from "@skynet/artifact-workspace";
import type { ArtifactDescriptor } from "../src/artifacts/repo";
import { setArtifactStorageForTest } from "../src/artifacts/storage";
import { executeArtifactTool } from "../src/knowledge/gateway/artifact-tools";
import type { ToolResult } from "../src/knowledge/gateway/artifact-tools";
import { createRun, setRunSandbox } from "../src/runs/repo";
import { setSandboxDownloaderForTest } from "../src/slack/sandbox-file";
import { createOrgSession, fetchApi, json, type OrgSession } from "./helpers";
import { InMemoryArtifactStorage } from "./in-memory-artifact-storage";

const DOC_BYTES = new TextEncoder().encode("original body\nline two\n");
const storage = new InMemoryArtifactStorage();
let owner: OrgSession;
let outsider: OrgSession;

async function createSandboxRun(session: OrgSession): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "author a report",
    model: "test",
    engine: "mock",
    orgId: session.orgId,
    userId: null,
    parentRunId: null,
    threadId: runId,
  });
  await setRunSandbox(runId, `sandbox-${runId}`);
  return runId;
}

function claimsFor(session: OrgSession, runId: string) {
  return {
    orgId: session.orgId,
    userId: session.email,
    threadId: runId,
    runId,
    scope: "run" as const,
    exp: Date.now() + 60_000,
  };
}

async function publishDoc(
  session: OrgSession,
  runId: string,
  path: string,
): Promise<ArtifactDescriptor> {
  const result = await executeArtifactTool(claimsFor(session, runId), "artifact_publish", { path });
  if (result.isError) throw new Error(result.content.map((item) => item.text).join("\n"));
  const artifact = result.structuredContent?.artifact as ArtifactDescriptor | undefined;
  if (!artifact) throw new Error("publish returned no descriptor");
  return artifact;
}

function propose(
  session: OrgSession,
  runId: string,
  artifactId: string,
  state: unknown,
  summary?: string,
): Promise<ToolResult> {
  return executeArtifactTool(claimsFor(session, runId), "workpiece_propose_edit", {
    artifact_id: artifactId,
    state,
    ...(summary ? { summary } : {}),
  });
}

function updateDirectly(
  session: OrgSession,
  runId: string,
  artifactId: string,
  state: unknown,
  summary?: string,
): Promise<ToolResult> {
  return executeArtifactTool(claimsFor(session, runId), "workpiece_update", {
    artifact_id: artifactId,
    state,
    ...(summary ? { summary } : {}),
  });
}

function proposalIdOf(result: ToolResult): string {
  expect(result.isError).toBeFalsy();
  const id = result.structuredContent?.proposal_id;
  if (typeof id !== "string") throw new Error("propose returned no proposal_id");
  return id;
}

beforeAll(async () => {
  owner = await createOrgSession("proposal-owner");
  outsider = await createOrgSession("proposal-outsider");
  setArtifactStorageForTest(storage);
  setSandboxDownloaderForTest(async (_sandboxId, _path, maxBytes) => {
    if (DOC_BYTES.byteLength > maxBytes) throw new Error("test fixture exceeds cap");
    return { bytes: Buffer.from(DOC_BYTES), size: DOC_BYTES.byteLength };
  });
});

afterAll(() => {
  setSandboxDownloaderForTest(null);
  setArtifactStorageForTest(null);
});

describe("agent-proposed workpiece revisions", () => {
  test("a user-requested direct edit advances mainline without a pending approval", async () => {
    const runId = await createSandboxRun(owner);
    const artifact = await publishDoc(owner, runId, "/root/work/direct.md");
    const workpiecePath = `/api/artifacts/${artifact.id}/workpiece`;

    const applied = await updateDirectly(
      owner,
      runId,
      artifact.id,
      { text: "direct revision\n" },
      "Apply the requested rewrite",
    );

    expect(applied.isError).toBeFalsy();
    expect(applied.structuredContent).toMatchObject({
      artifact_id: artifact.id,
      status: "applied",
      state_revision: 1,
    });
    const mainline = await json<{
      workpiece: { state_revision: number };
      state: { text: string };
    }>(workpiecePath, { cookies: owner.cookies });
    expect(mainline.body.workpiece.state_revision).toBe(1);
    expect(mainline.body.state).toEqual({ text: "direct revision\n" });

    const pending = await json<{ proposals: ArtifactWorkpieceProposalDescriptor[] }>(
      `/api/artifacts/${artifact.id}/proposals`,
      { cookies: owner.cookies },
    );
    expect(pending.body.proposals).toHaveLength(0);
  });

  test("propose leaves mainline untouched, then accept folds it in with provenance", async () => {
    const runId = await createSandboxRun(owner);
    const artifact = await publishDoc(owner, runId, "/root/work/notes.md");
    const workpiecePath = `/api/artifacts/${artifact.id}/workpiece`;

    const before = await json<{ workpiece: { state_revision: number }; state: { text: string } }>(
      workpiecePath,
      { cookies: owner.cookies },
    );
    expect(before.body.workpiece.state_revision).toBe(0);
    expect(before.body.state).toEqual({ text: "original body\nline two\n" });

    const proposed = await propose(
      owner,
      runId,
      artifact.id,
      { text: "revised body\nline two\n" },
      "Tighten the intro",
    );
    const text = proposed.content[0]?.text ?? "";
    expect(text).toContain("Proposed changes");
    expect(text).toContain("review");
    expect(text).toContain("accept or dismiss");
    expect(proposed.structuredContent?.status).toBe("pending");
    const proposalId = proposalIdOf(proposed);

    // Mainline still shows the original: an unaccepted proposal is never truth.
    const afterPropose = await json<{
      workpiece: { state_revision: number };
      state: { text: string };
    }>(workpiecePath, { cookies: owner.cookies });
    expect(afterPropose.body.workpiece.state_revision).toBe(0);
    expect(afterPropose.body.state).toEqual({ text: "original body\nline two\n" });

    const listed = await json<{ proposals: ArtifactWorkpieceProposalDescriptor[] }>(
      `/api/artifacts/${artifact.id}/proposals`,
      { cookies: owner.cookies },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.proposals).toHaveLength(1);
    expect(listed.body.proposals[0]).toMatchObject({
      id: proposalId,
      artifact_id: artifact.id,
      proposer_run_id: runId,
      kind: "document",
      base_revision: 0,
      summary: "Tighten the intro",
      status: "pending",
      resolved_at: null,
      resolved_by: null,
      resolved_revision: null,
      state: { text: "revised body\nline two\n" },
    });

    const accept = await json<{
      workpiece: { state_revision: number };
      state: { text: string };
      proposal: ArtifactWorkpieceProposalDescriptor;
    }>(`/api/artifacts/${artifact.id}/proposals/${proposalId}/accept`, {
      method: "POST",
      cookies: owner.cookies,
    });
    expect(accept.status).toBe(200);
    expect(accept.body.workpiece.state_revision).toBe(1);
    expect(accept.body.state).toEqual({ text: "revised body\nline two\n" });
    expect(accept.body.proposal).toMatchObject({ status: "accepted", resolved_revision: 1 });
    // Provenance: the accepting user is recorded (their auth id, not necessarily email).
    expect(accept.body.proposal.resolved_by).toBeTruthy();
    expect(typeof accept.body.proposal.resolved_by).toBe("string");

    // Mainline has advanced; the pending lane is empty; history keeps the accept.
    const afterAccept = await json<{
      workpiece: { state_revision: number };
      state: { text: string };
    }>(workpiecePath, { cookies: owner.cookies });
    expect(afterAccept.body.workpiece.state_revision).toBe(1);
    expect(afterAccept.body.state).toEqual({ text: "revised body\nline two\n" });

    const pendingAfter = await json<{ proposals: ArtifactWorkpieceProposalDescriptor[] }>(
      `/api/artifacts/${artifact.id}/proposals`,
      { cookies: owner.cookies },
    );
    expect(pendingAfter.body.proposals).toHaveLength(0);

    const history = await json<{ proposals: ArtifactWorkpieceProposalDescriptor[] }>(
      `/api/artifacts/${artifact.id}/proposals?status=all`,
      { cookies: owner.cookies },
    );
    expect(history.body.proposals).toHaveLength(1);
    expect(history.body.proposals[0]).toMatchObject({ status: "accepted", resolved_revision: 1 });
  });

  test("dismiss records the drop and never touches mainline", async () => {
    const runId = await createSandboxRun(owner);
    const artifact = await publishDoc(owner, runId, "/root/work/brief.md");
    const workpiecePath = `/api/artifacts/${artifact.id}/workpiece`;

    const proposalId = proposalIdOf(
      await propose(owner, runId, artifact.id, { text: "unwanted change\n" }),
    );

    const dismiss = await json<{ proposal: ArtifactWorkpieceProposalDescriptor }>(
      `/api/artifacts/${artifact.id}/proposals/${proposalId}/dismiss`,
      { method: "POST", cookies: owner.cookies },
    );
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.proposal).toMatchObject({ status: "dismissed", resolved_revision: null });
    expect(dismiss.body.proposal.resolved_by).toBeTruthy();

    const state = await json<{ workpiece: { state_revision: number }; state: { text: string } }>(
      workpiecePath,
      { cookies: owner.cookies },
    );
    expect(state.body.workpiece.state_revision).toBe(0);
    expect(state.body.state).toEqual({ text: "original body\nline two\n" });

    const pending = await json<{ proposals: ArtifactWorkpieceProposalDescriptor[] }>(
      `/api/artifacts/${artifact.id}/proposals`,
      { cookies: owner.cookies },
    );
    expect(pending.body.proposals).toHaveLength(0);

    const history = await json<{ proposals: ArtifactWorkpieceProposalDescriptor[] }>(
      `/api/artifacts/${artifact.id}/proposals?status=all`,
      { cookies: owner.cookies },
    );
    expect(history.body.proposals.map((proposal) => proposal.status)).toEqual(["dismissed"]);

    const again = await fetchApi(
      `/api/artifacts/${artifact.id}/proposals/${proposalId}/dismiss`,
      { method: "POST", cookies: owner.cookies },
    );
    expect(again.status).toBe(409);
  });

  test("accept conflicts when mainline advanced past the proposal, preserving the human edit", async () => {
    const runId = await createSandboxRun(owner);
    const artifact = await publishDoc(owner, runId, "/root/work/conflict.md");
    const workpiecePath = `/api/artifacts/${artifact.id}/workpiece`;

    const proposalId = proposalIdOf(
      await propose(owner, runId, artifact.id, { text: "agent revision\n" }),
    );

    // A human saves mainline first (revision 0 -> 1) through the normal PATCH path.
    const human = await json<{ workpiece: { state_revision: number } }>(workpiecePath, {
      method: "PATCH",
      cookies: owner.cookies,
      body: { expected_revision: 0, state: { text: "human edit\n" } },
    });
    expect(human.status).toBe(200);
    expect(human.body.workpiece.state_revision).toBe(1);

    const accept = await fetchApi(
      `/api/artifacts/${artifact.id}/proposals/${proposalId}/accept`,
      { method: "POST", cookies: owner.cookies },
    );
    expect(accept.status).toBe(409);
    expect(await accept.json()).toMatchObject({
      error: "revision conflict",
      workpiece: { state_revision: 1 },
      state: { text: "human edit\n" },
    });

    // The proposal is untouched and still reviewable against the new mainline.
    const stillPending = await json<{ proposals: ArtifactWorkpieceProposalDescriptor[] }>(
      `/api/artifacts/${artifact.id}/proposals`,
      { cookies: owner.cookies },
    );
    expect(stillPending.body.proposals).toHaveLength(1);
    expect(stillPending.body.proposals[0]).toMatchObject({ status: "pending" });
  });

  test("fails closed across organizations and rejects malformed proposals", async () => {
    const runId = await createSandboxRun(owner);
    const artifact = await publishDoc(owner, runId, "/root/work/iso.md");
    const proposalId = proposalIdOf(await propose(owner, runId, artifact.id, { text: "x\n" }));

    const outsiderRunId = await createSandboxRun(outsider);
    const outsiderList = await fetchApi(`/api/artifacts/${artifact.id}/proposals`, {
      cookies: outsider.cookies,
    });
    expect(outsiderList.status).toBe(404);
    const outsiderAccept = await fetchApi(
      `/api/artifacts/${artifact.id}/proposals/${proposalId}/accept`,
      { method: "POST", cookies: outsider.cookies },
    );
    expect(outsiderAccept.status).toBe(404);

    // An agent in another org cannot even see the workpiece to propose against it.
    const crossOrg = await propose(outsider, outsiderRunId, artifact.id, { text: "y\n" });
    expect(crossOrg.isError).toBe(true);
    expect(crossOrg.content[0]?.text).toContain("No editable workpiece found");

    // A state shape that does not match the workpiece kind is rejected up front.
    const wrongShape = await propose(owner, runId, artifact.id, { csv: "a,b\n1,2" });
    expect(wrongShape.isError).toBe(true);
    expect(wrongShape.content[0]?.text).toContain("not a valid document workpiece");

    const missing = await propose(owner, runId, crypto.randomUUID(), { text: "z\n" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("No editable workpiece found");
  });
});
