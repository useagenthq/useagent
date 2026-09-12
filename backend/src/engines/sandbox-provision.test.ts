import { describe, expect, test } from "bun:test";
import type {
  SandboxCreateOptions,
  SandboxHandle,
  SandboxProvider,
  SandboxTemplateStatus,
} from "@useagent/sandbox-contract";
import { provisionSandbox } from "./sandbox-provision";
import type { EmitStep, EngineRunContext } from "./types";

const TARGET = { cpu: 2, memory: 8 };

function fakeHandle(id: string): SandboxHandle {
  return { id, cpu: 2, memory: 8, state: "started" } as unknown as SandboxHandle;
}

interface FakeProvider extends SandboxProvider {
  readonly creates: SandboxCreateOptions[];
  readonly activations: number;
}

function fakeProvider(options: {
  template?: SandboxTemplateStatus | ((onActivating?: () => void | Promise<void>) => Promise<SandboxTemplateStatus>);
  createFails?: string;
} = {}): FakeProvider {
  const creates: SandboxCreateOptions[] = [];
  const provider = {
    creates,
    activations: 0,
    async create(create: SandboxCreateOptions = {}) {
      creates.push(create);
      if (options.createFails && create.snapshot) throw new Error(options.createFails);
      return fakeHandle(create.snapshot ? "from-template" : "from-base");
    },
    async get() {
      throw new Error("unused");
    },
    async *list() {},
    ...(options.template
      ? {
          async ensureTemplate(_name: string, hooks?: { onActivating?: () => void | Promise<void> }) {
            return typeof options.template === "function"
              ? options.template(hooks?.onActivating)
              : options.template!;
          },
        }
      : {}),
  };
  return provider as FakeProvider;
}

function ctx(): EngineRunContext & { readonly steps: EmitStep[] } {
  const steps: EmitStep[] = [];
  return {
    steps,
    runId: "run-a",
    prompt: "x",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/work",
    threadId: "thread-a",
    orgId: "org-a",
    signal: new AbortController().signal,
    emit: async (step) => {
      steps.push(step);
      return undefined;
    },
    setSummary: () => {},
  };
}

const quiet = async () => false;

