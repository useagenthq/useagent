import { and, eq } from "drizzle-orm";
import { db, type Db } from "../src/db/client";
import { providerConnections, secrets } from "../src/db/schema";
import { rewrapSecret, secretNeedsRewrap } from "../src/secrets/crypto";

const apply = process.argv.includes("--apply");

export async function rewrapEncryptedSecrets(database: Db, shouldApply: boolean) {
  return database.transaction(async (tx) => {
    const secretRows = await tx.select().from(secrets);
    const providerRows = await tx.select().from(providerConnections);
    const staleSecrets = secretRows.filter((row) => secretNeedsRewrap({
      ciphertext: row.valueCiphertext,
      iv: row.iv,
      tag: row.tag,
    }));
    const staleProviders = providerRows.filter((row) => secretNeedsRewrap({
      ciphertext: row.credentialCiphertext,
      iv: row.iv,
      tag: row.tag,
    }));

    if (shouldApply) {
      for (const row of staleSecrets) {
        const sealed = rewrapSecret({ ciphertext: row.valueCiphertext, iv: row.iv, tag: row.tag });
        const updated = await tx.update(secrets).set({
          valueCiphertext: sealed.ciphertext,
          iv: sealed.iv,
          tag: sealed.tag,
          updatedAt: new Date(),
        }).where(and(
          eq(secrets.id, row.id),
          eq(secrets.valueCiphertext, row.valueCiphertext),
          eq(secrets.iv, row.iv),
          eq(secrets.tag, row.tag),
        )).returning({ id: secrets.id });
        if (updated.length !== 1) {
          throw new Error(`rewrap conflict: secret ${row.id} changed during rotation`);
        }
      }
      for (const row of staleProviders) {
        const sealed = rewrapSecret({
          ciphertext: row.credentialCiphertext,
          iv: row.iv,
          tag: row.tag,
        });
        const updated = await tx.update(providerConnections).set({
          credentialCiphertext: sealed.ciphertext,
          iv: sealed.iv,
          tag: sealed.tag,
          updatedAt: new Date(),
        }).where(and(
          eq(providerConnections.id, row.id),
          eq(providerConnections.credentialCiphertext, row.credentialCiphertext),
          eq(providerConnections.iv, row.iv),
          eq(providerConnections.tag, row.tag),
        )).returning({ id: providerConnections.id });
        if (updated.length !== 1) {
          throw new Error(`rewrap conflict: provider connection ${row.id} changed during rotation`);
        }
      }
    }

    return { secrets: staleSecrets.length, providerConnections: staleProviders.length };
  });
}

if (import.meta.main) {
  const result = await rewrapEncryptedSecrets(db, apply);
  console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", ...result }));
}
