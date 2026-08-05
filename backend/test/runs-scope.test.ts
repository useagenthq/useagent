import { describe, expect, test } from "bun:test";
import { json } from "./helpers";

// Memory scope at the run-creation boundary (POST /api/runs): the default,
// explicit selection, validation (spec test 9), and reply inheritance (spec
// test 8). Runs use the default `mock` engine so they need no sandbox; only the
// persisted `memory_scope` is asserted (scope is set on the queued row).

async function createRun(body: Record<string, unknown>) {
  return json<{ id: string; error?: string }>("/api/runs", { method: "POST", body });
}
async function getScope(id: string): Promise<string> {
  const { body } = await json<{ memory_scope: string }>(`/api/runs/${id}`);
  return body.memory_scope;
}

describe("memory scope — run creation boundary", () => {
  test("a root run defaults to org scope", async () => {
    const { status, body } = await createRun({ prompt: "hello" });
    expect(status).toBe(201);
    expect(await getScope(body.id)).toBe("org");
  });

  test("an explicit personal scope persists on a root run", async () => {
    const { status, body } = await createRun({ prompt: "hello", memory_scope: "personal" });
    expect(status).toBe(201);
    expect(await getScope(body.id)).toBe("personal");
  });

  test("(9) an invalid scope is rejected 400 — never a silent fallback", async () => {
    const { status, body } = await createRun({ prompt: "hello", memory_scope: "team" });
    expect(status).toBe(400);
    expect(String(body.error)).toContain("memory_scope");
  });

  test("(8) a reply INHERITS its parent's scope when none is given", async () => {
    const root = await createRun({ prompt: "root", memory_scope: "personal" });
    expect(root.status).toBe(201);
    const reply = await createRun({ prompt: "reply", parent_run_id: root.body.id });
    expect(reply.status).toBe(201);
    expect(await getScope(reply.body.id)).toBe("personal");
  });

  test("a reply can OVERRIDE the inherited scope when the user explicitly changes it", async () => {
    const root = await createRun({ prompt: "root" }); // org default
    expect(await getScope(root.body.id)).toBe("org");
    const reply = await createRun({
      prompt: "reply",
      parent_run_id: root.body.id,
      memory_scope: "personal",
    });
    expect(reply.status).toBe(201);
    expect(await getScope(reply.body.id)).toBe("personal");
  });
});
