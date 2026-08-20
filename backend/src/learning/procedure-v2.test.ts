/**
 * Pure tests for Evidence Model v2 (self_improving 6.2/6.3). These pin the
 * behaviors the doc mandates and the old backbone violated:
 *   - canonical step ORDER is preserved
 *   - MULTIPLE calls to the same tool are kept (never set-deduped)
 *   - failed/reverted steps are EXCLUDED from the executable path, retained as advice
 *   - run-specific ids / PR numbers / branches / sandbox ids are parameterized
 *   - verification/publish steps are cited
 *   - cross-run generalization is SEQUENCE ALIGNMENT (repeated positions survive)
 */
import { describe, expect, test } from "bun:test";
import { createSecretRedactor } from "../secrets/redact";
import {
  alignProcedures,
  extractProcedure,
  parameterize,
  stepSignature,
  type ProcedureStep,
  type StepSourceRow,
} from "./procedure-v2";

const noSecrets = createSecretRedactor([]);
let seq = 0;
function cmd(command: string, extra: Record<string, unknown> = {}): StepSourceRow {
  return {
    id: `step-${seq++}`,
    kind: "command",
    label: command.slice(0, 60),
    chip: "bash",
    codeJson: JSON.stringify({ tool: "bash", input: { command }, ...extra }),
  };
}

describe("parameterize", () => {
  test("strips ids / sandbox ids / long hex and numbers, keeps stable args", () => {
    expect(parameterize("cat /runs/0b6bcf59-9d55-4e8a-b6f1-24e0c9427d31/log in sb_a1b2c3d4e5")).toBe(
      "cat /runs/<id>/log in <id>",
    );
    expect(parameterize("build 84739 deadbeefcafe")).toBe("build <n> <id>");
  });

  test("parameterizes branches and PR numbers specifically (6.3 rule 5)", () => {
    expect(parameterize("git checkout feature/new-thing")).toBe("git checkout <branch>");
    expect(parameterize("gh pr view 4213")).toBe("gh pr view <n>");
    expect(parameterize("closes #123")).toBe("closes #<n>");
    // A short port / small count is a stable argument and survives.
    expect(parameterize("curl localhost:3200 --retries 3")).toBe("curl localhost:3200 --retries 3");
  });
});

describe("extractProcedure", () => {
  test("preserves canonical order AND keeps repeated tool calls (never dedups)", () => {
    seq = 0;
    const rows = [cmd("bun install"), cmd("bun test"), cmd("bun install")];
    const { executable } = extractProcedure(rows, noSecrets);
    expect(executable.map((s) => s.operation)).toEqual(["bun install", "bun test", "bun install"]);
    // Three positions, not two — the repeat is preserved.
    expect(executable).toHaveLength(3);
    expect(executable.map((s) => s.ordinal)).toEqual([0, 1, 2]);
  });

  test("excludes FAILED steps from the executable path, retains them as advice", () => {
    seq = 0;
    const rows = [
      cmd("bun install"),
      cmd("bun test", { error: true }),
      cmd("bun run typecheck", { status: "failed" }),
      cmd("bun run build"),
    ];
    const { executable, advice } = extractProcedure(rows, noSecrets);
    expect(executable.map((s) => s.operation)).toEqual(["bun install", "bun run build"]);
    expect(advice.map((s) => s.operation)).toEqual(["bun test", "bun run typecheck"]);
    expect(advice.every((s) => s.result === "failed")).toBe(true);
  });

  test("a later rollback marks the earlier step REVERTED and drops it from executable", () => {
    seq = 0;
    const rows = [
      cmd("git commit -m wip"),
      cmd("git reset --hard git commit -m wip"), // names the earlier op -> reverts it
    ];
    const { executable, advice } = extractProcedure(rows, noSecrets);
    // The committed step was reverted; only the rollback advice-ish step (itself a
    // rollback) stays out of the executable path along with the reverted commit.
    expect(executable.map((s) => s.operation)).not.toContain("git commit -m wip");
    expect(advice.some((s) => s.result === "reverted" && s.operation === "git commit -m wip")).toBe(true);
  });

  test("cites the source step-row id per step and parameterizes run-specific ids", () => {
    seq = 0;
    const rows = [cmd("gh pr view 4213 --repo acme/skynet")];
    const { executable } = extractProcedure(rows, noSecrets);
    expect(executable[0]!.sourceEventIds).toEqual(["step-0"]);
    expect(executable[0]!.operation).toBe("gh pr view <n> --repo acme/skynet");
  });

  test("flags verification/publish steps with a verificationRef (6.4 postcondition)", () => {
    seq = 0;
    const rows = [cmd("edit README"), cmd("bun test")];
    const { executable } = extractProcedure(rows, noSecrets);
    const verify = executable.find((s) => s.operation.includes("bun test"))!;
    expect(verify.verificationRefs.length).toBeGreaterThan(0);
  });

  test("caps by leading phases and reports elided honestly (never a silent tail drop)", () => {
    seq = 0;
    const rows = Array.from({ length: 65 }, (_, i) => cmd(`step ${i}`));
    const proc = extractProcedure(rows, noSecrets);
    expect(proc.executable.length + proc.advice.length).toBe(60);
    expect(proc.elided).toBe(5);
  });
});

