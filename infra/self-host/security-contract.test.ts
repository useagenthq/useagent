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
const bootstrap = await Bun.file(
  new URL("../../backend/scripts/bootstrap-admin.ts", import.meta.url),
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
    expect(deploy).toContain("USEAGENT_OPERATOR_SECRET=${USEAGENT_OPERATOR_SECRET:?");
    expect(deploy).toContain("BETTER_AUTH_URL=${PUBLIC_ORIGIN}");
    expect(deploy).toContain("SECRETS_ENCRYPTION_KEY=${SECRETS_ENCRYPTION_KEY}");
    expect(deploy).toContain("USEAGENT_OPERATOR_SECRET=${USEAGENT_OPERATOR_SECRET}");
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
        USEAGENT_OPERATOR_SECRET: "c".repeat(32),
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
    expect(remoteInvocation).not.toContain("USEAGENT_OPERATOR_SECRET");
    expect(remoteInvocation).not.toContain("OPENROUTER_API_KEY");
  });

  test("does not trace rendered database passwords during provisioning", () => {
    expect(cloudInit).toContain("set -euo pipefail");
    expect(cloudInit).not.toContain("set -x");
    expect(cloudInit).not.toContain("set -eux");
    expect(cloudInit).not.toContain("tee /var/log");
    expect(cloudInit).toContain('permissions: "0700"');
    const rendered = cloudInit
      .replaceAll("${postgres_password}", "owner-password-sentinel")
      .replaceAll("${gateway_postgres_password}", "gateway-password-sentinel");
    const passwordLines = rendered
      .split("\n")
      .filter((line) => line.includes("password-sentinel"));
    expect(passwordLines).toHaveLength(2);
    expect(passwordLines.every((line) => line.trimStart().startsWith("ALTER ROLE"))).toBe(true);
    expect(rendered).toContain('psql -v ON_ERROR_STOP=1 -f "$password_sql"');
  });

  test("requires restricted SSH source ranges", () => {
    expect(variables).toContain("default     = []");
    expect(variables).toContain("can(cidrhost(cidr, 0))");
    expect(variables).toContain('tonumber(regex("/([0-9]+)$", cidr)[0])');
  });

  test("bootstraps the first user through Better Auth without weakening the backend", () => {
    expect(bootstrap).toContain('process.env.NODE_ENV = "development"');
    expect(bootstrap).toContain('process.env.USEAGENT_DEV_MODE = "true"');
    expect(bootstrap).toContain("auth.api.signUpEmail");
    expect(bootstrap).toContain("where(eq(user.email, email))");
    expect(bootstrap).toContain('membership?.role !== "owner"');
    expect(deploy).toContain("useagent-bootstrap-admin.service");
    expect(deploy).toContain("rm -f /etc/useagent/bootstrap-admin.env");
  });

  test("requires active services and bounded local plus public health checks", () => {
    expect(deploy).toContain("for attempt in $(seq 1 10)");
    expect(deploy).toContain("systemctl is-active --quiet");
    expect(deploy).toContain("health_check http://localhost:3201/api/health backend");
    expect(deploy).toContain('health_check "https://${PUBLIC_DOMAIN}/api/health" public-https');
    expect(deploy).not.toContain("status useagent-backend useagent-frontend || true");
  });
});
