import { describe, expect, test } from "bun:test";
import type { SandboxHandle, SandboxProvider, SandboxTemplateStatus } from "@useagent/sandbox-contract";
import { nativeImageName, type NativeImageInputs } from "../sandboxes/native-image";
import {
  bakeBoxNativeSnapshot,
  boxConnectionAcceptsNativeSnapshot,
  boxTemplateHasOpenCode,
  OPENCODE_TEMPLATE_NAME,
} from "./box-native-template";

const inputs: NativeImageInputs = {
  bun: { bytes: Buffer.from("bun"), arch: "x64" },
  runtimeArchive: Buffer.from("archive"),
  runtimeDependencyLock: Buffer.from("lock"),
  runtimeDependencyPackage: Buffer.from("{}"),
  piPackage: Buffer.from("{}"),
  piLock: Buffer.from("{}"),
  claudeEnvironment: { ANTHROPIC_BASE_URL: "https://gateway.example/anthropic", CLAUDE_CONFIG_DIR: "/home/user/.useagent/claude" },
};
const NAME = nativeImageName(inputs);

function fakeProvider(options: {
  readonly existing?: SandboxTemplateStatus["state"];
  readonly withoutDelete?: boolean;
}) {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  let deleted = 0;
  const sandbox = {
    id: "bx_bake",
    process: { async executeCommand() { calls.push("exec"); return { exitCode: 0, result: "" }; } },
    fs: { async uploadFile() { calls.push("upload"); } },
    async delete() { deleted += 1; calls.push("delete-sandbox"); },
  } as unknown as SandboxHandle;
  const provider = {
    async create(createOptions: Record<string, unknown>) { created.push(createOptions); calls.push("create"); return sandbox; },
    async ensureTemplate(name: string) { calls.push(`lookup:${name}`); return { name, state: options.existing ?? "absent" }; },
    async saveTemplate(_id: string, name: string) { calls.push(`save:${name}`); return { name, state: "active" as const }; },
    ...(options.withoutDelete ? {} : { async deleteTemplate(name: string) { calls.push(`delete-template:${name}`); } }),
  } as unknown as SandboxProvider;
  return { provider, calls, created, deletedSandboxes: () => deleted };
}

describe("Box template recognition", () => {
  test("boxes from either platform template skip the opencode bootstrap", () => {
    expect(boxTemplateHasOpenCode(OPENCODE_TEMPLATE_NAME)).toBe(true);
    expect(boxTemplateHasOpenCode(NAME)).toBe(true);
    expect(boxTemplateHasOpenCode("my-own-snapshot")).toBe(false);
    expect(boxTemplateHasOpenCode("")).toBe(false);
  });

  test("a connection is advanced only when it has no snapshot or one we named", () => {
    expect(boxConnectionAcceptsNativeSnapshot(null)).toBe(true);
    expect(boxConnectionAcceptsNativeSnapshot("")).toBe(true);
    expect(boxConnectionAcceptsNativeSnapshot(OPENCODE_TEMPLATE_NAME)).toBe(true);
    expect(boxConnectionAcceptsNativeSnapshot(NAME)).toBe(true);
    expect(boxConnectionAcceptsNativeSnapshot("my-own-snapshot")).toBe(false);
    expect(boxConnectionAcceptsNativeSnapshot("useagent-my-own-snapshot")).toBe(false);
  });
});

describe("baking the Box native snapshot", () => {
  test("reuses an existing snapshot of the current name", async () => {
    const fake = fakeProvider({ existing: "active" });
    const result = await bakeBoxNativeSnapshot(fake.provider, { base: null, inputs });
    expect(result).toEqual({ name: NAME, outcome: "reused" });
    expect(fake.calls).toEqual([`lookup:${NAME}`]);
  });

  test("bakes in a box with an absolute TTL and always deletes the box", async () => {
    const fake = fakeProvider({});
    const result = await bakeBoxNativeSnapshot(fake.provider, { base: null, inputs, signal: new AbortController().signal });
    expect(result).toEqual({ name: NAME, outcome: "baked" });
    expect(fake.created[0]).toMatchObject({
      autoDeleteInterval: 60,
      labels: { "useagent.purpose": "native-image-bake", "useagent.native-image": NAME },
    });
    expect(fake.created[0]).not.toHaveProperty("snapshot");
    expect(fake.calls[0]).toBe(`lookup:${NAME}`);
    expect(fake.calls[1]).toBe("create");
    expect(fake.calls.at(-2)).toBe(`save:${NAME}`);
    expect(fake.calls.at(-1)).toBe("delete-sandbox");
    expect(fake.deletedSandboxes()).toBe(1);
  });

  test("replaces the snapshot when forced and builds on a custom base when given", async () => {
    const fake = fakeProvider({ existing: "active" });
    await bakeBoxNativeSnapshot(fake.provider, { base: "team-base", inputs, force: true, signal: new AbortController().signal });
    expect(fake.calls.slice(0, 3)).toEqual([`lookup:${NAME}`, `delete-template:${NAME}`, "create"]);
    expect(fake.created[0]).toMatchObject({ snapshot: "team-base" });
  });

  test("refuses to layer over a failed snapshot it cannot remove", async () => {
    const fake = fakeProvider({ existing: "error", withoutDelete: true });
    await expect(bakeBoxNativeSnapshot(fake.provider, { base: null, inputs })).rejects.toThrow(/cannot replace/);
    expect(fake.calls).toEqual([`lookup:${NAME}`]);
  });
});