describe("provisionSandbox", () => {
  test("a healthy snapshot creates from it with no extra steps", async () => {
    const provider = fakeProvider({ template: { name: "snap", state: "active" } });
    const run = ctx();
    const provisioned = await provisionSandbox({
      ctx: run,
      binding: { kind: "daytona", provider },
      snapshot: "snap",
      chip: "opencode",
      create: { labels: { "skynet-run": "run-a" } },
      resourceTarget: TARGET,
      noteLostWorkspace: quiet,
    });
    expect(provisioned).toMatchObject({ fromTemplate: true, sandbox: { id: "from-template" } });
    expect(provider.creates).toEqual([{ labels: { "skynet-run": "run-a" }, snapshot: "snap" }]);
    expect(run.steps).toEqual([]);
  });

  test("an inactive snapshot shows the activation step, then creates once it is active", async () => {
    const provider = fakeProvider({
      template: async (onActivating) => {
        await onActivating?.();
        return { name: "snap", state: "active" };
      },
    });
    const run = ctx();
    const provisioned = await provisionSandbox({
      ctx: run,
      binding: { kind: "daytona", provider },
      snapshot: "snap",
      chip: "claude",
      create: {},
      resourceTarget: TARGET,
      noteLostWorkspace: quiet,
    });
    expect(provisioned.fromTemplate).toBe(true);
    expect(run.steps.map((step) => step.label)).toEqual([
      "Activating sandbox image, this can take a few minutes…",
    ]);
    expect(run.steps[0]?.chip).toBe("claude");
  });

  test("an absent snapshot fails by name with no fallback create", async () => {
    const provider = fakeProvider({ template: { name: "skynet-agent-v99", state: "absent" } });
    await expect(provisionSandbox({
      ctx: ctx(),
      binding: { kind: "daytona", provider },
      snapshot: "skynet-agent-v99",
      chip: "opencode",
      create: {},
      resourceTarget: { cpu: 1, memory: 1 },
      noteLostWorkspace: quiet,
    })).rejects.toThrow("snapshot skynet-agent-v99 is not in this Daytona org");
    expect(provider.creates).toEqual([]);
  });

  test("a snapshot that stays inactive surfaces the provider's reason instead of a CPU/RAM error", async () => {
    const provider = fakeProvider({
      template: { name: "skynet-acp-v3", state: "activating", detail: "still building after 360s" },
    });
    await expect(provisionSandbox({
      ctx: ctx(),
      binding: { kind: "daytona", provider },
      snapshot: "skynet-acp-v3",
      chip: "codex",
      create: {},
      resourceTarget: TARGET,
      noteLostWorkspace: quiet,
    })).rejects.toThrow("snapshot skynet-acp-v3 is activating (still building after 360s)");
    // The 1 vCPU default image can never meet a 2 CPU / 8 GiB target, so no doomed box is created.
    expect(provider.creates).toEqual([]);
  });

  test("a create failure on an active snapshot carries the provider text and the snapshot name", async () => {
    const provider = fakeProvider({
      template: { name: "snap", state: "active" },
      createFails: "Snapshot snap is inactive",
    });
    await expect(provisionSandbox({
      ctx: ctx(),
      binding: { kind: "daytona", provider },
      snapshot: "snap",
      chip: "opencode",
      create: {},
      resourceTarget: TARGET,
      noteLostWorkspace: quiet,
    })).rejects.toThrow("Daytona could not create a sandbox from snapshot snap: Snapshot snap is inactive");
    expect(provider.creates).toHaveLength(1);
  });

  test("falls back to the base image only when the plugin's base image meets the target, and says so", async () => {
    const provider = fakeProvider({ template: { name: "snap", state: "inactive", detail: "inactive" } });
    const run = ctx();
    const provisioned = await provisionSandbox({
      ctx: run,
      binding: { kind: "daytona", provider },
      snapshot: "snap",
      chip: "opencode",
      create: { labels: { "skynet-run": "run-a" } },
      resourceTarget: { cpu: 1, memory: 1 },
      noteLostWorkspace: quiet,
    });
    expect(provisioned).toMatchObject({ fromTemplate: false, sandbox: { id: "from-base" } });
    expect(provider.creates).toEqual([{ labels: { "skynet-run": "run-a" } }]);
    expect(run.steps).toEqual([
      {
        kind: "task",
        chip: "warning",
        label: "snapshot snap is inactive (inactive); starting from the Daytona base image instead",
      },
    ]);
  });

  test("providers without template state go straight to create and report the create error", async () => {
    const provider = fakeProvider({ createFails: "template tpl-1 is not yours" });
    await expect(provisionSandbox({
      ctx: ctx(),
      binding: { kind: "cube", provider },
      snapshot: "tpl-1",
      chip: "pi",
      create: {},
      resourceTarget: { cpu: 1, memory: 1 },
      noteLostWorkspace: quiet,
    })).rejects.toThrow("Cube could not create a sandbox from snapshot tpl-1: template tpl-1 is not yours");
  });

  test("an empty template means the provider's base image, with nothing preinstalled trusted", async () => {
    const provider = fakeProvider();
    const provisioned = await provisionSandbox({
      ctx: ctx(),
      binding: { kind: "box", provider },
      snapshot: "",
      chip: "opencode",
      create: {},
      resourceTarget: TARGET,
      noteLostWorkspace: quiet,
    });
    expect(provisioned).toMatchObject({ fromTemplate: false, sandbox: { id: "from-base" } });
  });

  test("notes a lost workspace before provisioning for a thread", async () => {
    const seen: string[] = [];
    const provider = fakeProvider({ template: { name: "snap", state: "active" } });
    await provisionSandbox({
      ctx: ctx(),
      binding: { kind: "daytona", provider },
      snapshot: "snap",
      chip: "opencode",
      create: {},
      resourceTarget: TARGET,
      noteLostWorkspace: async (run) => {
        seen.push(run.threadId ?? "");
        return true;
      },
    });
    expect(seen).toEqual(["thread-a"]);
  });
});
