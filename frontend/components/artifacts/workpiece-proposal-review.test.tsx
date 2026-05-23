import { expect, test } from "bun:test";
import type { ArtifactWorkpieceProposalDescriptor } from "@skynet/agent-client";
import { renderToStaticMarkup } from "react-dom/server";
import { ProposalCard, WorkpieceProposalBanner } from "./workpiece-proposal-review";

function proposal(
  over: Partial<ArtifactWorkpieceProposalDescriptor> = {},
): ArtifactWorkpieceProposalDescriptor {
  return {
    id: "prop-1",
    artifact_id: "art-1",
    proposer_run_id: "run-abcdef1234",
    kind: "document",
    base_revision: 0,
    summary: "Tighten the intro",
    status: "pending",
    created_at: "2026-08-18T00:00:00.000Z",
    resolved_at: null,
    resolved_by: null,
    resolved_revision: null,
    state: { text: "revised body" },
    ...over,
  };
}

test("banner announces one pending change and offers review", () => {
  const html = renderToStaticMarkup(
    <WorkpieceProposalBanner
      kind="document"
      pending={[proposal()]}
      mainlineState={{ text: "original body" }}
      busyId={null}
      error={null}
      onAccept={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(html).toContain('data-testid="workpiece-proposal-review"');
  expect(html).toContain('aria-label="Agent proposed changes"');
  expect(html).toContain("Agent proposed a change");
  expect(html).toContain("Review");
});

test("banner pluralizes the count for multiple proposals", () => {
  const html = renderToStaticMarkup(
    <WorkpieceProposalBanner
      kind="document"
      pending={[proposal({ id: "a" }), proposal({ id: "b" })]}
      mainlineState={{ text: "original" }}
      busyId={null}
      error={null}
      onAccept={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(html).toContain("Agent proposed 2 changes");
});

test("banner renders nothing when no proposals pend", () => {
  const html = renderToStaticMarkup(
    <WorkpieceProposalBanner
      kind="document"
      pending={[]}
      mainlineState={null}
      busyId={null}
      error={null}
      onAccept={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(html).toBe("");
});

test("a document proposal card shows the diff, provenance, and accept/dismiss", () => {
  const html = renderToStaticMarkup(
    <ProposalCard
      kind="document"
      proposal={proposal({ state: { text: "a\nrevised" } })}
      mainlineState={{ text: "a\noriginal" }}
      busy={false}
      onAccept={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(html).toContain("Tighten the intro");
  expect(html).toContain("from run run-abcd");
  expect(html).toContain("Accept");
  expect(html).toContain("Dismiss");
  expect(html).toContain("View proposed");
  // The line diff shows the new content and drops the old.
  expect(html).toContain("revised");
  expect(html).toContain("original");
});

test("a spreadsheet proposal card renders changed cells old -> new", () => {
  const html = renderToStaticMarkup(
    <ProposalCard
      kind="spreadsheet"
      proposal={proposal({ kind: "spreadsheet", state: { csv: "name,value\nrun,7" } })}
      mainlineState={{ csv: "name,value\nrun,42" }}
      busy={false}
      onAccept={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(html).toContain("B2");
  expect(html).toContain("42");
  expect(html).toContain("7");
});

test("a busy card disables its actions", () => {
  const html = renderToStaticMarkup(
    <ProposalCard
      kind="document"
      proposal={proposal()}
      mainlineState={{ text: "original body" }}
      busy
      onAccept={() => {}}
      onDismiss={() => {}}
    />,
  );
  expect(html).toContain("disabled");
});