describe("alignProcedures (sequence alignment, NOT set intersection)", () => {
  const step = (tool: string, operation: string): ProcedureStep => ({
    ordinal: 0,
    tool,
    operation,
    normalizedArgs: {},
    preconditions: [],
    result: "succeeded",
    verificationRefs: [],
    sourceEventIds: [],
  });

  test("preserves REPEATED positions — two bash calls stay two positions", () => {
    // Set intersection over tool names would collapse the two bash calls to one.
    // Sequence alignment keeps both, in order.
    const a = [step("bash", "bun install"), step("bash", "bun test")];
    const b = [step("bash", "bun install"), step("bash", "bun test")];
    const backbone = alignProcedures([a, b]);
    expect(backbone.map((s) => `${s.tool}:${s.operation}`)).toEqual([
      "bash:bun install",
      "bash:bun test",
    ]);
  });

  test("majority backbone: a step in a minority of traces is dropped, order kept", () => {
    const t1 = [step("bash", "bun install"), step("edit", "config.ts"), step("bash", "bun test")];
    const t2 = [step("bash", "bun install"), step("webfetch", "docs"), step("edit", "config.ts")];
    const t3 = [step("bash", "bun install"), step("edit", "config.ts")];
    // bun install (3/3) and edit config.ts (3/3) survive; webfetch (1/3) and
    // bun test (1/3) drop. Order preserved.
    const backbone = alignProcedures([t1, t2, t3]);
    expect(backbone.map((s) => `${s.tool}:${s.operation}`)).toEqual([
      "bash:bun install",
      "edit:config.ts",
    ]);
  });

  test("the newest trace supplies the representative operation phrasing", () => {
    const older = [step("bash", "bun install")];
    const newer = [step("bash", "bun install --frozen-lockfile")];
    // Same signature head ("bash" + "bun install"), so they align; newest wins.
    const backbone = alignProcedures([older, newer]);
    expect(backbone[0]!.operation).toBe("bun install --frozen-lockfile");
    expect(backbone[0]!.support).toBe(2);
  });

  test("empty input yields no backbone; a single trace is its own majority", () => {
    expect(alignProcedures([])).toEqual([]);
    expect(alignProcedures([[], []])).toEqual([]);
    expect(alignProcedures([[], [step("bash", "x")]]).map((s) => s.tool)).toEqual(["bash"]);
  });

  test("deterministic", () => {
    const t = [step("bash", "a"), step("edit", "b")];
    expect(alignProcedures([t, t])).toEqual(alignProcedures([t, t]));
  });

  test("stepSignature distinguishes different operations of the same tool", () => {
    expect(stepSignature({ tool: "bash", operation: "bun install" })).not.toBe(
      stepSignature({ tool: "bash", operation: "bun test" }),
    );
    expect(stepSignature({ tool: "bash", operation: "bun install --x" })).toBe(
      stepSignature({ tool: "bash", operation: "bun install --y" }),
    );
  });
});
