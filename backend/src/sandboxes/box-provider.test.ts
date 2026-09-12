import { describe, expect, test } from "bun:test";
import {
  type BoxApiConfig,
  boxPreviewLink,
  boxSandboxProvider,
  boxSandboxState,
  composeBoxCommand,
} from "./box-provider";
import { sandboxProviderConformance } from "./provider-conformance.test-support";

const config: BoxApiConfig = {
  apiKey: "box_test_key",
  apiUrl: "https://box.example.test/api/box/v1",
  machineType: "default",
};

interface FakeBox {
  id: string;
  state: string;
  vcpu: number;
  memoryGB: number;
  subdomain: string;
}

/** An in-memory Box API: boxes, files, canned command results, hosted ports. */
function fakeBoxApi(initial: FakeBox[] = []) {
  const boxes = new Map(initial.map((box) => [box.id, { ...box }]));
  const files = new Map<string, Buffer>();
  const requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  let created = 0;
  const commandResults = new Map<string, { stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean }>();

  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname.replace("/api/box/v1", "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    requests.push({ method, path: `${path}${url.search}`, body, headers });
    if (headers.Authorization !== `Bearer ${config.apiKey}`) return json(401, { ok: false, code: "unauthorized", message: "bad key" });

    if (method === "POST" && path === "/boxes") {
      created += 1;
      const id = `bx_${created}`;
      boxes.set(id, { id, state: created === 1 ? "provisioning" : "ready", vcpu: 4, memoryGB: 8, subdomain: `slug-${created}` });
      return json(200, { ok: true, type: "box.created", box: boxes.get(id) });
    }
    if (method === "GET" && path === "/boxes") return json(200, { ok: true, type: "box.list", boxes: [...boxes.values()] });
    const match = /^\/boxes\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) return json(404, { ok: false, code: "not_found", message: "no route" });
    const box = boxes.get(decodeURIComponent(match[1]!));
    if (!box) return json(404, { ok: false, code: "not_found", message: "no box" });
    const sub = match[2] ?? "";
    if (method === "GET" && sub === "") {
      // a freshly provisioned box becomes ready on the second poll
      if (box.state === "provisioning") box.state = "ready";
      return json(200, { ok: true, type: "box", box });
    }
    if (method === "POST" && sub === "resume") {
      box.state = "ready";
      return json(200, { ok: true, type: "box.resumed", box });
    }
    if (method === "DELETE" && sub === "") {
      boxes.delete(box.id);
      return json(200, { ok: true, type: "box.deleted" });
    }
    if (method === "POST" && sub === "commands") {
      const command = String((body as { command: string }).command);
      const canned = commandResults.get(command) ?? { stdout: `ran: ${command}`, stderr: "", exitCode: 0 };
      if ((body as { detached?: boolean }).detached) return json(200, { ok: true, type: "command.started", processId: 1 });
      return json(200, { ok: true, type: "command.finished", ...canned });
    }
    if (method === "PUT" && sub === "files") {
      const { path: filePath, content, encoding } = body as { path: string; content: string; encoding: string };
      files.set(`${box.id}:${filePath}`, Buffer.from(content, encoding === "base64" ? "base64" : "utf8"));
      return json(200, { ok: true, type: "file.written", path: filePath, size: content.length });
    }
    if (method === "GET" && sub === "files") {
      const filePath = url.searchParams.get("path") ?? "";
      const content = files.get(`${box.id}:${filePath}`);
      if (!content) return json(400, { ok: false, code: "invalid_path", message: "missing" });
      return json(200, { ok: true, type: "file", content: content.toString("base64"), encoding: "base64", size: content.length });
    }
    if (method === "POST" && sub === "host") {
      const port = (body as { port: number }).port;
      return json(200, { ok: true, type: "host.created", url: `https://${box.subdomain}-${port}.on.ascii.dev?_token=tok-${port}`, isProtected: true });
    }
    return json(404, { ok: false, code: "not_found", message: `no route ${method} ${path}` });
  };

  return { fetchImpl, requests, boxes, files, commandResults };
}

