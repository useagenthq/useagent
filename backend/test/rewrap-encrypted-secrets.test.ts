import { describe, expect, test } from "bun:test";
import type { Db } from "../src/db/client";
import { providerConnections, secrets } from "../src/db/schema";
import { sealSecret } from "../src/secrets/crypto";
import { rewrapEncryptedSecrets } from "../scripts/rewrap-encrypted-secrets";

describe("encrypted secret rewrap", () => {
  test("a concurrent provider credential change aborts the whole rewrap transaction", async () => {
    const previousCurrent = process.env.SECRETS_ENCRYPTION_KEY;
    const previousKeyring = process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
    const oldKey = "old-rewrap-root-0123456789abcdef0123456789";
    const newKey = "new-rewrap-root-0123456789abcdef0123456789";

    try {
      process.env.SECRETS_ENCRYPTION_KEY = oldKey;
      delete process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
      const secret = sealSecret("org-secret");
      const credential = sealSecret("provider-credential");
      process.env.SECRETS_ENCRYPTION_KEY = newKey;
      process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS = JSON.stringify([oldKey]);

      let committedUpdates = 0;
      const database = {
        transaction: async (callback: (tx: any) => Promise<unknown>) => {
          let stagedUpdates = 0;
          const tx = {
            select: () => ({
              from: async (table: unknown) => table === secrets
                ? [{ id: "secret-id", valueCiphertext: secret.ciphertext, iv: secret.iv, tag: secret.tag }]
                : [{ id: "provider-id", credentialCiphertext: credential.ciphertext, iv: credential.iv, tag: credential.tag }],
            }),
            update: (table: unknown) => ({
              set: () => ({
                where: () => ({
                  returning: async () => {
                    if (table === providerConnections) return [];
                    stagedUpdates += 1;
                    return [{ id: "secret-id" }];
                  },
                }),
              }),
            }),
          };
          const result = await callback(tx);
          committedUpdates += stagedUpdates;
          return result;
        },
      } as unknown as Db;

      await expect(rewrapEncryptedSecrets(database, true)).rejects.toThrow(
        "rewrap conflict: provider connection provider-id changed during rotation",
      );
      expect(committedUpdates).toBe(0);
    } finally {
      if (previousCurrent === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = previousCurrent;
      if (previousKeyring === undefined) delete process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS;
      else process.env.SECRETS_ENCRYPTION_PREVIOUS_KEYS = previousKeyring;
    }
  });
});
