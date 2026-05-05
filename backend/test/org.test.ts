import { describe, expect, test } from "bun:test";
import { createOrgSession, json } from "./helpers";

describe("org scoping", () => {
  test("dev fallback (no session) sees the 7 seeded skills", async () => {
    const { status, body } = await json<{ skills: any[] }>("/api/skills");
    expect(status).toBe(200);
    expect(body.skills.length).toBe(7);
  });

  test("a fresh authenticated org sees 0 skills", async () => {
    // A brand-new user + org (real session, server-resolved tenancy).
    const { cookies } = await createOrgSession("acme");

    // Skills for the active (empty) org → none, proving org scoping.
    const skills = await json<{ skills: any[] }>("/api/skills", { cookies });
    expect(skills.status).toBe(200);
    expect(skills.body.skills.length).toBe(0);
  });
});
