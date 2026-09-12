import { describe, expect, test } from "bun:test";
import {
  type BoxApiConfig,
  boxPreviewLink,
  boxSandboxProvider,
  boxSandboxState,
  boxTtlSeconds,
  composeBoxCommand,
} from "./box-provider";
import { previewRequestUrl } from "./provider";
import { sandboxProviderConformance } from "./provider-conformance.test-support";
import { memorySandboxLabelStore } from "./sandbox-labels";

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

/** An in-memory Box API: boxes, files, canned command results, hosted ports, cursor pages. */
function fakeBoxApi(initial: FakeBox[] = [], options: { pageSize?: number; archivingPolls?: number } = {}) {
  const boxes = new Map(initial.map((box) => [box.id, { ...box }]));
  const files = new Map<string, Buffer>();
  const requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  let created = 0;
  let archivingPolls = options.archivingPolls ?? 0;
  const commandResults = new Map<string, { stdout?: string; stderr?: string; exitCode?: number | null; timedOut?: boolean }>();
  const commands: string[] = [];

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
    if (method === "GET" && path === "/boxes") {
      const all = [...boxes.values()];
      const size = options.pageSize ?? (all.length || 1);
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : null;
      return json(200, { ok: true, type: "box.list", boxes: page, pageInfo: { nextCursor: next, limit: size } });
    }
    const match = /^\/boxes\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) return json(404, { ok: false, code: "not_found", message: "no route" });
    const box = boxes.get(decodeURIComponent(match[1]!));
    if (!box) return json(404, { ok: false, code: "not_found", message: "no box" });
    const sub = match[2] ?? "";
    if (method === "GET" && sub === "") {
      if (box.state === "provisioning") box.state = "ready";
      if (box.state === "archiving" && archivingPolls-- <= 0) box.state = "archived";
      return json(200, { ok: true, type: "box", box });
    }
    if (method === "POST" && sub === "resume") {
      if (box.state !== "archived") return json(409, { ok: false, code: "box_not_archived", message: "cannot resume" });
      box.state = "ready";
      return json(200, { ok: true, type: "box.resumed", box });
    }
    if (method === "DELETE" && sub === "") {
      boxes.delete(box.id);
      return json(200, { ok: true, type: "box.deleted" });
    }
    if (method === "POST" && sub === "commands") {
      const command = String((body as { command: string }).command);
      commands.push(command);
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

  return { fetchImpl, requests, boxes, files, commandResults, commands };
}

const noSleep = async (): Promise<void> => {};

function provider(api: ReturnType<typeof fakeBoxApi>, overrides: Partial<BoxApiConfig> = {}, labels = memorySandboxLabelStore()) {
  return { provider: boxSandboxProvider({ ...config, ...overrides }, { fetchImpl: api.fetchImpl, labels, sleep: noSleep }), labels };
}

