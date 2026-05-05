import { env } from "./env";
import { ingestOne } from "./ingest";
import { countRecords, setPinned, findExisting } from "./store";
import { seedEntries } from "./seed-data";

/**
 * On boot, if the default org has no records, ingest the frontend's mock
 * knowledge through the REAL ingest path (source_type "document", connector
 * "seed:frontend"). The corpus is therefore genuine distilled output — not
 * hand-written rows. Idempotent + guarded so it runs at most once.
 */
const CONNECTOR = "seed:frontend";

let started = false;

export async function seedIfEmpty(orgId: string = env.defaultOrg): Promise<void> {
  if (started) return;
  started = true;
  try {
    const existing = await countRecords(orgId);
    if (existing > 0) {
      console.log(`[knowledge] seed skipped — org "${orgId}" already has ${existing} record(s)`);
      return;
    }
    console.log(`[knowledge] seeding ${seedEntries.length} entries into org "${orgId}" via real ingest path…`);
    let stored = 0;
    for (const e of seedEntries) {
      const text = `${e.name}\n\nWhen to recall: ${e.trigger}\n\n${e.body}`;
      try {
        const res = await ingestOne({
          org_id: orgId,
          meta: {
            source_type: "document",
            external_id: e.id,
            connector_instance_id: CONNECTOR,
            source_url: null,
            author: null,
            created_at: new Date().toISOString(),
            domain: e.folder,
          },
          text,
        });
        if (res.status === "stored") {
          stored++;
          if (e.pinned) {
            const row = await findExisting(orgId, CONNECTOR, e.id);
            if (row) await setPinned(orgId, row.id, true);
          }
        }
        console.log(`[knowledge]   ${e.id}: ${res.status}${res.stub ? " (stub)" : ""} → ${res.kind}`);
      } catch (err) {
        console.warn(`[knowledge]   ${e.id}: seed failed — ${(err as Error).message}`);
      }
    }
    console.log(`[knowledge] seed complete — ${stored}/${seedEntries.length} stored`);
  } catch (err) {
    console.warn("[knowledge] seed aborted:", (err as Error).message);
  }
}
