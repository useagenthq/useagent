import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sealSecret } from "../secrets/crypto";
import {
  openGatewayProviderApiKeyCredential,
  type GatewayProviderApiKeyCredentialRow,
} from "./api-key-credentials";

const encryptionKey = "gateway-api-key-test-encryption-root-0123456789";

let previousEncryptionKey: string | undefined;
let previousDevMode: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
  previousDevMode = process.env.SKYNET_DEV_MODE;
  process.env.SECRETS_ENCRYPTION_KEY = encryptionKey;
  process.env.SKYNET_DEV_MODE = "false";
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousDevMode === undefined) delete process.env.SKYNET_DEV_MODE;
  else process.env.SKYNET_DEV_MODE = previousDevMode;
});

function rowFor(value: unknown, overrides: Partial<GatewayProviderApiKeyCredentialRow> = {}) {
  const sealed = sealSecret(JSON.stringify(value));
  return {
    auth_method: "api_key",
    status: "connected",
    credential_ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    tag: sealed.tag,
    ...overrides,
  } satisfies GatewayProviderApiKeyCredentialRow;
}

describe("gateway provider API-key credentials", () => {
  test("opens connected API-key rows from the restricted view", () => {
    const apiKey = `sk-test-${crypto.randomUUID()}`;

    expect(openGatewayProviderApiKeyCredential(rowFor({
      authMethod: "api_key",
      value: ` ${apiKey} `,
    }))).toBe(apiKey);
  });

  test("does not return OAuth or revoked provider connection material", () => {
    expect(openGatewayProviderApiKeyCredential(rowFor({
      authMethod: "chatgpt_oauth",
      value: {
        accessToken: "oauth-access-token",
        accountId: "acct",
        planType: "plus",
      },
    }))).toBeNull();
    expect(openGatewayProviderApiKeyCredential(rowFor({
      authMethod: "api_key",
      value: "sk-revoked",
    }, { status: "revoked" }))).toBeNull();
  });
});
