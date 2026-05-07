import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { secrets } from "../src/db/schema";
import { decryptOrgSecrets } from "../src/secrets/store";
import {
  buildInjection,
  materializeSecretFiles,
  SECRET_DOTENV_PATH,
  SECRET_FILE_DIR,
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
  });

  test("DELETE of an unknown secret → 404", async () => {
    const del = await json<any>(`/api/secrets/DOES_NOT_EXIST_${Date.now()}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
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
    expect(dotenv?.content).toContain(`export GOOGLE_APPLICATION_CREDENTIALS='${path}'`);
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
    expect(dotenv!.content).toContain(`export SA_JSON='${SECRET_FILE_DIR}/SA_JSON'`);
    // POSIX single-quote escaping keeps an embedded quote intact.
    expect(dotenv!.content).toContain(`export WEIRD='a'\\''b'`);
    // The file-kind content is materialized as its own 0600 file.
    expect(injection.files).toContainEqual({ path: `${SECRET_FILE_DIR}/SA_JSON`, content: '{"k":"v"}' });
  });

  test("buildInjection with no secrets → empty createEnv + no files", () => {
    const injection = buildInjection({ secrets: [], names: [], skipped: [] });
    expect(injection.createEnv).toEqual({});
    expect(injection.files).toEqual([]);
  });

  test("materializeSecretFiles writes each file 0600 via base64, never inline", async () => {
    const cmds: string[] = [];
    await materializeSecretFiles(async (cmd) => {
      cmds.push(cmd);
    }, [{ path: `${SECRET_FILE_DIR}/PEM`, content: "-----BEGIN KEY-----\nsecret\n-----END KEY-----" }]);

    expect(cmds).toHaveLength(1);
    const cmd = cmds[0]!;
    expect(cmd).toContain(`mkdir -p ${SECRET_FILE_DIR}`);
    expect(cmd).toContain(`chmod 600 '${SECRET_FILE_DIR}/PEM'`);
    expect(cmd).toContain("base64 -d");
    // The raw secret content must NOT appear literally on the command line.
    expect(cmd).not.toContain("BEGIN KEY");
    expect(cmd).toContain(Buffer.from("-----BEGIN KEY-----\nsecret\n-----END KEY-----").toString("base64"));
  });

  test("materializeSecretFiles with no files is a no-op (never calls the shell)", async () => {
    let called = 0;
    await materializeSecretFiles(async () => {
      called += 1;
    }, []);
    expect(called).toBe(0);
  });
});
