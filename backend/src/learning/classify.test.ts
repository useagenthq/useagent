/**
 * Pure tests for the candidate classifier + verified-outcome gate
 * (self_improving 6.4). The core rule: provider completion alone is NOT success.
 * An unverified completion produces NO procedure candidate. A verified outcome
 * routes to personal memory / knowledge draft / playbook per the doc's ladder.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyCandidate,
  hasVerifiedOutcome,
  outcomeFactsFrom,
  type OutcomeFacts,
} from "./classify";
import type { ExtractedProcedure, ProcedureStep } from "./procedure-v2";

const facts = (o: Partial<OutcomeFacts>): OutcomeFacts => ({
  scope: "org",
  artifactCount: 0,
  hasVerification: false,
  userAccepted: false,
  executableSteps: 0,
  distinctTools: 0,
  ...o,
});

describe("hasVerifiedOutcome (the gate)", () => {
  test("completion alone (no artifact / verify / acceptance) is NOT verified", () => {
    expect(hasVerifiedOutcome(facts({}))).toBe(false);
  });
  test("a published artifact is a verified postcondition", () => {
    expect(hasVerifiedOutcome(facts({ artifactCount: 1 }))).toBe(true);
  });
  test("a passing verification step is a verified postcondition", () => {
    expect(hasVerifiedOutcome(facts({ hasVerification: true }))).toBe(true);
  });
  test("explicit user acceptance is a verified postcondition", () => {
    expect(hasVerifiedOutcome(facts({ userAccepted: true }))).toBe(true);
  });
});

describe("classifyCandidate", () => {
  test("an UNVERIFIED completion yields NO candidate (the gate rejects it)", () => {
    expect(classifyCandidate(facts({ executableSteps: 12, distinctTools: 3 }))).toBe("none");
  });

  test("a verified repeatable multi-step workflow -> a playbook proposal", () => {
    expect(
      classifyCandidate(facts({ hasVerification: true, executableSteps: 5, distinctTools: 2 })),
    ).toBe("playbook_proposal");
  });

  test("a verified org fact (not multi-step) -> a knowledge draft", () => {
    expect(classifyCandidate(facts({ artifactCount: 1, executableSteps: 1, distinctTools: 1 }))).toBe(
      "knowledge_draft",
    );
  });

  test("a small personal-scope verified outcome -> personal memory", () => {
    expect(
      classifyCandidate(facts({ scope: "personal", userAccepted: true, executableSteps: 1, distinctTools: 1 })),
    ).toBe("personal_memory");
  });

  test("a personal-scope MULTI-STEP verified workflow still becomes a playbook (reviewable)", () => {
    expect(
      classifyCandidate(
        facts({ scope: "personal", artifactCount: 1, executableSteps: 4, distinctTools: 2 }),
      ),
    ).toBe("playbook_proposal");
  });
});

describe("outcomeFactsFrom", () => {
  const step = (tool: string, verify = false): ProcedureStep => ({
    ordinal: 0,
    tool,
    operation: verify ? "bun test" : "edit file",
    normalizedArgs: {},
    preconditions: [],
    result: "succeeded",
    verificationRefs: verify ? ["ev-1"] : [],
    sourceEventIds: ["ev-1"],
  });

  test("derives distinct tools, executable step count, and the verification flag", () => {
    const proc: ExtractedProcedure = {
      executable: [step("bash", true), step("edit"), step("bash")],
      advice: [],
      elided: 0,
    };
    const f = outcomeFactsFrom({ scope: "org", artifactCount: 0, userAccepted: false, procedure: proc });
    expect(f.executableSteps).toBe(3);
    expect(f.distinctTools).toBe(2); // bash + edit
    expect(f.hasVerification).toBe(true);
  });
});
