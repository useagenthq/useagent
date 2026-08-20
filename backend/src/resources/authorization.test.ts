import { describe, expect, test } from "bun:test";
import { createRunResourceAuthorization } from "./authorization";
import { resolveRunIntake } from "./run-intake";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("run resource authorization", () => {
  test("uses org-scoped repository checks and pins a verified PR head", async () => {
    const calls: string[] = [];
    const intake = await resolveRunIntake(
      {
        source: "api",
        text: "Test https://github.com/upstream-org/backend/pull/19625",
      },
      {
        authorize: createRunResourceAuthorization("org-1", {
          async listRepos(orgId) {
            calls.push(`list:${orgId}`);
            return {
              configured: true,
              repos: [
                {
                  full_name: "upstream-org/backend",
                  name: "backend",
                  private: true,
                  default_branch: "main",
                },
              ],
            };
          },
          async unknownRepos(repos, orgId) {
            calls.push(`unknown:${orgId}:${repos.join(",")}`);
            return [];
          },
          async verifyPullRequest(repository, number) {
            calls.push(`pull:${repository}:${number}`);
            return { headSha: SHA };
          },
        }),
      },
    );

    expect(calls).toEqual([
      "list:org-1",
      "unknown:org-1:upstream-org/backend",
      "list:org-1",
      "unknown:org-1:upstream-org/backend",
      "pull:upstream-org/backend:19625",
    ]);
    expect(intake.repos).toEqual(["upstream-org/backend"]);
    expect(intake.resources[1]).toMatchObject({
      locator: { type: "github.pull_request", revision: SHA },
    });
  });

  test("rechecks inherited repository access without moving its pinned PR revision", async () => {
    const calls: string[] = [];
    const authorize = createRunResourceAuthorization("org-1", {
      async listRepos(orgId) {
        calls.push(`list:${orgId}`);
        return {
          configured: true,
          repos: [{
            full_name: "upstream-org/backend",
            name: "backend",
            private: true,
            default_branch: "main",
          }],
        };
      },
      async unknownRepos(repos, orgId) {
        calls.push(`unknown:${orgId}:${repos.join(",")}`);
        return [];
      },
      async verifyPullRequest(repository, number) {
        calls.push(`pull:${repository}:${number}`);
        return { headSha: SHA };
      },
    });
    const root = await resolveRunIntake(
      { source: "slack", text: "Test https://github.com/upstream-org/backend/pull/19625" },
      { authorize },
    );

    calls.length = 0;
    const followUp = await resolveRunIntake(
      { source: "slack", text: "Retest it", inheritedResources: root.resources },
      { authorize },
    );

    expect(calls).toEqual([
      "list:org-1",
      "unknown:org-1:upstream-org/backend",
      "list:org-1",
      "unknown:org-1:upstream-org/backend",
    ]);
    expect(followUp.resources[1]).toMatchObject({
      locator: { type: "github.pull_request", revision: SHA },
    });
    expect(followUp.repos).toEqual(["upstream-org/backend"]);
  });

  test("leaves ordinary web pages as prompt context without touching GitHub", async () => {
    const intake = await resolveRunIntake(
      { source: "web", text: "Read https://example.com/docs" },
      {
        authorize: createRunResourceAuthorization("org-1", {
          listRepos: async () => {
            throw new Error("GitHub should not be consulted");
          },
        }),
      },
    );
    expect(intake.resources).toEqual([]);
  });

  test("does not trust a caller-supplied PR revision", async () => {
    let verified = 0;
    const intake = await resolveRunIntake(
      {
        source: "api",
        text: "",
        explicitResources: [{
          kind: "code.change",
          provider: "github",
          locator: {
            type: "github.pull_request",
            repository: "upstream-org/backend",
            number: 19625,
            revision: "caller-controlled",
          },
        }],
      },
      {
        authorize: createRunResourceAuthorization("org-1", {
          listRepos: async () => ({ configured: true, repos: [] }),
          unknownRepos: async () => [],
          verifyPullRequest: async () => {
            verified += 1;
            return { headSha: SHA };
          },
        }),
      },
    );

    expect(verified).toBe(1);
    expect(intake.resources[0]).toMatchObject({
      locator: { type: "github.pull_request", revision: SHA },
    });
  });
});
