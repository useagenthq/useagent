import { describe, expect, test } from "bun:test";
import type { ApiRun, ApiStep } from "@useagent/agent-client/wire";
import {
  createInternalOpenCodeQualificationDriver,
  FREE_MODEL_QUALIFICATION_MARKER,
  FREE_MODEL_QUALIFICATION_ORIGIN,
  FREE_MODEL_QUALIFICATION_PRIORITY,
  type InternalQualificationRunServices,
} from "./free-model-qualification-driver";

function step(kind: ApiStep["kind"]): ApiStep {
  return {
    id: crypto.randomUUID(),
    run_id: "run",
    idx: 1,
    kind,
    label: "tool",
    chip: "shell",
    code_json: null,
    created_at: new Date().toISOString(),
  };
}

function run(
  status: ApiRun["status"],
  summary: string | null,
  steps: ApiStep[] = [],
): ApiRun {
  return {
    id: "run",
    org_id: "org",
    user_id: null,
    project_id: null,
    prompt: "qualify",
    model: "vendor/model:free",
    engine: "opencode",
    status,
    summary,
    duration_ms: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "run",
    engine_session_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    steps,
  };
}

function servicesFor(
  read: InternalQualificationRunServices["read"],
  overrides: Partial<InternalQualificationRunServices> = {},
) {
  const accepted: Parameters<InternalQualificationRunServices["accept"]>[0][] = [];
  const cancelled: string[] = [];
  const services: InternalQualificationRunServices = {
    accept: async (input) => {
      accepted.push(input);
      return { status: "created", runId: input.run.id, commandId: crypto.randomUUID() };
    },
    pump: async (threadId) => threadId,
    read,
    cancel: async (_orgId, runId) => {
      cancelled.push(runId);
    },
    sleep: async () => {},
    ...overrides,
  };
  return { services, accepted, cancelled };
}

describe("internal OpenCode free-model qualification driver", () => {
  test("requires a real shell step and exact final marker", async () => {
    const fixture = servicesFor(async () =>
      run("completed", FREE_MODEL_QUALIFICATION_MARKER, [step("command")])
    );
    const driver = createInternalOpenCodeQualificationDriver(
      { orgId: "org", timeoutMs: 100, pollMs: 1 },
      fixture.services,
    );
    await expect(driver.qualify({
      modelId: "vendor/model:free",
      claimToken: crypto.randomUUID(),
    })).resolves.toMatchObject({
      classification: "success",
      httpStatus: 200,
      errorCode: null,
    });
    expect(fixture.accepted[0]).toMatchObject({
      origin: FREE_MODEL_QUALIFICATION_ORIGIN,
      priority: FREE_MODEL_QUALIFICATION_PRIORITY,
      acceptedModelPolicy: "persisted",
      actorId: null,
      run: {
        engine: "opencode",
        model: "vendor/model:free",
        parentRunId: null,
        repos: [],
      },
    });
  });

  test("a text-only success is a model tool-call failure", async () => {
    const fixture = servicesFor(async () =>
      run("completed", FREE_MODEL_QUALIFICATION_MARKER)
    );
    const driver = createInternalOpenCodeQualificationDriver(
      { orgId: "org", timeoutMs: 100, pollMs: 1 },
      fixture.services,
    );
    await expect(driver.qualify({
      modelId: "vendor/model:free",
      claimToken: crypto.randomUUID(),
    })).resolves.toMatchObject({
      classification: "model_failure",
      errorCode: "tool_call_failed",
    });
  });

  test("account authentication failure is systemic, not model quarantine evidence", async () => {
    const fixture = servicesFor(async () =>
      run("failed", "401 API key authentication failed")
    );
    const driver = createInternalOpenCodeQualificationDriver(
      { orgId: "org", timeoutMs: 100, pollMs: 1 },
      fixture.services,
    );
    await expect(driver.qualify({
      modelId: "vendor/model:free",
      claimToken: crypto.randomUUID(),
    })).resolves.toMatchObject({
      classification: "system_failure",
      httpStatus: 401,
      errorCode: "authentication_failed",
    });
  });

  test("hosted-application restriction is model-specific quarantine evidence", async () => {
    const fixture = servicesFor(async () =>
      run("failed", "403 application is not authorized for this hosted app")
    );
    const driver = createInternalOpenCodeQualificationDriver(
      { orgId: "org", timeoutMs: 100, pollMs: 1 },
      fixture.services,
    );
    await expect(driver.qualify({
      modelId: "vendor/model:free",
      claimToken: crypto.randomUUID(),
    })).resolves.toMatchObject({
      classification: "model_failure",
      httpStatus: 403,
      errorCode: "hosted_app_restricted",
    });
  });

  test("timeout is bounded, cancelled, and classified as systemic", async () => {
    let now = 0;
    const fixture = servicesFor(
      async () => run("running", null),
      {
        nowMs: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    const driver = createInternalOpenCodeQualificationDriver(
      { orgId: "org", timeoutMs: 20, pollMs: 10 },
      fixture.services,
    );
    await expect(driver.qualify({
      modelId: "vendor/model:free",
      claimToken: crypto.randomUUID(),
    })).resolves.toMatchObject({
      classification: "system_failure",
      latencyMs: 20,
      errorCode: "timeout",
    });
    expect(fixture.cancelled).toHaveLength(1);
  });

  test("a post-accept pump failure cancels the hidden run", async () => {
    const fixture = servicesFor(async () => run("queued", null), {
      pump: async () => {
        throw new Error("pump unavailable");
      },
    });
    const driver = createInternalOpenCodeQualificationDriver(
      { orgId: "org", timeoutMs: 20, pollMs: 10 },
      fixture.services,
    );
    await expect(driver.qualify({
      modelId: "vendor/model:free",
      claimToken: crypto.randomUUID(),
    })).resolves.toMatchObject({
      classification: "system_failure",
      errorCode: "transport_error",
    });
    expect(fixture.cancelled).toHaveLength(1);
  });
});
