import { afterAll, describe, expect, test } from "bun:test";
import { uid } from "./helpers"; // side-effect: imports src/index → migrate + seed
import { findExisting, sql } from "../src/knowledge/store";
import { archiveDocument, createDocument, getDocument, publishDocument } from "../src/knowledge/wiki";

// Fix 7 — a wiki lifecycle transition must be ATOMIC across (document status) and
// (knowledge_records index/removal), or a partial failure desyncs search: a doc
// marked "published" that search can't find, or an "archived" doc still visible.
//
// We inject a REAL failure BETWEEN the two writes by installing a trigger on
// knowledge_records that RAISEs on a poison marker — firing on the INSERT the
// publish does and the DELETE the archive does. Under the fix (both writes in one
// sql.begin) the status flip rolls back too, so search NEVER desyncs. The happy
// path (draft→searchable→archived) stays covered by knowledge-wiki.test.ts.

const POISON = "FIX7POISONMARKER";
const TRIGGER = "_fix7_wiki_boom";

async function installTrigger(): Promise<void> {
  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION ${TRIGGER}() RETURNS trigger AS $$
    BEGIN
      IF position('${POISON}' in coalesce(NEW.body, OLD.body, '')) > 0 THEN
        RAISE EXCEPTION 'fix7 injected failure';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END; $$ LANGUAGE plpgsql;
  `);
  await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON knowledge_records`);
  await sql.unsafe(
    `CREATE TRIGGER ${TRIGGER} BEFORE INSERT OR DELETE ON knowledge_records FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}()`,
  );
}

async function removeTrigger(): Promise<void> {
  await sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER} ON knowledge_records`);
  await sql.unsafe(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
}

describe("wiki publish/archive are transactional (search never desyncs on a partial failure)", () => {
  afterAll(removeTrigger);

  test("publish: a failure indexing the record rolls back the status flip (doc stays draft, unindexed)", async () => {
    const org = `wtx-${uid()}`;
    const doc = await createDocument({
      orgId: org,
      userId: null,
      title: `Runbook ${uid()}`,
      content: `Deploy steps ${POISON} and more.`,
    });
    expect(doc.status).toBe("draft");

    await installTrigger();
    // publish: the doc UPDATE→published commits inside the tx, then the
    // knowledge_records INSERT hits the trigger and RAISEs → the whole tx aborts.
    let threw = false;
    try {
      await publishDocument(org, doc.id);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await removeTrigger();

    // NO DESYNC: the status flip rolled back with the failed insert.
    const after = await getDocument(org, doc.id);
    expect(after!.status).toBe("draft");
    expect(await findExisting(org, "wiki", `wiki:${doc.id}`)).toBeNull();

    // ...and once the transient failure clears, publish is consistent.
    const pub = await publishDocument(org, doc.id);
    expect(pub!.status).toBe("published");
    expect(await findExisting(org, "wiki", `wiki:${doc.id}`)).not.toBeNull();
  });

  test("archive: a failure removing the record rolls back the status flip (doc stays published + indexed)", async () => {
    const org = `wtx-${uid()}`;
    const doc = await createDocument({
      orgId: org,
      userId: null,
      title: `Playbook ${uid()}`,
      content: `Rollback steps ${POISON} here.`,
    });
    const pub = await publishDocument(org, doc.id);
    expect(pub!.status).toBe("published");
    expect(await findExisting(org, "wiki", `wiki:${doc.id}`)).not.toBeNull();

    await installTrigger();
    // archive: the doc UPDATE→archived commits inside the tx, then the
    // knowledge_records DELETE hits the trigger and RAISEs → the whole tx aborts.
    let threw = false;
    try {
      await archiveDocument(org, doc.id);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await removeTrigger();

    // NO DESYNC: still published AND still indexed (both rolled back together).
    const after = await getDocument(org, doc.id);
    expect(after!.status).toBe("published");
    expect(await findExisting(org, "wiki", `wiki:${doc.id}`)).not.toBeNull();

    // ...and once the failure clears, archive removes the record consistently.
    const arch = await archiveDocument(org, doc.id);
    expect(arch!.status).toBe("archived");
    expect(await findExisting(org, "wiki", `wiki:${doc.id}`)).toBeNull();
  });
});