describe("Box sandbox provider", () => {
  sandboxProviderConformance("Box", () => {
    const api = fakeBoxApi([{ id: "bx_existing", state: "archived", vcpu: 2, memoryGB: 4, subdomain: "old" }]);
    return {
      provider: boxSandboxProvider(config, api.fetchImpl),
      createOptions: { snapshot: "useagent-runtime" },
      createdId: "bx_1",
      existingId: "bx_existing",
      listedIds: ["bx_existing", "bx_1"],
    };
  });

  test("create maps the contract onto the Box body, waits for ready, and persists labels in the box", async () => {
    const api = fakeBoxApi();
    const provider = boxSandboxProvider({ ...config, environment: "team-secrets" }, api.fetchImpl);
    const sandbox = await provider.create({
      snapshot: "useagent-runtime",
      envVars: { RUN_ID: "r1" },
      labels: { "useagent.run": "r1" },
      autoStopInterval: 30,
      autoDeleteInterval: 4320,
    });
    const create = api.requests.find((r) => r.method === "POST" && r.path === "/boxes")!;
    expect(create.body).toEqual({ type: "default", ttlSeconds: 1800, env: { RUN_ID: "r1" }, from: "useagent-runtime", environment: "team-secrets" });
    expect(create.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sandbox.state).toBe("started");
    expect(sandbox.cpu).toBe(4);
    expect(sandbox.memory).toBe(8);
    expect(sandbox.labels).toEqual({ "useagent.run": "r1" });
    // labels round-trip through the box's own filesystem on a later get()
    const again = await provider.get(sandbox.id);
    expect(again.labels).toEqual({ "useagent.run": "r1" });
  });

  test("maps Box lifecycle onto the states the engines expect and resumes archived boxes", async () => {
    expect(boxSandboxState("idle")).toBe("started");
    expect(boxSandboxState("running")).toBe("started");
    expect(boxSandboxState("archived")).toBe("archived");
    expect(boxSandboxState("provisioning")).toBe("pending");
    expect(boxSandboxState("error")).toBe("error");
    const api = fakeBoxApi([{ id: "bx_a", state: "archived", vcpu: 4, memoryGB: 8, subdomain: "a" }]);
    const sandbox = await boxSandboxProvider(config, api.fetchImpl).get("bx_a");
    expect(sandbox.state).toBe("archived");
    await sandbox.start();
    expect(sandbox.state).toBe("started");
    expect(api.requests.some((r) => r.method === "POST" && r.path === "/boxes/bx_a/resume")).toBe(true);
    await sandbox.delete();
    expect(api.boxes.has("bx_a")).toBe(false);
  });

  test("commands carry cwd and env in one shell line and report exit codes; timeouts read as 124", async () => {
    expect(composeBoxCommand("bun test", "/home/user/work", { A: "x y", B: "it's" })).toBe(
      `export A='x y'; export B='it'\\''s'; cd '/home/user/work' && (bun test)`,
    );
    expect(composeBoxCommand("ls")).toBe("(ls)");
    const api = fakeBoxApi([{ id: "bx_c", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "c" }]);
    api.commandResults.set("(false)", { stdout: "", stderr: "nope", exitCode: 1 });
    api.commandResults.set("(sleep 999)", { stdout: "", stderr: "", exitCode: null, timedOut: true });
    const sandbox = await boxSandboxProvider(config, api.fetchImpl).get("bx_c");
    expect(await sandbox.process.executeCommand("false")).toEqual({ exitCode: 1, result: "nope" });
    expect(await sandbox.process.executeCommand("sleep 999", undefined, undefined, 5)).toEqual({ exitCode: 124, result: "" });
    const sent = api.requests.filter((r) => r.path === "/boxes/bx_c/commands").map((r) => r.body as { timeoutSeconds: number });
    expect(sent.map((b) => b.timeoutSeconds)).toEqual([600, 5]);
  });

  test("files round-trip as base64 and hosted ports become preview links with their token", async () => {
    const api = fakeBoxApi([{ id: "bx_f", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "slug" }]);
    const sandbox = await boxSandboxProvider(config, api.fetchImpl).get("bx_f");
    await sandbox.fs.uploadFile(Buffer.from("héllo\n"), "/home/user/work/a.txt");
    expect((await sandbox.fs.downloadFile("/home/user/work/a.txt")).toString("utf8")).toBe("héllo\n");
    api.commandResults.set("stat -c %s '/home/user/work/a.txt'", { stdout: "7\n", exitCode: 0 });
    expect(await sandbox.fs.getFileDetails("/home/user/work/a.txt")).toEqual({ size: 7 });
    expect(await sandbox.getPreviewLink(4096)).toEqual({ url: "https://slug-4096.on.ascii.dev?_token=tok-4096", token: "tok-4096" });
    expect(boxPreviewLink("https://slug-80.on.ascii.dev")).toEqual({ url: "https://slug-80.on.ascii.dev" });
  });

  test("async session commands run detached with their logs readable; PTYs are honestly unsupported", async () => {
    const api = fakeBoxApi([{ id: "bx_s", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "s" }]);
    const sandbox = await boxSandboxProvider(config, api.fetchImpl).get("bx_s");
    const started = await sandbox.process.executeSessionCommand("sess-1", { command: "echo hi", runAsync: true });
    expect(started.exitCode).toBe(0);
    expect((await sandbox.process.getSession("sess-1")).commands).toEqual([{ id: started.cmdId }]);
    const detached = api.requests.find((r) => r.path === "/boxes/bx_s/commands" && (r.body as { detached?: boolean }).detached)!;
    expect(String((detached.body as { command: string }).command)).toContain(`USEAGENT_COMMAND_ID=${started.cmdId}`);
    api.files.set(`bx_s:/home/user/.useagent/sessions/sess-1/${started.cmdId}.log`, Buffer.from("hi\n"));
    expect(await sandbox.process.getSessionCommandLogs("sess-1", started.cmdId)).toEqual({ output: "hi\n", stdout: "hi\n", stderr: "" });
    await expect(
      sandbox.process.createPty({ id: "t", cols: 80, rows: 24, onData: () => {} }),
    ).rejects.toThrow(/interactive terminals/);
  });

  test("API failures surface the Box error code instead of a bare HTTP status", async () => {
    const api = fakeBoxApi();
    const provider = boxSandboxProvider({ ...config, apiKey: "wrong" }, api.fetchImpl);
    await expect(provider.get("bx_1")).rejects.toMatchObject({ name: "BoxApiError", status: 401, code: "unauthorized" });
  });
});
