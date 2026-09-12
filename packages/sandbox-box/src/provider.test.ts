import { describe, expect, test } from "bun:test";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type BoxApiConfig,
  type BoxProviderOptions,
  boxCliProblem,
  boxPreviewLink,
  boxPtyBootstrapCommand,
  boxPtyEnv,
  boxPtyHandle,
  boxPtyKeygenArgv,
  boxPtyLoginArgv,
  boxPtyReadyGate,
  boxPtySshArgv,
  boxSandboxProvider,
  createBoxPtyHome,
  parsePortAuthCookie,
  removeBoxPtyHome,
  boxSandboxState,
  boxTtlSeconds,
  composeBoxCommand,
} from "./provider";
import { sandboxProviderConformance } from "@useagent/sandbox-contract/conformance";
import {
  SandboxNotFoundError,
  isSandboxTerminalUnavailableError,
  memorySandboxLabelStore,
} from "@useagent/sandbox-contract";

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
function fakeBoxApi(
  initial: FakeBox[] = [],
  options: {
    pageSize?: number;
    archivingPolls?: number;
    createState?: string;
    desktopProvisioningPolls?: number;
    failDetached?: boolean;
    failWriteSuffix?: string;
    missingDetachedLog?: boolean;
  } = {},
) {
  const boxes = new Map(initial.map((box) => [box.id, { ...box }]));
  const files = new Map<string, Buffer>();
  const requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  let created = 0;
  let archivingPolls = options.archivingPolls ?? 0;
  let desktopProvisioningPolls = options.desktopProvisioningPolls ?? 0;
  const commandResults = new Map<string, {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    timedOut?: boolean;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  }>();
  const commands: string[] = [];
  const namedSnapshots = new Map<string, { name: string; status: "saving" | "ready"; sourceBoxId: string }>();

  const json = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (url.host.endsWith(".on.ascii.dev")) {
      // hosted port: the _token visit answers 302 + the port-auth cookie; anything else is refused
      const port = url.host.split(".")[0]!.split("-").at(-1);
      if (url.searchParams.get("_token") !== `tok-${port}`) return new Response("Access denied", { status: 403 });
      return new Response('<a href="/">Found</a>', { status: 302, headers: { location: "/", "set-cookie": `_port_auth=cookie-${port}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=None` } });
    }
    const path = url.pathname.replace("/api/box/v1", "");
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    requests.push({ method, path: `${path}${url.search}`, body, headers });
    if (headers.Authorization !== `Bearer ${config.apiKey}`) return json(401, { ok: false, code: "unauthorized", message: "bad key" });

    if (method === "POST" && path === "/boxes") {
      created += 1;
      const id = `bx_${created}`;
      boxes.set(id, { id, state: options.createState ?? (created === 1 ? "provisioning" : "ready"), vcpu: 4, memoryGB: 8, subdomain: `slug-${created}` });
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
    if (method === "POST" && path === "/named-snapshots") {
      const snapshot = {
        name: String(body?.name),
        status: "saving" as const,
        sourceBoxId: String(body?.boxId),
      };
      namedSnapshots.set(snapshot.name, snapshot);
      return json(202, { ok: true, type: "snapshot.named.saving", snapshot });
    }
    const namedSnapshot = /^\/named-snapshots\/([^/]+)$/.exec(path);
    if (method === "GET" && namedSnapshot) {
      const name = decodeURIComponent(namedSnapshot[1]!);
      const snapshot = namedSnapshots.get(name);
      if (!snapshot) return json(404, { ok: false, code: "not_found", message: "no snapshot" });
      snapshot.status = "ready";
      return json(200, { ok: true, type: "snapshot.named.info", snapshot });
    }
    const match = /^\/boxes\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) return json(404, { ok: false, code: "not_found", message: "no route" });
    const box = boxes.get(decodeURIComponent(match[1]!));
    if (!box) return json(404, { ok: false, code: "not_found", message: "no box" });
    const sub = match[2] ?? "";
    if (method === "GET" && sub === "") {
      if (box.state === "provisioning") box.state = "ready";
      if (box.state === "failing") box.state = "error";
      if (box.state === "archiving" && archivingPolls-- <= 0) box.state = "archived";
      return json(200, { ok: true, type: "box", box });
    }
    if (method === "POST" && sub === "resume") {
      if (box.state !== "archived") return json(409, { ok: false, code: "box_not_archived", message: "cannot resume" });
      box.state = "ready";
      return json(200, { ok: true, type: "box.resumed", box });
    }
    if (method === "DELETE" && sub === "") {
      if (headers["X-Ascii-Confirm-Delete"] !== box.id) return json(409, { ok: false, code: "delete_confirmation_required", message: "Set X-Ascii-Confirm-Delete" });
      boxes.delete(box.id);
      return json(200, { ok: true, type: "box.deleted" });
    }
    if (method === "POST" && sub === "commands") {
      const command = String((body as { command: string }).command);
      commands.push(command);
      const canned = commandResults.get(command) ?? { stdout: `ran: ${command}`, stderr: "", exitCode: 0 };
      if ((body as { detached?: boolean }).detached) {
        if (options.failDetached) {
          return json(503, { ok: false, code: "detach_failed", message: "detach failed" });
        }
        return json(200, { ok: true, type: "command.started", processId: 1 });
      }
      return json(200, { ok: true, type: "command.finished", ...canned });
    }
    if (method === "POST" && sub === "desktop") {
      if (desktopProvisioningPolls-- > 0) {
        return json(200, {
          ok: true,
          type: "desktop.url",
          provisioning: true,
          desktopUrl: null,
        });
      }
      return json(200, {
        ok: true,
        type: "desktop.url",
        provisioning: false,
        desktopUrl:
          `https://${box.subdomain}-6080.on.ascii.dev/vnc.html?` +
          "autoconnect=true&reconnect=true&resize=scale&path=websockify&" +
          "password=box-vnc-password&_token=tok-6080",
      });
    }
    if (method === "PUT" && sub === "files") {
      const { path: filePath, content, encoding } = body as { path: string; content: string; encoding: string };
      if (options.failWriteSuffix && filePath.endsWith(options.failWriteSuffix)) {
        return json(503, { ok: false, code: "write_failed", message: "write failed" });
      }
      files.set(`${box.id}:${filePath}`, Buffer.from(content, encoding === "base64" ? "base64" : "utf8"));
      return json(200, { ok: true, type: "file.written", path: filePath, size: content.length });
    }
    if (method === "GET" && sub === "files") {
      const filePath = url.searchParams.get("path") ?? "";
      const content = files.get(`${box.id}:${filePath}`) ??
        (!options.missingDetachedLog && filePath.endsWith("/log") ? Buffer.alloc(0) : undefined);
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

// Yields to the event loop (so test timers fire) without waiting for real poll intervals.
const noSleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function provider(
  api: ReturnType<typeof fakeBoxApi>,
  overrides: Partial<BoxApiConfig> = {},
  labels = memorySandboxLabelStore(),
  options: Pick<BoxProviderOptions, "now" | "sleep"> = {},
) {
  return {
    provider: boxSandboxProvider(
      { ...config, ...overrides },
      {
        fetchImpl: api.fetchImpl,
        labels,
        sleep: options.sleep ?? noSleep,
        now: options.now,
      },
    ),
    labels,
  };
}

describe("Box sandbox provider", () => {
  test("translates only a missing top-level box record into the neutral absence error", async () => {
    const api = fakeBoxApi([]);
    await expect(provider(api).provider.get("bx_missing")).rejects
      .toBeInstanceOf(SandboxNotFoundError);
  });

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

  test("saves a ready named template from a prepared box", async () => {
    const api = fakeBoxApi([{ id: "bx_source", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "source" }]);
    const box = provider(api).provider;
    expect(await box.saveTemplate?.("bx_source", "useagent-opencode-1-18-7")).toEqual({
      name: "useagent-opencode-1-18-7",
      state: "active",
    });
    expect(api.requests.some((request) =>
      request.method === "POST" &&
      request.path === "/named-snapshots" &&
      (request.body as { boxId?: string }).boxId === "bx_source"
    )).toBe(true);
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
    // A production-sized 300 s install must not depend on the hosted sync request.
    const long = sandbox.process.executeCommand("make world", "/home/user/work", undefined, 300);
    let runScript = [...api.files.keys()].find((key) => key.endsWith("/run.sh"));
    for (let attempt = 0; !runScript && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      runScript = [...api.files.keys()].find((key) => key.endsWith("/run.sh"));
    }
    expect(runScript).toBeDefined();
    const dir = runScript!.replace("bx_c:", "").replace(/\/run\.sh$/, "");
    expect(api.commands.some((c) => c === `mkdir -p '${dir}'`)).toBe(true);
    const launchScript = api.files.get(`bx_c:${dir}/launch.sh`)?.toString("utf8") ?? "";
    expect(Bun.spawnSync(["sh", "-n"], { stdin: Buffer.from(launchScript) }).exitCode).toBe(0);
    expect(launchScript).toContain("timeout --foreground --signal=TERM --kill-after=5s 300s");
    expect(launchScript).not.toContain("make world");
    api.files.set(`bx_c:${dir}/log`, Buffer.from("built\n"));
    api.files.set(`bx_c:${dir}/exit`, Buffer.from("0\n"));
    expect(await long).toEqual({ exitCode: 0, result: "built\n" });
    expect(api.commands).toContain(`rm -rf '${dir}'`);
    expect(api.commands.some((command) => command.includes("kill -TERM"))).toBe(false);
  });

  test("sync command truncation is an explicit failure and is never returned as partial success", async () => {
    const api = fakeBoxApi([{ id: "bx_truncated", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "truncated" }]);
    const sandbox = await provider(api).provider.get("bx_truncated");
    for (const stream of ["stdout", "stderr"] as const) {
      const command = `large ${stream}`;
      api.commandResults.set(`(${command})`, {
        stdout: stream === "stdout" ? "partial" : "",
        stderr: stream === "stderr" ? "partial" : "",
        exitCode: 0,
        ...(stream === "stdout" ? { stdoutTruncated: true } : { stderrTruncated: true }),
      });
      await expect(sandbox.process.executeCommand(command, undefined, undefined, 10))
        .rejects.toMatchObject({ code: "command_output_truncated" });
      expect(api.commands.filter((candidate) => candidate === `(${command})`)).toHaveLength(1);
    }
  });

  test("a completed detached command with an unreadable log fails instead of becoming empty success", async () => {
    const api = fakeBoxApi(
      [{ id: "bx_missing_log", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "missing-log" }],
      { missingDetachedLog: true },
    );
    const sandbox = await provider(api).provider.get("bx_missing_log");
    const pending = sandbox.process.executeCommand("build output", undefined, undefined, 300);
    let runScript = [...api.files.keys()].find((key) => key.endsWith("/run.sh"));
    for (let attempt = 0; !runScript && attempt < 100; attempt += 1) {
      await Bun.sleep(1);
      runScript = [...api.files.keys()].find((key) => key.endsWith("/run.sh"));
    }
    const dir = runScript!.replace("bx_missing_log:", "").replace(/\/run\.sh$/, "");
    api.files.set(`bx_missing_log:${dir}/exit`, Buffer.from("0\n"));

    await expect(pending).rejects.toMatchObject({ code: "invalid_path" });
  });

  test("long command timeout stops its process group before cleanup", async () => {
    let now = 0;
    const api = fakeBoxApi([
      { id: "bx_timeout", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "timeout" },
    ]);
    const sandbox = await provider(api, {}, memorySandboxLabelStore(), {
      now: () => now,
      sleep: async () => { now += 31_000; },
    }).provider.get("bx_timeout");

    expect(await sandbox.process.executeCommand("sleep forever", undefined, undefined, 31))
      .toEqual({ exitCode: 124, result: "" });
    const stop = api.commands.findIndex((command) => command.includes("kill -TERM"));
    const cleanup = api.commands.findIndex((command) => command.startsWith("rm -rf "));
    expect(stop).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(stop);
  });

  test("a remote timeout marker still terminates surviving descendants", async () => {
    const api = fakeBoxApi([
      { id: "bx_remote_timeout", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "remote-timeout" },
    ]);
    const sandbox = await provider(api).provider.get("bx_remote_timeout");
    const pending = sandbox.process.executeCommand("spawn grandchild", undefined, undefined, 300);
    let runScript = [...api.files.keys()].find((key) => key.endsWith("/run.sh"));
    for (let attempt = 0; !runScript && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      runScript = [...api.files.keys()].find((key) => key.endsWith("/run.sh"));
    }
    expect(runScript).toBeDefined();
    const dir = runScript!.replace("bx_remote_timeout:", "").replace(/\/run\.sh$/, "");
    api.files.set(`bx_remote_timeout:${dir}/pid`, Buffer.from("4321\n"));
    api.files.set(`bx_remote_timeout:${dir}/exit`, Buffer.from("124\n"));

    expect(await pending).toEqual({ exitCode: 124, result: "" });
    const stop = api.commands.findIndex((command) => command.includes("kill -TERM"));
    const cleanup = api.commands.findIndex((command) => command.startsWith("rm -rf "));
    expect(stop).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(stop);
  });

  test("long command setup failures still remove their private command directory", async () => {
    for (const failure of ["write", "detach"] as const) {
      const api = fakeBoxApi(
        [{ id: `bx_${failure}`, state: "ready", vcpu: 4, memoryGB: 8, subdomain: failure }],
        failure === "write" ? { failWriteSuffix: "/run.sh" } : { failDetached: true },
      );
      const sandbox = await provider(api).provider.get(`bx_${failure}`);

      await expect(sandbox.process.executeCommand("private command", undefined, undefined, 300))
        .rejects.toThrow(`${failure} failed`);
      expect(api.commands.some((command) => command.startsWith("rm -rf "))).toBe(true);
      expect(api.commands.some((command) => command.includes("kill -TERM")))
        .toBe(failure === "detach");
      if (failure === "detach") {
        const stop = api.commands.find((command) => command.includes("kill -TERM")) ?? "";
        expect(stop).toContain("while ! test -s");
        expect(stop).toContain("/pid");
        expect(stop).toContain("/exit");
      }
    }
  });

  test("files round-trip as base64, and hosted ports become origin links carrying the port-auth cookie", async () => {
    const api = fakeBoxApi(
      [{ id: "bx_f", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "slug" }],
      { desktopProvisioningPolls: 1 },
    );
    const sandbox = await provider(api).provider.get("bx_f");
    await sandbox.fs.uploadFile(Buffer.from("héllo\n"), "/home/user/work/a.txt");
    expect((await sandbox.fs.downloadFile("/home/user/work/a.txt")).toString("utf8")).toBe("héllo\n");
    api.commandResults.set("stat -c %s '/home/user/work/a.txt'", { stdout: "7\n", exitCode: 0 });
    expect(await sandbox.fs.getFileDetails("/home/user/work/a.txt")).toEqual({ size: 7 });
    const link = await sandbox.getPreviewLink(4096);
    // the _token is exchanged once for the port-auth cookie; consumers send only the cookie header
    expect(link).toEqual({ url: "https://slug-4096.on.ascii.dev", token: "cookie-4096", headers: { cookie: "_port_auth=cookie-4096" } });
    const visit = api.requests.length; // the exchange is not an API request
    expect(api.requests.slice(visit - 1)[0]?.path).toBe("/boxes/bx_f/host");
    expect(parsePortAuthCookie("_port_auth=abc; Path=/; HttpOnly")).toBe("abc");
    expect(parsePortAuthCookie("other=1, _port_auth=def; Path=/")).toBe("def");
    expect(parsePortAuthCookie(null)).toBeNull();
    expect(boxPreviewLink("https://slug-80.on.ascii.dev", null)).toEqual({ url: "https://slug-80.on.ascii.dev" });

    expect(sandbox.desktop).toMatchObject({
      display: ":0",
      home: "/home/user",
      workdir: "/home/user/work",
    });
    await sandbox.desktop?.start();
    expect(await sandbox.getPreviewLink(6080)).toEqual({
      url: "https://slug-6080.on.ascii.dev",
      token: "cookie-6080",
      headers: { cookie: "_port_auth=cookie-6080" },
      clientQuery: { password: "box-vnc-password" },
    });
    expect(
      api.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path === "/boxes/bx_f/desktop?vnc=1",
      ),
    ).toHaveLength(3);
    expect(
      api.requests.some(
        (request) =>
          request.path === "/boxes/bx_f/host" &&
          (request.body as { port?: number }).port === 6080,
      ),
    ).toBe(false);
  });

  test("session commands run detached in their own process group and deleteSession kills by pid", async () => {
    const api = fakeBoxApi([{ id: "bx_s", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "s" }]);
    const sandbox = await provider(api).provider.get("bx_s");
    const started = await sandbox.process.executeSessionCommand("sess-1", { command: "echo hi", runAsync: true });
    const base = `/home/user/.useagent/sessions/sess-1/${started.cmdId}`;
    expect(api.commands.at(-1)).toBe(
      `cd '/home/user' && nohup setsid sh '${base}.launch.sh' </dev/null >'${base}.log' 2>&1 &`,
    );
    expect(api.files.get(`bx_s:${base}.launch.sh`)?.toString("utf8")).toBe(
      `echo $$ >'${base}.pid'\nexport USEAGENT_SESSION_ID='sess-1' USEAGENT_COMMAND_ID='${started.cmdId}'\nexec sh '${base}.sh'\n`,
    );
    expect(api.files.get(`bx_s:${base}.sh`)?.toString("utf8")).toBe("echo hi");
    api.commandResults.set("ls '/home/user/.useagent/sessions/sess-1' 2>/dev/null", { stdout: `${started.cmdId}.pid\n${started.cmdId}.sh\n${started.cmdId}.log\n`, exitCode: 0 });
    expect((await sandbox.process.getSession("sess-1")).commands).toEqual([{ id: started.cmdId }]);
    api.files.set(`bx_s:/home/user/.useagent/sessions/sess-1/${started.cmdId}.log`, Buffer.from("hi\n"));
    expect(await sandbox.process.getSessionCommandLogs("sess-1", started.cmdId)).toEqual({ output: "hi\n", stdout: "hi\n", stderr: "" });
    await sandbox.process.deleteSession("sess-1");
    const kill = api.commands.at(-1)!;
    expect(kill).toContain(`kill -TERM -- "-$p"`);
    expect(kill).toContain("rm -rf '/home/user/.useagent/sessions/sess-1'");
  });

  test("PTY helpers isolate Box login state and keep the API key out of SSH argv and env", async () => {
    const home = await createBoxPtyHome();
    try {
      expect(boxPtyLoginArgv("box_secret")).toEqual(["box", "login", "box_secret", "--json"]);
      expect(boxPtySshArgv("bx_123")).toEqual(["box", "ssh", "bx_123"]);
      const bootstrap = boxPtyBootstrapCommand("READY", "/home/user/work with spaces");
      expect(bootstrap).toContain("cd '/home/user/work with spaces'");
      expect(bootstrap).toContain(Buffer.from("READY", "utf8").toString("base64"));
      expect(bootstrap).not.toContain("READY");
      expect(boxPtyKeygenArgv(home)).toEqual([
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        join(home, ".ssh", "ascii-box_ed25519"),
      ]);
      expect(boxPtyEnv(home, { PATH: "/usr/bin", HOME: "/shared" })).toEqual({
        PATH: "/usr/bin",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        TERM: "xterm-256color",
      });
      expect(await readFile(join(home, ".config", "ascii", "box", "config.json"), "utf8")).toBe(
        '{\n  "api_url": "https://ascii.dev",\n  "channel": "ascii-prod"\n}\n',
      );
      expect((await stat(home)).mode & 0o777).toBe(0o700);
      expect((await stat(join(home, ".config", "ascii", "box", "config.json"))).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(boxPtySshArgv("bx_123"))).not.toContain("box_secret");
      expect(JSON.stringify(boxPtyEnv(home, {}))).not.toContain("box_secret");
    } finally {
      await removeBoxPtyHome(home);
    }
    await expect(access(home)).rejects.toBeDefined();
  });

  test("PTY lifecycle forwards I/O and cleans temporary state exactly once", async () => {
    const writes: Array<string | Uint8Array> = [];
    const sizes: Array<[number, number]> = [];
    let closes = 0;
    let kills = 0;
    let cleanups = 0;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const subprocess = {
      exited,
      exitCode: null,
      killed: false,
      kill() {
        kills += 1;
        this.killed = true;
        resolveExit(143);
      },
    };
    const ready = Promise.withResolvers<void>();
    const handle = boxPtyHandle(
      {
        write(data) {
          writes.push(data);
          return typeof data === "string" ? data.length : data.byteLength;
        },
        resize(cols, rows) {
          sizes.push([cols, rows]);
        },
        close() {
          closes += 1;
        },
      },
      subprocess,
      async () => {
        cleanups += 1;
      },
      ready.promise,
    );
    let connected = false;
    const waiting = handle.waitForConnection().then(() => {
      connected = true;
    });
    await Bun.sleep(0);
    expect(connected).toBe(false);
    ready.resolve();
    await waiting;
    await handle.sendInput("pwd\r");
    await handle.resize(120, 40);
    const termination = handle.waitForTermination();
    expect(handle.waitForTermination()).toBe(termination);
    await handle.disconnect();
    expect(await termination).toEqual({ exitCode: 143 });
    await handle.kill();
    expect(writes).toEqual(["pwd\r"]);
    expect(sizes).toEqual([[120, 40]]);
    expect(kills).toBe(1);
    expect(closes).toBe(1);
    expect(cleanups).toBe(1);
  });

  test("PTY termination does not wait for or expose eager cleanup failures", async () => {
    for (const cleanup of [
      async () => {
        throw new Error("cleanup failed");
      },
      () => new Promise<void>(() => {}),
    ]) {
      const exited = Promise.withResolvers<number>();
      const handle = boxPtyHandle(
        {
          write: () => 0,
          resize: () => {},
          close: () => {},
        },
        {
          exited: exited.promise,
          exitCode: null,
          killed: false,
          kill: () => {},
        },
        cleanup,
      );
      const termination = handle.waitForTermination();

      exited.resolve(0);

      expect(await termination).toEqual({ exitCode: 0 });
      await Bun.sleep(0);
    }
  });

  test("PTY readiness suppresses first-connection key output and split markers", async () => {
    const visible: string[] = [];
    const gate = boxPtyReadyGate("READY", (data) => {
      visible.push(Buffer.from(data).toString("utf8"));
    });
    gate.push(Buffer.from("Generating public/private ed25519 key pair.\nREA"));
    gate.push(Buffer.from("DY\r\nuser@box:~$ "));
    await gate.ready;
    gate.push(Buffer.from("pwd\r\n"));
    expect(visible).toEqual(["user@box:~$ ", "pwd\r\n"]);
  });

  test("PTY data callback failures never escape the terminal callback", async () => {
    const gate = boxPtyReadyGate("READY", () => {
      throw new Error("consumer failed");
    });
    expect(() => gate.push(Buffer.from("READY\r\nfirst"))).not.toThrow();
    await gate.ready;
    expect(() => gate.push(Buffer.from("second"))).not.toThrow();
    await Bun.sleep(0);
  });

  test("a box that never becomes ready is deleted with its label row, and the error surfaces", async () => {
    const api = fakeBoxApi([], { createState: "failing" });
    const { provider: box, labels } = provider(api);
    await expect(box.create({ labels: { "skynet-run": "r1" } })).rejects.toMatchObject({ code: "box_error" });
    const del = api.requests.find((r) => r.method === "DELETE")!;
    expect(del.path).toBe("/boxes/bx_1");
    expect(del.headers["X-Ascii-Confirm-Delete"]).toBe("bx_1");
    expect(api.boxes.has("bx_1")).toBe(false);
    expect((await labels.read(["bx_1"])).size).toBe(0);
  });

  test("API failures surface the Box error code instead of a bare HTTP status", async () => {
    const api = fakeBoxApi();
    await expect(provider(api, { apiKey: "wrong" }).provider.get("bx_1")).rejects.toMatchObject({ name: "BoxApiError", status: 401, code: "unauthorized" });
  });
});

describe("Box interactive terminal declaration", () => {
  test("names the missing Box CLI up front instead of failing every PTY attempt", async () => {
    expect(boxCliProblem(() => "/usr/local/bin/box")).toBeNull();
    expect(boxCliProblem(() => null)).toMatch(/Box CLI \(box\) installed on the useAgent server/);
    if (Bun.which("box")) return; // the live CLI is present here; the typed error path is covered by the fake above
    const api = fakeBoxApi([{ id: "bx_term", state: "ready", vcpu: 4, memoryGB: 8, subdomain: "bx-term" }]);
    const handle = await boxSandboxProvider(config, { fetchImpl: api.fetchImpl, sleep: async () => {} }).get("bx_term");
    const error = await handle.process.createPty({ id: "t", cols: 80, rows: 24, onData: () => {} }).catch((e: unknown) => e);
    expect(isSandboxTerminalUnavailableError(error)).toBe(true);
  });
});
