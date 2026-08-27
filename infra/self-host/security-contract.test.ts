import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const deployUrl = new URL("./deploy-app.sh", import.meta.url);
const deploy = await Bun.file(deployUrl).text();
const cloudInit = await Bun.file(
  new URL("./hetzner/cloud-init.yaml", import.meta.url),
).text();
const variables = await Bun.file(
  new URL("./hetzner/variables.tf", import.meta.url),
).text();
const remoteInvocation = deploy.slice(
  deploy.indexOf('echo "== write env + build + start (remote) =="'),
  deploy.indexOf("<<'REMOTE'"),
);

describe("public self-host security contract", () => {
  test("requires stable production secrets and a public TLS origin", () => {
    expect(deploy).toContain("PUBLIC_ORIGIN=${PUBLIC_ORIGIN:?");
    expect(deploy).toContain("BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:?");
    expect(deploy).toContain("SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY:?");
    expect(deploy).toContain("BETTER_AUTH_URL=${PUBLIC_ORIGIN}");
    expect(deploy).toContain("SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY}");
    expect(deploy).not.toContain("openssl rand");
  });

  test("rejects an insecure public origin before contacting the host", () => {
    const result = spawnSync("bash", [deployUrl.pathname, "."], {
      env: {
        ...process.env,
        SERVER_IP: "192.0.2.1",
        PUBLIC_ORIGIN: "http://useagent.example.com",
        PG_PASSWORD: "database-password",
        PG_GATEWAY_PASSWORD: "gateway-database-password",
        BETTER_AUTH_SECRET: "a".repeat(32),
        SECRETS_ENCRYPTION_KEY: "b".repeat(32),
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("PUBLIC_ORIGIN must be an HTTPS origin");
  });

  test("defaults to production and keeps secrets out of the remote command line", () => {
    expect(deploy).toContain("USEAGENT_DEV_MODE=${USEAGENT_DEV_MODE:-false}");
    expect(deploy).toContain("NODE_ENV=production");
    expect(deploy).toContain("umask 077");
    expect(deploy).toContain(
      "chmod 0600 /etc/useagent/backend.env /etc/useagent/gateway.env",
    );
    expect(deploy).not.toContain("set -x");
    expect(deploy).not.toContain("set -eux");
    expect(remoteInvocation).not.toContain("BETTER_AUTH_SECRET");
    expect(remoteInvocation).not.toContain("SECRETS_ENCRYPTION_KEY");
    expect(remoteInvocation).not.toContain("OPENROUTER_API_KEY");
  });

  test("does not trace rendered database passwords during provisioning", () => {
    expect(cloudInit).toContain("set -euo pipefail");
    expect(cloudInit).not.toContain("set -x");
    expect(cloudInit).not.toContain("set -eux");
    expect(cloudInit).not.toContain("tee /var/log");
    expect(cloudInit).toContain('permissions: "0700"');
  });

  test("requires restricted SSH source ranges", () => {
    expect(variables).toContain("default     = []");
    expect(variables).toContain('cidr != "0.0.0.0/0"');
    expect(variables).toContain('cidr != "::/0"');
  });
});
