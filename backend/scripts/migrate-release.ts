import { migrate } from "drizzle-orm/postgres-js/migrator";

import { client, db } from "../src/db/client";
import { applyGatewayGrants } from "../src/db/gateway-grants";

await migrate(db, { migrationsFolder: `${import.meta.dir}/../drizzle` });
await applyGatewayGrants(client, { strict: true });
await client.end({ timeout: 5 });

console.log("RELEASE_DATABASE_READY");
