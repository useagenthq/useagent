import postgres from "postgres";
import { openSecret } from "../src/secrets/crypto";

const sourceDatabaseUrl = process.env.SOURCE_DATABASE_URL ?? process.env.DATABASE_URL;
const sourceOrgId = process.env.SOURCE_ORG_ID ?? "org-skynet-dev";
const targetOrigin = process.env.TARGET_ORIGIN?.replace(/\/+$/, "");
const targetEmail = process.env.TARGET_EMAIL;
const targetPassword = process.env.TARGET_PASSWORD;

if (!sourceDatabaseUrl || !targetOrigin || !targetEmail || !targetPassword) {
  throw new Error(
    "SOURCE_DATABASE_URL/DATABASE_URL, TARGET_ORIGIN, TARGET_EMAIL, and TARGET_PASSWORD are required",
  );
}

const sql = postgres(sourceDatabaseUrl);

try {
  const rows = await sql<
    Array<{
      name: string;
      kind: "env" | "file";
      value_ciphertext: string;
      iv: string;
      tag: string;
    }>
  >`
    SELECT name, kind, value_ciphertext, iv, tag
    FROM secrets
    WHERE org_id = ${sourceOrgId}
    ORDER BY name
  `;

  const signIn = await fetch(`${targetOrigin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: targetEmail, password: targetPassword }),
  });
  if (!signIn.ok) {
    throw new Error(`target sign-in failed (${signIn.status})`);
  }

  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (!cookie) throw new Error("target sign-in returned no session cookie");

  for (const row of rows) {
    const value = openSecret({
      ciphertext: row.value_ciphertext,
      iv: row.iv,
      tag: row.tag,
    });
    const response = await fetch(
      `${targetOrigin}/api/secrets/${encodeURIComponent(row.name)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ value, kind: row.kind }),
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `failed to migrate ${row.name} (${response.status}): ${detail.slice(0, 200)}`,
      );
    }
  }

  console.log(`Migrated ${rows.length} encrypted tenant secrets to ${targetOrigin}`);
} finally {
  await sql.end();
}