describe("Box sandbox provider", () => {
  sandboxProviderConformance("Box", () => {
    const api = fakeBoxApi([{ id: "bx_existing", state: "archived", vcpu: 2, memoryGB: 4, subdomain: "old" }]);
    return {
      provider: provider(api).provider,
      createOptions: { snapshot: "useagent-runtime" },
      createdId: "bx_1",
      existingId: "bx_existing",
      listedIds: ["bx_existing", "bx_1"],
    };
  });

  test("create maps the contract onto the Box body and keeps labels in the control plane, not the box", async () => {
    const api = fakeBoxApi();
    const { provider: box, labels } = provider(api, { environment: "team-secrets" });
    const sandbox = await box.create({
      snapshot: "useagent-runtime",
      envVars: { RUN_ID: "r1" },
      labels: { "useagent.run": "r1", "useagent.generation": "g7" },
      autoStopInterval: 30,
      autoDeleteInterval: 4320,
    });
    const create = api.requests.find((r) => r.method === "POST" && r.path === "/boxes")!;
    // Box's ttl is absolute (from create/resume), so the DELETE interval bounds the box, never the idle interval.
    expect(create.body).toEqual({ type: "default", ttlSeconds: 4320 * 60, env: { RUN_ID: "r1" }, from: "useagent-runtime", environment: "team-secrets" });
    expect(create.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sandbox.providerKind).toBe("box");
    expect(sandbox.state).toBe("started");
    expect(sandbox.labels).toEqual({ "useagent.run": "r1", "useagent.generation": "g7" });
    expect((await labels.read([sandbox.id])).get(sandbox.id)).toEqual({ "useagent.run": "r1", "useagent.generation": "g7" });
    expect(api.files.size).toBe(0); // nothing about labels is written inside the box
    expect((await box.get(sandbox.id)).labels).toEqual({ "useagent.run": "r1", "useagent.generation": "g7" });
    expect(boxTtlSeconds({ autoDeleteInterval: 0 })).toBeNull();
    expect(boxTtlSeconds({ autoDeleteInterval: 10_000_000 })).toBe(2_592_000);
  });

  test("an archived box keeps its labels through resume, and an archiving box settles before resume", async () => {
    const api = fakeBoxApi([{ id: "bx_a", state: "archiving", vcpu: 4, memoryGB: 8, subdomain: "a" }], { archivingPolls: 2 });
    const labels = memorySandboxLabelStore();
    await labels.write("bx_a", { "useagent.generation": "g7" });
    const sandbox = await provider(api, {}, labels).provider.get("bx_a");
    expect(sandbox.state).toBe("archived");
    expect(sandbox.labels).toEqual({ "useagent.generation": "g7" });
    await sandbox.start();
    expect(sandbox.state).toBe("started");
    expect(sandbox.labels).toEqual({ "useagent.generation": "g7" });
    const resumeIndex = api.requests.findIndex((r) => r.path === "/boxes/bx_a/resume");
    const polls = api.requests.slice(0, resumeIndex).filter((r) => r.method === "GET" && r.path === "/boxes/bx_a").length;
    expect(polls).toBeGreaterThanOrEqual(3); // waited for archiving -> archived before resuming
    await sandbox.delete();
    expect(api.boxes.has("bx_a")).toBe(false);
    expect((await labels.read(["bx_a"])).size).toBe(0);
    expect(boxSandboxState("idle")).toBe("started");
    expect(boxSandboxState("provisioning")).toBe("pending");
    expect(boxSandboxState("error")).toBe("error");
  });

  test("list follows pageInfo.nextCursor and carries labels for every page", async () => {
    const api = fakeBoxApi(
      [1, 2, 3, 4, 5].map((n) => ({ id: `bx_${n}`, state: "ready", vcpu: 4, memoryGB: 8, subdomain: `s${n}` })),
      { pageSize: 2 },
    );
    const labels = memorySandboxLabelStore();
    await labels.write("bx_5", { "skynet-run": "run-5" });
    const box = provider(api, {}, labels).provider;
    const seen: [string, Record<string, string>][] = [];
    for await (const handle of box.list()) seen.push([handle.id, handle.labels ?? {}]);
    expect(seen.map(([id]) => id)).toEqual(["bx_1", "bx_2", "bx_3", "bx_4", "bx_5"]);
    expect(seen.at(-1)?.[1]).toEqual({ "skynet-run": "run-5" });
    expect(api.requests.filter((r) => r.method === "GET" && r.path.startsWith("/boxes?") || r.path === "/boxes").length).toBe(3);
    expect(await box.inventory?.()).toEqual({ activeSandboxes: 5, pausedSandboxes: 0 });
  });

  test("commands carry cwd and env in one shell line; timeouts read as 124; long commands get their directory first", async () => {
    expect(composeBoxCommand("bun test", "/home/user/work", { A: "x y", B: "it's" })).toBe(
      `export A='x y'; export B='it'\\''s'; cd '/home/user/work' && (bun test)`,
    );
    expect(composeBoxCommand("ls")).toBe("(ls)");
    const api = fakeBoxApi([{ id: "bx_c", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "c" }]);
    api.commandResults.set("(false)", { stdout: "", stderr: "nope", exitCode: 1 });
    api.commandResults.set("(sleep 999)", { stdout: "", stderr: "", exitCode: null, timedOut: true });
    const sandbox = await provider(api).provider.get("bx_c");
    expect(await sandbox.process.executeCommand("false")).toEqual({ exitCode: 1, result: "nope" });
    expect(await sandbox.process.executeCommand("sleep 999", undefined, undefined, 5)).toEqual({ exitCode: 124, result: "" });
    // > 600 s: mkdir, script written, detached launcher, exit marker polled
    const long = sandbox.process.executeCommand("make world", "/home/user/work", undefined, 900);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const dir = [...api.files.keys()].find((k) => k.endsWith("/run.sh"))!.replace("bx_c:", "").replace("/run.sh", "");
    expect(api.commands.some((c) => c === `mkdir -p '${dir}'`)).toBe(true);
    api.files.set(`bx_c:${dir}/log`, Buffer.from("built\n"));
    api.files.set(`bx_c:${dir}/exit`, Buffer.from("0\n"));
    expect(await long).toEqual({ exitCode: 0, result: "built\n" });
  });

  test("files round-trip as base64, and hosted ports become origin links whose token rides as a query", async () => {
    const api = fakeBoxApi([{ id: "bx_f", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "slug" }]);
    const sandbox = await provider(api).provider.get("bx_f");
    await sandbox.fs.uploadFile(Buffer.from("héllo\n"), "/home/user/work/a.txt");
    expect((await sandbox.fs.downloadFile("/home/user/work/a.txt")).toString("utf8")).toBe("héllo\n");
    api.commandResults.set("stat -c %s '/home/user/work/a.txt'", { stdout: "7\n", exitCode: 0 });
    expect(await sandbox.fs.getFileDetails("/home/user/work/a.txt")).toEqual({ size: 7 });
    const link = await sandbox.getPreviewLink(4096);
    expect(link).toEqual({ url: "https://slug-4096.on.ascii.dev", token: "tok-4096", query: { _token: "tok-4096" } });
    // the way every consumer builds a request: base + path + its own query, then the link's query
    expect(previewRequestUrl(link, `${link.url}/global/health`)).toBe("https://slug-4096.on.ascii.dev/global/health?_token=tok-4096");
    expect(previewRequestUrl(link, `${link.url}/session?directory=%2Fhome%2Fuser%2Fwork`)).toBe(
      "https://slug-4096.on.ascii.dev/session?directory=%2Fhome%2Fuser%2Fwork&_token=tok-4096",
    );
    expect(previewRequestUrl({}, "https://d.example/x?y=1")).toBe("https://d.example/x?y=1");
    expect(boxPreviewLink("https://slug-80.on.ascii.dev")).toEqual({ url: "https://slug-80.on.ascii.dev" });
  });

  test("session commands run detached in their own process group and deleteSession kills by pid; PTYs are unsupported", async () => {
    const api = fakeBoxApi([{ id: "bx_s", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "s" }]);
    const sandbox = await provider(api).provider.get("bx_s");
    const started = await sandbox.process.executeSessionCommand("sess-1", { command: "echo hi", runAsync: true });
    const launcher = api.commands.find((c) => c.includes(`USEAGENT_COMMAND_ID=${started.cmdId}`))!;
    expect(launcher).toContain("setsid sh");
    expect(launcher).toContain(`echo $! >'/home/user/.useagent/sessions/sess-1/${started.cmdId}.pid'`);
    api.commandResults.set("ls '/home/user/.useagent/sessions/sess-1' 2>/dev/null", { stdout: `${started.cmdId}.pid\n${started.cmdId}.sh\n${started.cmdId}.log\n`, exitCode: 0 });
    expect((await sandbox.process.getSession("sess-1")).commands).toEqual([{ id: started.cmdId }]);
    api.files.set(`bx_s:/home/user/.useagent/sessions/sess-1/${started.cmdId}.log`, Buffer.from("hi\n"));
    expect(await sandbox.process.getSessionCommandLogs("sess-1", started.cmdId)).toEqual({ output: "hi\n", stdout: "hi\n", stderr: "" });
    await sandbox.process.deleteSession("sess-1");
    const kill = api.commands.at(-1)!;
    expect(kill).toContain(`kill -TERM -- "-$p"`);
    expect(kill).toContain("rm -rf '/home/user/.useagent/sessions/sess-1'");
    await expect(sandbox.process.createPty({ id: "t", cols: 80, rows: 24, onData: () => {} })).rejects.toThrow(/interactive terminals/);
  });

  test("API failures surface the Box error code instead of a bare HTTP status", async () => {
    const api = fakeBoxApi();
    await expect(provider(api, { apiKey: "wrong" }).provider.get("bx_1")).rejects.toMatchObject({ name: "BoxApiError", status: 401, code: "unauthorized" });
  });
});
