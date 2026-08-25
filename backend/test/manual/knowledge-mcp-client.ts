/**
 * MANUAL local proof for Slice A (mem_op.md 0.2). Drives the knowledge gateway
 * with opencode's ACTUAL MCP client library (@modelcontextprotocol/sdk's
 * StreamableHTTPClientTransport) over a REAL HTTP socket — the same client and
 * transport a resident opencode `type:"remote"` MCP server uses. This proves the
 * on-the-wire protocol end to end without a cloud sandbox:
 *   connect → initialize → tools/list → tools/call knowledge_search → cited hit,
 *   and a run-scoped bearer token in requestInit.headers (exactly what opencode's
 *   `headers` config becomes).
 *
 * Run against the isolated test DB:
 *   DATABASE_URL=postgres://postgres@localhost:5432/useagent_test \
 *     bun run test/prepare-db.ts && \
 *   DATABASE_URL=postgres://postgres@localhost:5432/useagent_test \
 *     bun run test/manual/knowledge-mcp-client.ts
 */
process.env.DATABASE_URL ??= "postgres://postgres@localhost:5432/useagent_test";
process.env.USEAGENT_DEV_MODE = "true";

import server from "../../src/index";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../../src/db/client";
import { runs } from "../../src/db/schema";
import { ingestOne } from "../../src/knowledge/ingest";
import { mintToolToken } from "../../src/knowledge/gateway/token";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const org = `mcpcli-${crypto.randomUUID().slice(0, 8)}`;
const canary = `zeta${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

const ing = await ingestOne({
  org_id: org,
  user_id: "u-cli",
  meta: { source_type: "document", external_id: "cli-1", connector_instance_id: "cli:test", source_url: "https://ex/cli" },
  text: `Runbook ${canary}: to restart the ingestion worker run 'skynet worker restart'. Unique fact ${canary}.`,
});
console.log(`seeded org=${org} record=${ing.id} canary=${canary}`);

const runId = `run-${crypto.randomUUID().slice(0, 8)}`;
await db.insert(runs).values({
  id: runId,
  orgId: org,
  userId: "u-cli",
  prompt: "ask",
  model: "claude-haiku-4-5",
  engine: "opencode",
  status: "running",
  threadId: runId,
});
const token = mintToolToken({ orgId: org, userId: "u-cli", threadId: runId, runId }, 60_000);

// Bind the REAL app on an ephemeral port so the SDK client makes genuine HTTP.
const srv = Bun.serve({ port: 0, fetch: server.fetch, idleTimeout: 30 });
const url = `http://localhost:${srv.port}/api/mcp/knowledge`;
console.log(`gateway at ${url}`);

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "skynet-proof", version: "1.0.0" });

try {
  await client.connect(transport); // initialize handshake over the wire
  check("MCP client connected (initialize handshake succeeded)", true);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  check(
    "tools/list returns knowledge search/read plus artifact publishing",
    ["artifact_publish", "knowledge_read", "knowledge_search"].every((name) => names.includes(name)),
    names.join(","),
  );

  const res = (await client.callTool({ name: "knowledge_search", arguments: { query: `${canary} restart worker` } })) as {
    content: { type: string; text: string }[];
    structuredContent?: { results?: { id: string; citation: string }[] };
  };
  const text = res.content.map((c) => c.text).join("\n");
  check("knowledge_search returned the seeded fact", text.includes(canary), text.slice(0, 80));
  const results = res.structuredContent?.results ?? [];
  check("result carries the stable id + citation", results.some((r) => r.id === ing.id && r.citation === "https://ex/cli"));

  // A rejected token must fail the client (fail closed).
  const badTransport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: "Bearer garbage.token.here" } },
  });
  const badClient = new Client({ name: "bad", version: "1" });
  let rejected = false;
  try {
    await badClient.connect(badTransport);
  } catch {
    rejected = true;
  }
  check("a forged token is rejected by the gateway (fail closed)", rejected);
  await badClient.close().catch(() => {});
} finally {
  await client.close().catch(() => {});
  srv.stop(true);
}

console.log(failures === 0 ? "\n✅ MCP-CLIENT PROOF PASSED" : `\n❌ MCP-CLIENT PROOF FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
