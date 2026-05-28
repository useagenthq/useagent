import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { providerConnections, secrets } from "../src/db/schema";
import { rewrapSecret, secretNeedsRewrap } from "../src/secrets/crypto";

const apply = process.argv.includes("--apply");

const result = await db.transaction(async (tx) => {
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

  if (apply) {
    for (const row of staleSecrets) {
      const sealed = rewrapSecret({ ciphertext: row.valueCiphertext, iv: row.iv, tag: row.tag });
      await tx.update(secrets).set({
        valueCiphertext: sealed.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
        updatedAt: new Date(),
      }).where(eq(secrets.id, row.id));
    }
    for (const row of staleProviders) {
      const sealed = rewrapSecret({
        ciphertext: row.credentialCiphertext,
        iv: row.iv,
        tag: row.tag,
      });
      await tx.update(providerConnections).set({
        credentialCiphertext: sealed.ciphertext,
        iv: sealed.iv,
        tag: sealed.tag,
        updatedAt: new Date(),
      }).where(eq(providerConnections.id, row.id));
    }
  }

  return { secrets: staleSecrets.length, providerConnections: staleProviders.length };
});

console.log(JSON.stringify({ mode: apply ? "applied" : "dry-run", ...result }));
