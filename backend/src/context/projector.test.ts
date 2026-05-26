import { describe, expect, test } from "bun:test";
import {
  projectAutomation,
  projectKnowledge,
  projectMemory,
  projectSkill,
} from "./projector";

// ---------------------------------------------------------------------------
// Pure projector tests (no DB) — each source kind projects the right
// searchable_text (title + body/description + tags, concatenated) and the right
// stable typed source_ref back to the authoritative row.
// ---------------------------------------------------------------------------

describe("context projector builders", () => {
  test("projects a skill: source_ref carries id@version, searchable_text folds sections + tags", () => {
    const p = projectSkill({
      id: "skill-123",
      orgId: "org-a",
      kind: "skill",
      name: "Deploy to Hetzner",
      description: "How the release ships to the box.",
      tags: ["deploy", "ops"],
      sections: {
        overview: ["The host runs one backend."],
        procedure: ["Run configure-host.sh", "Restart the service"],
        verify: ["curl the health endpoint"],
      },
      currentVersion: 4,
    });
    expect(p.kind).toBe("skill");
    expect(p.title).toBe("Deploy to Hetzner");
    expect(p.sourceRef).toBe("skill:skill-123@4");
    expect(p.sourceKindId).toBe("skill-123");
    expect(p.version).toBe(4);
    expect(p.embedding).toBeNull();
    // title + description + section items + tags all present in the FTS corpus
    expect(p.searchableText).toContain("Deploy to Hetzner");
    expect(p.searchableText).toContain("How the release ships to the box.");
    expect(p.searchableText).toContain("Run configure-host.sh");
    expect(p.searchableText).toContain("curl the health endpoint");
    expect(p.searchableText).toContain("deploy");
    expect(p.searchableText).toContain("ops");
  });

  test("projects a playbook kind through the same skill builder", () => {
    const p = projectSkill({
      id: "pb-9",
      orgId: "org-a",
      kind: "playbook",
      name: "Incident Runbook",
      description: "",
      tags: [],
      sections: { overview: ["Page the on-call."], procedure: [], verify: [] },
      currentVersion: 1,
    });
    expect(p.kind).toBe("playbook");
    // The prefix family is "skill:" even for a playbook (shared skills store).
    expect(p.sourceRef).toBe("skill:pb-9@1");
    expect(p.searchableText).toContain("Incident Runbook");
    expect(p.searchableText).toContain("Page the on-call.");
  });

  test("projects a knowledge record: knowledge:<recordId>, no version", () => {
    const p = projectKnowledge({
      recordId: "rec-abc",
      orgId: "org-a",
      title: "VPN Setup",
      body: "Install the client and import the profile.",
      tags: ["network"],
    });
    expect(p.kind).toBe("knowledge");
    expect(p.sourceRef).toBe("knowledge:rec-abc");
    expect(p.sourceKindId).toBe("rec-abc");
    expect(p.version).toBeNull();
    expect(p.searchableText).toContain("VPN Setup");
    expect(p.searchableText).toContain("import the profile");
    expect(p.searchableText).toContain("network");
  });

  test("projects an automation: automation:<scheduleId>, prompt + cron in the corpus", () => {
    const p = projectAutomation({
      id: "sched-1",
      orgId: "org-a",
      name: "Nightly digest",
      prompt: "Summarize the day's runs and post to Slack.",
      cron: "0 9 * * *",
      tags: ["digest"],
    });
    expect(p.kind).toBe("automation");
    expect(p.sourceRef).toBe("automation:sched-1");
    expect(p.sourceKindId).toBe("sched-1");
    expect(p.version).toBeNull();
    expect(p.searchableText).toContain("Nightly digest");
    expect(p.searchableText).toContain("Summarize the day's runs");
    expect(p.searchableText).toContain("0 9 * * *");
    expect(p.searchableText).toContain("digest");
  });

  test("projects a memory item: memory:<id>", () => {
    const p = projectMemory({
      id: "mem-7",
      orgId: "org-a",
      title: "Prefers concise reports",
      body: "The user dislikes being asked to confirm routine actions.",
    });
    expect(p.kind).toBe("memory");
    expect(p.sourceRef).toBe("memory:mem-7");
    expect(p.version).toBeNull();
    expect(p.searchableText).toContain("Prefers concise reports");
  });

  test("searchable_text drops empty parts (no leading/trailing separators)", () => {
    const p = projectSkill({
      id: "s",
      orgId: "org-a",
      kind: "skill",
      name: "Title Only",
      description: "",
      tags: [],
      sections: { overview: [], procedure: [], verify: [] },
    currentVersion: 1,
    });
    expect(p.searchableText).toBe("Title Only");
  });
});
