import postgres from "postgres";
import { applyGatewayGrants } from "../src/db/gateway-grants";

const database = process.argv[2]?.trim();
if (!database || !/^[a-z_][a-z0-9_]*$/.test(database)) {
  console.error("usage: reconcile-gateway-grants.ts DATABASE");
  process.exit(2);
}

const sql = postgres({
  host: "/var/run/postgresql",
  database,
  user: "postgres",
  max: 1,
});

try {
  await applyGatewayGrants(sql, { strict: true });
} finally {
  await sql.end({ timeout: 5 });
}
