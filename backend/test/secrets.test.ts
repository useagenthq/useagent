import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, secrets, user } from "../src/db/schema";
import { openSecret, sealSecret } from "../src/secrets/crypto";
import { decryptOrgSecretByName, decryptOrgSecrets } from "../src/secrets/store";
import {
  buildInjection,
  materializeSecretFiles,
  PROVIDER_SECRET_NAMES,
  SECRET_DOTENV_PATH,
  SECRET_FILE_DIR,
  SECRET_SOURCE_COMMAND,
} from "../src/secrets/inject";
import { createOrgSession, json, uid, type OrgSession } from "./helpers";

// Org Secrets API + injection (task #100). Values are write-only at the boundary:
// GET returns names + timestamps ONLY. Two-org isolation: A's secrets are
// invisible to B and B cannot overwrite them. Injection: decryptOrgSecrets
// composes the env from present secrets and skips any undecryptable row.

describe("secrets routes — CRUD, name validation, write-only values", () => {
  test("PUT upsert → GET lists name+timestamps only → PUT again bumps updatedAt → DELETE → gone", async () => {
    const name = `PROOF_${uid("s").toUpperCase().replace(/-/g, "_")}`;

    const put = await json<any>(`/api/secrets/${name}`, {
      method: "PUT",
      body: { value: "first-value" },
    });
    expect(put.status).toBe(200);
    // The response is metadata only — never the value or any ciphertext material.
    expect(Object.keys(put.body).sort()).toEqual(["createdAt", "kind", "name", "updatedAt"]);
    expect(put.body.name).toBe(name);
    expect(put.body.kind).toBe("env");

    const list = await json<{ secrets: any[] }>("/api/secrets");
    const mine = list.body.secrets.find((s) => s.name === name);
    expect(mine).toBeTruthy();
    // Assert the listed shape carries NO value / ciphertext / iv / tag.
    expect(Object.keys(mine).sort()).toEqual(["createdAt", "kind", "name", "updatedAt"]);
    for (const leak of ["value", "value_ciphertext", "valueCiphertext", "iv", "tag", "ciphertext"]) {
      expect(mine[leak]).toBeUndefined();
    }

    // Upsert the same name → still 200, updatedAt moves forward.
    await new Promise((r) => setTimeout(r, 5));
    const put2 = await json<any>(`/api/secrets/${name}`, {
      method: "PUT",
      body: { value: "second-value" },
    });
    expect(put2.status).toBe(200);
    expect(new Date(put2.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(put.body.updatedAt).getTime(),
    );
    // Still exactly one row for this name (upsert, not insert).
    const list2 = await json<{ secrets: any[] }>("/api/secrets");
    expect(list2.body.secrets.filter((s) => s.name === name)).toHaveLength(1);

    const del = await json<any>(`/api/secrets/${name}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true, name });

    const list3 = await json<{ secrets: any[] }>("/api/secrets");
    expect(list3.body.secrets.some((s) => s.name === name)).toBe(false);
  });

  test("there is NO value read-back endpoint (GET by name is not a route)", async () => {
    const name = `READBACK_${uid("s").toUpperCase().replace(/-/g, "_")}`;
    await json(`/api/secrets/${name}`, { method: "PUT", body: { value: "sensitive" } });
    // GET /api/secrets/:name is deliberately unrouted — Hono 404s an unknown path.
    const readback = await json<any>(`/api/secrets/${name}`);
    expect(readback.status).toBe(404);
    await json(`/api/secrets/${name}`, { method: "DELETE" });
  });

  test("PUT rejects a non-env-var name (400) and a missing value (400)", async () => {
    const badName = await json<any>("/api/secrets/not-a-valid-name", {
      method: "PUT",
      body: { value: "x" },
    });
    expect(badName.status).toBe(400);

    const lower = await json<any>("/api/secrets/lowercase", {
      method: "PUT",
      body: { value: "x" },
    });
    expect(lower.status).toBe(400);

    const noValue = await json<any>("/api/secrets/VALID_NAME", {
      method: "PUT",
      body: {},
    });
    expect(noValue.status).toBe(400);

    for (const reserved of ["BASH_ENV", "PATH", "NODE_OPTIONS", "ANTHROPIC_BASE_URL"]) {
      const response = await json<any>(`/api/secrets/${reserved}`, {
        method: "PUT",
        body: { value: "must-not-enter-sandbox-startup" },
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("reserved");
    }
  });

  test("DELETE of an unknown secret → 404", async () => {
    const del = await json<any>(`/api/secrets/DOES_NOT_EXIST_${Date.now()}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
  });
});

describe("secrets — mutation authorization", () => {
  test("organization members may list metadata but only admins/owners may mutate", async () => {
    const org = await createOrgSession("sec-member");
    const name = `ADMIN_ONLY_${uid("s").toUpperCase().replace(/-/g, "_")}`;
    expect(
      (await json(`/api/secrets/${name}`, {
        method: "PUT",
        cookies: org.cookies,
        body: { value: "owner-created" },
      })).status,
    ).toBe(200);

    const [account] = await db.select({ id: user.id }).from(user).where(eq(user.email, org.email));
    expect(account).toBeTruthy();
    await db
      .update(member)
      .set({ role: "member" })
      .where(and(eq(member.organizationId, org.orgId), eq(member.userId, account!.id)));

    expect((await json("/api/secrets", { cookies: org.cookies })).status).toBe(200);
    const update = await json<any>(`/api/secrets/${name}`, {
      method: "PUT",
      cookies: org.cookies,
      body: { value: "member-overwrite" },
    });
    expect(update.status).toBe(403);
    expect(update.body).toEqual({ error: "organization_admin_required" });
    expect(
      (await json(`/api/secrets/${name}`, { method: "DELETE", cookies: org.cookies })).status,
    ).toBe(403);
  });
});

describe("secrets — two-org isolation", () => {
  let A: OrgSession;
  let B: OrgSession;

  beforeAll(async () => {
    A = await createOrgSession("sec-a");
    B = await createOrgSession("sec-b");
    expect(A.orgId).not.toBe(B.orgId);
  });

  test("B cannot list or delete A's secret, and PUTting the same name cannot overwrite A's value", async () => {
    const name = "SHARED_NAME";
    const putA = await json<any>(`/api/secrets/${name}`, {
      method: "PUT",
      cookies: A.cookies,
      body: { value: "value-belongs-to-A" },
    });
    expect(putA.status).toBe(200);

    // B's list never surfaces A's secret.
    const listB = await json<{ secrets: any[] }>("/api/secrets", { cookies: B.cookies });
    expect(listB.body.secrets.some((s) => s.name === name)).toBe(false);

    // B deleting the name it does not own → 404 (does not touch A's row).
    const delB = await json<any>(`/api/secrets/${name}`, { method: "DELETE", cookies: B.cookies });
    expect(delB.status).toBe(404);

    // B writing the SAME name creates B's OWN row — it must not overwrite A's value.
    const putB = await json<any>(`/api/secrets/${name}`, {
      method: "PUT",
      cookies: B.cookies,
      body: { value: "value-belongs-to-B" },
    });
    expect(putB.status).toBe(200);

    // Verify at the storage layer (the only place values are readable): each org
    // decrypts to its OWN value — A's was never overwritten by B.
    const valueFor = (d: Awaited<ReturnType<typeof decryptOrgSecrets>>, n: string) =>
      d.secrets.find((s) => s.name === n)?.value;
    const decA = await decryptOrgSecrets(A.orgId);
    const decB = await decryptOrgSecrets(B.orgId);
    expect(valueFor(decA, name)).toBe("value-belongs-to-A");
    expect(valueFor(decB, name)).toBe("value-belongs-to-B");

    // Positive control: A still lists its secret.
    const listA = await json<{ secrets: any[] }>("/api/secrets", { cookies: A.cookies });
    expect(listA.body.secrets.some((s) => s.name === name)).toBe(true);
  });
});

describe("secrets injection — composes env, skips corrupt rows", () => {
  test("decryptOrgSecrets returns present secrets and skips an undecryptable one", async () => {
    const org = await createOrgSession("sec-inject");

    await json(`/api/secrets/GOOD_ONE`, {
      method: "PUT",
      cookies: org.cookies,
      body: { value: "good-value" },
    });
    await json(`/api/secrets/BAD_ONE`, {
      method: "PUT",
      cookies: org.cookies,
      body: { value: "bad-value" },
    });

    // Corrupt BAD_ONE's auth tag at rest so decryption fails closed for it only.
    await db
      .update(secrets)
      .set({ tag: Buffer.from("not-the-real-tag").toString("base64") })
      .where(and(eq(secrets.orgId, org.orgId), eq(secrets.name, "BAD_ONE")));

    const decrypted = await decryptOrgSecrets(org.orgId);
    const good = decrypted.secrets.find((s) => s.name === "GOOD_ONE");
    expect(good?.value).toBe("good-value");
    expect(good?.kind).toBe("env");
    expect(decrypted.secrets.some((s) => s.name === "BAD_ONE")).toBe(false);
    expect(decrypted.names).toContain("GOOD_ONE");
    expect(decrypted.names).not.toContain("BAD_ONE");
    expect(decrypted.skipped).toContain("BAD_ONE");
  });

  test("exact-name decryption does not materialize or fail on unrelated rows", async () => {
    const org = await createOrgSession("sec-exact");
    await json("/api/secrets/EXACT_GOOD", {
      method: "PUT",
      cookies: org.cookies,
      body: { value: "only-this-value" },
    });
    await json("/api/secrets/UNRELATED_BAD", {
      method: "PUT",
      cookies: org.cookies,
      body: { value: "corrupt-me" },
    });
    await db
      .update(secrets)
      .set({ tag: Buffer.from("broken").toString("base64") })
      .where(and(eq(secrets.orgId, org.orgId), eq(secrets.name, "UNRELATED_BAD")));

    expect(await decryptOrgSecretByName(org.orgId, "EXACT_GOOD")).toMatchObject({
      name: "EXACT_GOOD",
      value: "only-this-value",
    });
  });
});

describe("secrets — encryption-root rotation", () => {
  test("new dedicated key reads legacy rows and seals new rows independently", () => {
    const previous = {
      auth: process.env.BETTER_AUTH_SECRET,
      encryption: process.env.SECRETS_ENCRYPTION_KEY,
      dev: process.env.USEAGENT_DEV_MODE,
    };
    try {
      process.env.USEAGENT_DEV_MODE = "true";
      process.env.BETTER_AUTH_SECRET = "legacy-auth-root-0123456789abcdef0123456789";
      delete process.env.SECRETS_ENCRYPTION_KEY;
      const legacy = sealSecret("legacy-value");

      process.env.SECRETS_ENCRYPTION_KEY = "dedicated-root-0123456789abcdef0123456789";
      expect(openSecret(legacy)).toBe("legacy-value");
      const current = sealSecret("current-value");
      delete process.env.BETTER_AUTH_SECRET;
      expect(openSecret(current)).toBe("current-value");
    } finally {
      if (previous.auth === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previous.auth;
      if (previous.encryption === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = previous.encryption;
      if (previous.dev === undefined) delete process.env.USEAGENT_DEV_MODE;
      else process.env.USEAGENT_DEV_MODE = previous.dev;
    }
  });
});

describe("secrets — file kind (materialized to a sandbox file, env var = path)", () => {
  test("PUT kind:file persists kind; an invalid kind is 400", async () => {
    const org = await createOrgSession("sec-file");

    const put = await json<any>(`/api/secrets/GOOGLE_APPLICATION_CREDENTIALS`, {
      method: "PUT",
      cookies: org.cookies,
      body: { value: '{"type":"service_account"}', kind: "file" },
    });
    expect(put.status).toBe(200);
    expect(put.body.kind).toBe("file");

    const list = await json<{ secrets: any[] }>("/api/secrets", { cookies: org.cookies });
    expect(list.body.secrets.find((s) => s.name === "GOOGLE_APPLICATION_CREDENTIALS")?.kind).toBe("file");

    const bad = await json<any>(`/api/secrets/SOME_NAME`, {
      method: "PUT",
      cookies: org.cookies,
      body: { value: "x", kind: "socket" },
    });
    expect(bad.status).toBe(400);

    // Decrypt carries the kind; buildInjection maps a file-kind secret to a file
    // plus a path export in the dotenv (env var = path).
    const decrypted = await decryptOrgSecrets(org.orgId);
    const injection = buildInjection(decrypted);
    const path = `${SECRET_FILE_DIR}/GOOGLE_APPLICATION_CREDENTIALS`;
    const dotenv = injection.files.find((f) => f.path === SECRET_DOTENV_PATH);
    expect(dotenv?.content).toContain(`export GOOGLE_APPLICATION_CREDENTIALS="${path}"`);
    expect(injection.files).toContainEqual({ path, content: '{"type":"service_account"}' });
  });

  test("buildInjection: tiny createEnv (BASH_ENV) + dotenv exports; file-kind exports its path", () => {
    const injection = buildInjection({
      secrets: [
        { name: "API_TOKEN", kind: "env", value: "tok-123" },
        { name: "SA_JSON", kind: "file", value: '{"k":"v"}' },
        { name: "WEIRD", kind: "env", value: "a'b" }, // embedded single quote
      ],
      names: ["API_TOKEN", "SA_JSON", "WEIRD"],
      skipped: [],
    });
    // Create-env is TINY - only BASH_ENV, never the secret values (Daytona limit).
    expect(injection.createEnv).toEqual({ BASH_ENV: SECRET_DOTENV_PATH });
    const dotenv = injection.files.find((f) => f.path === SECRET_DOTENV_PATH);
    expect(dotenv).toBeTruthy();
    expect(dotenv!.content).toContain("export API_TOKEN='tok-123'");
    expect(dotenv!.content).toContain(`export SA_JSON="${SECRET_FILE_DIR}/SA_JSON"`);
    // POSIX single-quote escaping keeps an embedded quote intact.
    expect(dotenv!.content).toContain(`export WEIRD='a'\\''b'`);
    // The file-kind content is materialized as its own 0600 file.
    expect(injection.files).toContainEqual({ path: `${SECRET_FILE_DIR}/SA_JSON`, content: '{"k":"v"}' });
  });

  test("buildInjection uses a sandbox-user-neutral secret directory", () => {
    const injection = buildInjection({
      secrets: [{ name: "SA_JSON", kind: "file", value: "{}" }],
      names: ["SA_JSON"],
      skipped: [],
    });

    expect(SECRET_FILE_DIR).not.toMatch(/^\/(?:root|home)\//);
    expect(SECRET_DOTENV_PATH).toBe(`${SECRET_FILE_DIR}/skynet-env.sh`);
    expect(SECRET_SOURCE_COMMAND).toBe(`. "${SECRET_DOTENV_PATH}"`);
    expect(injection.createEnv).toEqual({ BASH_ENV: SECRET_DOTENV_PATH });
    expect(JSON.stringify(injection)).not.toContain("/root/.secrets");
    expect(injection.files).toContainEqual({
      path: `${SECRET_FILE_DIR}/SA_JSON`,
      content: "{}",
    });
  });

  test("legacy GCP service-account file receives canonical credential and project aliases", () => {
    const value = JSON.stringify({
      type: "service_account",
      project_id: "skynet-production",
      private_key: "redacted",
    });
    const injection = buildInjection({
      secrets: [{ name: "GCP_SERVICE_ACCOUNT_KEY", kind: "file", value }],
      names: ["GCP_SERVICE_ACCOUNT_KEY"],
      skipped: [],
    });
    const path = `${SECRET_FILE_DIR}/GCP_SERVICE_ACCOUNT_KEY`;
    const dotenv = injection.files.find((file) => file.path === SECRET_DOTENV_PATH)?.content ?? "";

    expect(dotenv).toContain(`export GCP_SERVICE_ACCOUNT_KEY="${path}"`);
    expect(dotenv).toContain(`export GOOGLE_APPLICATION_CREDENTIALS="${path}"`);
    expect(dotenv).toContain("export GOOGLE_CLOUD_PROJECT='skynet-production'");
    expect(dotenv).toContain("export GCLOUD_PROJECT='skynet-production'");
    expect(dotenv).toContain("export CLOUDSDK_CORE_PROJECT='skynet-production'");
    expect(injection.files).toContainEqual({ path, content: value });
    expect(injection.names).toEqual(["GCP_SERVICE_ACCOUNT_KEY"]);
  });

  test("explicit canonical Google configuration wins over compatibility aliases", () => {
    const legacy = JSON.stringify({ type: "service_account", project_id: "legacy-project" });
    const canonical = JSON.stringify({ type: "service_account", project_id: "canonical-project" });
    const injection = buildInjection({
      secrets: [
        { name: "GCP_SERVICE_ACCOUNT_KEY", kind: "file", value: legacy },
        { name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file", value: canonical },
        { name: "GOOGLE_CLOUD_PROJECT", kind: "env", value: "explicit-project" },
      ],
      names: [
        "GCP_SERVICE_ACCOUNT_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
      ],
      skipped: [],
    });
    const dotenv = injection.files.find((file) => file.path === SECRET_DOTENV_PATH)?.content ?? "";

    expect(dotenv.match(/export GOOGLE_APPLICATION_CREDENTIALS=/g)).toHaveLength(1);
    expect(dotenv).toContain(
      `export GOOGLE_APPLICATION_CREDENTIALS="${SECRET_FILE_DIR}/GOOGLE_APPLICATION_CREDENTIALS"`,
    );
    expect(dotenv.match(/export GOOGLE_CLOUD_PROJECT=/g)).toHaveLength(1);
    expect(dotenv).toContain("export GOOGLE_CLOUD_PROJECT='explicit-project'");
    expect(dotenv).toContain("export GCLOUD_PROJECT='canonical-project'");
    expect(dotenv).toContain("export CLOUDSDK_CORE_PROJECT='canonical-project'");
    expect(dotenv).not.toContain("GCLOUD_PROJECT='legacy-project'");
  });

  test("a malformed or env-kind legacy GCP value does not invent Google project configuration", () => {
    const malformed = buildInjection({
      secrets: [{ name: "GCP_SERVICE_ACCOUNT_KEY", kind: "file", value: "not-json" }],
      names: ["GCP_SERVICE_ACCOUNT_KEY"],
      skipped: [],
    });
    const envKind = buildInjection({
      secrets: [{ name: "GCP_SERVICE_ACCOUNT_KEY", kind: "env", value: "not-a-file" }],
      names: ["GCP_SERVICE_ACCOUNT_KEY"],
      skipped: [],
    });
    const malformedDotenv = malformed.files.find((file) => file.path === SECRET_DOTENV_PATH)?.content ?? "";
    const envDotenv = envKind.files.find((file) => file.path === SECRET_DOTENV_PATH)?.content ?? "";

    expect(malformedDotenv).toContain("GOOGLE_APPLICATION_CREDENTIALS=");
    expect(malformedDotenv).not.toContain("GOOGLE_CLOUD_PROJECT=");
    expect(envDotenv).not.toContain("GOOGLE_APPLICATION_CREDENTIALS=");
    expect(envDotenv).not.toContain("GOOGLE_CLOUD_PROJECT=");
  });

  test("buildInjection with no secrets → empty createEnv + no files", () => {
    const injection = buildInjection({ secrets: [], names: [], skipped: [] });
    expect(injection.createEnv).toEqual({});
    expect(injection.files).toEqual([]);
  });

  test("buildInjection rejects legacy runtime-control names defensively", () => {
    const injection = buildInjection({
      secrets: [
        { name: "BASH_ENV", kind: "env", value: "/tmp/attacker.sh" },
        { name: "NODE_OPTIONS", kind: "env", value: "--require=/tmp/attacker.js" },
        { name: "SAFE_TOKEN", kind: "env", value: "kept" },
      ],
      names: ["BASH_ENV", "NODE_OPTIONS", "SAFE_TOKEN"],
      skipped: [],
    });
    expect(injection.names).toEqual(["SAFE_TOKEN"]);
    expect(injection.files[0]?.content).toContain("SAFE_TOKEN='kept'");
    expect(injection.files[0]?.content).not.toContain("attacker");
  });

  test("sandbox injection excludes every raw provider credential", () => {
    const injection = buildInjection(
      {
        secrets: [
          { name: "ANTHROPIC_API_KEY", kind: "env", value: "raw-anthropic" },
          { name: "OPENAI_API_KEY", kind: "env", value: "raw-openai" },
          { name: "OPENROUTER_API_KEY", kind: "env", value: "raw-openrouter" },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", kind: "env", value: "raw-claude-oauth" },
          { name: "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", kind: "env", value: "raw-claude-refresh" },
          { name: "ANTHROPIC_FOUNDRY_API_KEY", kind: "env", value: "raw-foundry" },
          { name: "ANTHROPIC_AWS_API_KEY", kind: "env", value: "raw-anthropic-aws" },
          { name: "CODEX_ACCESS_TOKEN", kind: "env", value: "raw-codex" },
          { name: "GCP_SERVICE_ACCOUNT_KEY", kind: "file", value: "raw-gcp" },
          { name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file", value: "raw-google" },
          { name: "CUSTOM_INTEGRATION_TOKEN", kind: "env", value: "kept" },
        ],
        names: [
          "ANTHROPIC_API_KEY",
          "OPENAI_API_KEY",
          "OPENROUTER_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
          "ANTHROPIC_FOUNDRY_API_KEY",
          "ANTHROPIC_AWS_API_KEY",
          "CODEX_ACCESS_TOKEN",
          "GCP_SERVICE_ACCOUNT_KEY",
          "GOOGLE_APPLICATION_CREDENTIALS",
          "CUSTOM_INTEGRATION_TOKEN",
        ],
        skipped: [],
      },
      { excludeNames: PROVIDER_SECRET_NAMES },
    );
    expect(injection.names).toEqual(["CUSTOM_INTEGRATION_TOKEN"]);
    const dotenv = injection.files.find((file) => file.path === SECRET_DOTENV_PATH)?.content ?? "";
    expect(dotenv).toContain("CUSTOM_INTEGRATION_TOKEN='kept'");
    expect(dotenv).not.toContain("raw-anthropic");
    expect(dotenv).not.toContain("raw-openai");
    expect(dotenv).not.toContain("raw-openrouter");
    expect(dotenv).not.toContain("raw-claude-oauth");
    expect(dotenv).not.toContain("raw-claude-refresh");
    expect(dotenv).not.toContain("raw-foundry");
    expect(dotenv).not.toContain("raw-anthropic-aws");
    expect(dotenv).not.toContain("raw-codex");
    expect(dotenv).not.toContain("raw-gcp");
    expect(dotenv).not.toContain("raw-google");
  });

  test("materializeSecretFiles writes each file 0600 via base64, never inline", async () => {
    const cmds: string[] = [];
    const state = await materializeSecretFiles(async (cmd) => {
      cmds.push(cmd);
      return { exitCode: 0, result: "changed" };
    }, [{ path: `${SECRET_FILE_DIR}/PEM`, content: "-----BEGIN KEY-----\nsecret\n-----END KEY-----" }]);

    expect(state).toEqual({ changed: true });
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd).toContain(`mkdir -p -- "${SECRET_FILE_DIR}"`);
    expect(cmd).toContain(`find "${SECRET_FILE_DIR}" -mindepth 1 -maxdepth 1`);
    expect(cmd).toContain(`chmod 600 -- "${SECRET_FILE_DIR}/PEM"`);
    expect(cmd).toContain("base64 -d");
    expect(cmd).toContain("printf unchanged; exit 0");
    expect(cmd).toContain(`sha256sum -- "${SECRET_FILE_DIR}/PEM"`);
    expect(cmd).toContain(`find "${SECRET_FILE_DIR}" -mindepth 1 -maxdepth 1 | wc -l`);
    expect(cmd.indexOf("printf unchanged; exit 0")).toBeLessThan(
      cmd.indexOf(`find "${SECRET_FILE_DIR}" -mindepth 1 -maxdepth 1 -exec rm`),
    );
    // The raw secret content must NOT appear literally on the command line.
    expect(cmd).not.toContain("BEGIN KEY");
    expect(cmd).toContain(Buffer.from("-----BEGIN KEY-----\nsecret\n-----END KEY-----").toString("base64"));
    // Tool-shell delivery: idempotent rc hooks source the dotenv at shell spawn.
    // The hooks run BEFORE the unchanged early-exit so warm sandboxes get them,
    // and the hook line carries no secret material.
    expect(cmd).toContain('"$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshenv"');
    expect(cmd).toContain("grep -qsF 'skynet-env.sh'");
    expect(cmd.indexOf("grep -qsF")).toBeLessThan(cmd.indexOf("printf unchanged; exit 0"));
  });

  test("materializeSecretFiles rejects a non-zero sandbox command result", async () => {
    expect(
      materializeSecretFiles(
        async () => ({ exitCode: 1, result: "mkdir: Permission denied" }),
        [{ path: `${SECRET_FILE_DIR}/PEM`, content: "secret" }],
      ),
    ).rejects.toThrow("secret materialization command exited 1");
  });

  test("materializeSecretFiles reconciles an empty injection and removes stale files", async () => {
    const commands: string[] = [];
    const state = await materializeSecretFiles(async (command) => {
      commands.push(command);
      return { exitCode: 0, result: "changed" };
    }, []);

    expect(state).toEqual({ changed: true });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(`find "${SECRET_FILE_DIR}" -mindepth 1 -maxdepth 1`);
    expect(commands[0]).toContain(`> "${SECRET_DOTENV_PATH}"`);
  });

  test("materializeSecretFiles reports an unchanged secret revision", async () => {
    const state = await materializeSecretFiles(
      async () => ({ exitCode: 0, result: "unchanged" }),
      [{ path: SECRET_DOTENV_PATH, content: "export SAFE='value'\n" }],
    );

    expect(state).toEqual({ changed: false });
  });
});
