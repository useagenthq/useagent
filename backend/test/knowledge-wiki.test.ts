import { beforeAll, describe, expect, test } from "bun:test";
import { createOrgSession, json, uid, type OrgSession } from "./helpers";

// ---------------------------------------------------------------------------
// Slice B (mem_op.md 0.3) — Wiki over Knowledge. Proves the document lifecycle
// and its coupling to retrieval: a DRAFT is invisible to search; PUBLISHING makes
// it agent-searchable via knowledge_records; a new revision re-publishes new
// content; ARCHIVING removes it from search. Immutable revision history is kept.
// Cross-org isolation is enforced. In-process against the Hono app.
// ---------------------------------------------------------------------------

let session: OrgSession;
let H: { cookies: string };
let other: OrgSession;

const canary1 = `wikialpha${uid().replace(/-/g, "")}`;
const canary2 = `wikibravo${uid().replace(/-/g, "")}`;
const TITLE = `Onboarding ${uid()}`;

async function searchFinds(cookies: string, query: string, title: string): Promise<boolean> {
  const { body } = await json<any>("/api/knowledge/search", { method: "POST", body: { query, k: 10 }, cookies });
  return (body.results ?? []).some((r: any) => r.title === title || (r.text ?? "").includes(query));
}

describe("wiki-over-knowledge document lifecycle", () => {
  let docId = "";

  beforeAll(async () => {
    session = await createOrgSession("wiki");
    H = { cookies: session.cookies };
    other = await createOrgSession("wiki-other");
  });

  test("create → a DRAFT (not published, not searchable)", async () => {
    const { status, body } = await json<any>("/api/knowledge/documents", {
      method: "POST",
      body: { title: TITLE, content: `Welcome. The onboarding secret is ${canary1}.`, slug: "onboarding" },
      ...H,
    });
    expect(status).toBe(200);
    expect(body.document.status).toBe("draft");
    expect(body.document.content).toContain(canary1);
    docId = body.document.id;

    // Default list is PUBLISHED only → the draft is absent.
    const pub = await json<any>("/api/knowledge/documents", H);
    expect(pub.body.documents.some((d: any) => d.id === docId)).toBe(false);
    // Editors CAN see drafts via ?status=draft.
    const drafts = await json<any>("/api/knowledge/documents?status=draft", H);
    expect(drafts.body.documents.some((d: any) => d.id === docId)).toBe(true);

    // The agent's retrieval layer must NOT surface a draft.
    expect(await searchFinds(session.cookies, canary1, TITLE)).toBe(false);
  });

  test("publish → listed in the Wiki view AND agent-searchable", async () => {
    const { status, body } = await json<any>(`/api/knowledge/documents/${docId}/publish`, { method: "POST", body: {}, ...H });
    expect(status).toBe(200);
    expect(body.document.status).toBe("published");
    expect(body.document.publishedRevisionId).toBeTruthy();

    const pub = await json<any>("/api/knowledge/documents", H);
    const shown = pub.body.documents.find((d: any) => d.id === docId);
    expect(shown).toBeDefined();
    expect(shown.content).toContain(canary1);

    // Now the published revision is in knowledge_records → search finds it.
    expect(await searchFinds(session.cookies, canary1, TITLE)).toBe(true);
  });

  test("new revision + re-publish → published content updates, kept immutable", async () => {
    const rev = await json<any>(`/api/knowledge/documents/${docId}/revisions`, {
      method: "POST",
      body: { content: `Welcome. The onboarding secret is now ${canary2}.` },
      ...H,
    });
    expect(rev.status).toBe(200);
    expect(rev.body.revisionId).toBeTruthy();

    // Publishing with no revisionId picks the latest revision.
    const pubRes = await json<any>(`/api/knowledge/documents/${docId}/publish`, { method: "POST", body: {}, ...H });
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.document.content).toContain(canary2);

    // Search now finds the NEW content; the record was replaced in place.
    expect(await searchFinds(session.cookies, canary2, TITLE)).toBe(true);

    // Immutable history: both revisions are retained.
    const one = await json<any>(`/api/knowledge/documents/${docId}`, H);
    expect(one.body.revisions.length).toBeGreaterThanOrEqual(2);
  });

  test("archive → removed from the Wiki view AND from search", async () => {
    const arch = await json<any>(`/api/knowledge/documents/${docId}/archive`, { method: "POST", body: {}, ...H });
    expect(arch.status).toBe(200);
    expect(arch.body.document.status).toBe("archived");

    const pub = await json<any>("/api/knowledge/documents", H);
    expect(pub.body.documents.some((d: any) => d.id === docId)).toBe(false);

    // The knowledge_records row was deleted → no longer agent-searchable.
    expect(await searchFinds(session.cookies, canary2, TITLE)).toBe(false);
  });

  test("cross-org isolation: another org cannot read or mutate the document", async () => {
    const O = { cookies: other.cookies };
    const get = await json<any>(`/api/knowledge/documents/${docId}`, O);
    expect(get.status).toBe(404); // indistinguishable from missing
    const pub = await json<any>(`/api/knowledge/documents/${docId}/publish`, { method: "POST", body: {}, ...O });
    expect(pub.status).toBe(404);
    // And org B's Wiki view never contained it.
    const list = await json<any>("/api/knowledge/documents?status=all", O);
    expect(list.body.documents.some((d: any) => d.id === docId)).toBe(false);
  });

  test("validation: title + content required", async () => {
    const noTitle = await json("/api/knowledge/documents", { method: "POST", body: { content: "x" }, ...H });
    expect(noTitle.status).toBe(400);
    const noContent = await json("/api/knowledge/documents", { method: "POST", body: { title: "x" }, ...H });
    expect(noContent.status).toBe(400);
  });
});
