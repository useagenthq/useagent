import { describe, expect, test } from "bun:test";
import { createOrgSession, json } from "./helpers";

describe("org scoping", () => {
  test("dev fallback (no session) plants no demo skills at boot", async () => {
    // Boot no longer seeds template playbooks — the dev fallback org only ever
    // holds skills a caller explicitly creates, never fabricated demo data. So
    // the response is a valid list that never contains the old seed playbooks.
    const { status, body } = await json<{ skills: { name: string }[] }>(
      "/api/skills",
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.skills)).toBe(true);
    const names = body.skills.map((s) => s.name);
    for (const demo of [
      "Ship a new page",
      "Fix flaky test",
      "Design review pass",
      "Port dashboard widget",
      "Write release notes",
      "Refactor to tokens",
      "Add API route",
    ]) {
      expect(names).not.toContain(demo);
    }
  });

  test("skills are org-scoped: an org sees only what it creates", async () => {
    // A brand-new user + org (real session, server-resolved tenancy).
    const { cookies } = await createOrgSession("acme");

    // A fresh org starts empty — nothing is seeded into it.
    const before = await json<{ skills: any[] }>("/api/skills", { cookies });
    expect(before.status).toBe(200);
    expect(before.body.skills.length).toBe(0);

    // Create one skill scoped to this org.
    const created = await json<{ id: string }>("/api/skills", {
      method: "POST",
      cookies,
      body: {
        name: "Acme-only playbook",
        description: "Fixture skill scoped to this org.",
        tags: ["review"],
        sections: { overview: ["step"], procedure: ["step"], verify: ["step"] },
      },
    });
    expect(created.status).toBe(201);

    // This org now sees exactly its own skill…
    const after = await json<{ skills: any[] }>("/api/skills", { cookies });
    expect(after.body.skills.length).toBe(1);

    // …and a second, independent org never sees it (tenancy isolation).
    const other = await createOrgSession("globex");
    const otherSkills = await json<{ skills: any[] }>("/api/skills", {
      cookies: other.cookies,
    });
    expect(otherSkills.status).toBe(200);
    expect(otherSkills.body.skills.length).toBe(0);
  });
});
