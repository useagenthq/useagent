import { migrate } from "drizzle-orm/postgres-js/migrator";

import { client, db } from "../src/db/client";
import { applyGatewayGrants } from "../src/db/gateway-grants";
import { ready as ensureKnowledgeReady, sql as knowledgeSql } from "../src/knowledge/store";

await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
await ensureKnowledgeReady();
await applyGatewayGrants(client, { strict: true });
await Promise.all([
  client.end({ timeout: 5 }),
  knowledgeSql.end({ timeout: 5 }),
]);

console.log("RELEASE_DATABASE_READY");
