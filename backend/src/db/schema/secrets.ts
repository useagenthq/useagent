import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Org Secrets — org-scoped named secrets injected into the per-thread sandbox at
// boot (task #100). The value is AES-256-GCM encrypted at rest
// (src/secrets/crypto.ts); `iv` + `tag` are the GCM nonce and auth tag. The
// plaintext value is WRITE-ONLY at the API boundary — never returned by any
// route, only decrypted server-side for injection. `name` is an env-var
// identifier (^[A-Z][A-Z0-9_]*$), unique per org.
//
// `kind` selects HOW the secret reaches the sandbox:
//  - "env"  (default): injected as an environment variable NAME=value.
//  - "file": the decrypted value is materialized to a 0600 file inside the
//    sandbox and the env var is set to that PATH (for file-shaped creds like a
//    GCP service-account JSON or a PEM private key).
// ---------------------------------------------------------------------------

export const SECRET_KINDS = ["env", "file"] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    // How the secret is injected: an env var value ("env") or a materialized
    // file whose PATH becomes the env var value ("file").
    kind: text("kind").$type<SecretKind>().notNull().default("env"),
    // base64 AES-256-GCM ciphertext of the value + its per-row iv and auth tag.
    valueCiphertext: text("value_ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_secrets_org_name").on(t.orgId, t.name)],
);
