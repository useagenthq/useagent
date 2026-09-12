import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiNativeChildSummary } from "@useagent/agent-client/wire";

import { NativeAgentRows, nativeAgentRowState, sidebarNativeAgentRows } from "./native-agent-rows";

const child = (over: Partial<ApiNativeChildSummary> = {}): ApiNativeChildSummary => ({
  execution_id: "exec-1",
  run_id: "run-1",
  provider: "opencode",
  native_session_id: "ses_child_1",
  title: "Research checkout",
  status: "running",
  started_at: null,
  ...over,
});

test("execution statuses collapse onto the three sidebar states", () => {
  expect(nativeAgentRowState("queued")).toBe("running");
  expect(nativeAgentRowState("running")).toBe("running");
  expect(nativeAgentRowState("waiting")).toBe("running");
  expect(nativeAgentRowState("failed")).toBe("failed");
  expect(nativeAgentRowState("completed")).toBe("done");
  expect(nativeAgentRowState("cancelled")).toBe("failed");
});

test("the builder deep-links the PARENT session and reports server-side overflow", () => {
  const projection = sidebarNativeAgentRows({
    id: "thread-1",
    native_children: [
      child({ execution_id: "e1", native_session_id: "ses_a" }),
      child({ execution_id: "e2", native_session_id: "ses b", title: null, status: "failed" }),
    ],
    native_children_total: 7,
  });
  expect(projection).not.toBeNull();
  // Rows navigate to the parent session with the native session id as the
  // agent-focus param - never to a thread of their own.
  expect(projection?.rows[0]?.href).toBe(
    "/session/thread-1?agent_execution=e1&agent_run=run-1",
  );
  expect(projection?.rows[1]?.href).toBe(
    "/session/thread-1?agent_execution=e2&agent_run=run-1",
  );
  expect(projection?.rows[1]?.label).toBe("Subagent");
  expect(projection?.rows[1]?.state).toBe("failed");
  expect(projection?.overflow).toBe(5);

  // Threads without native children fold to null so nothing nests.
  expect(sidebarNativeAgentRows({ id: "thread-2" })).toBeNull();
  expect(sidebarNativeAgentRows({ id: "thread-3", native_children: [] })).toBeNull();
});

test("rows render inspect-only links with truthful state dots and an overflow line", () => {
  const projection = sidebarNativeAgentRows({
    id: "thread-1",
    native_children: [
      child({ execution_id: "e1", native_session_id: "ses_a", status: "running" }),
      child({
        execution_id: "e2",
        native_session_id: "ses_b",
        title: "Broken probe",
        status: "failed",
      }),
      child({
        execution_id: "e3",
        native_session_id: "ses_c",
        title: "Settled sweep",
        status: "completed",
      }),
    ],
    native_children_total: 5,
  });
  const html = renderToStaticMarkup(
    <NativeAgentRows rows={projection?.rows ?? []} overflow={projection?.overflow ?? 0} />,
  );

  expect(html.match(/data-session-ui="native-agent-row"/g) ?? []).toHaveLength(3);
  expect(html).toContain(
    'href="/session/thread-1?agent_execution=e1&amp;agent_run=run-1"',
  );
  expect(html).toContain('aria-label="Running"');
  expect(html).toContain('aria-label="Failed"');
  expect(html).toContain('aria-label="Done"');
  expect(html).toContain("+2 more");
  // Inspect-only rows are NEVER thread rows.
  expect(html).not.toContain('data-session-ui="thread-row"');
});
