import { expect, test } from "bun:test";

import type { SidebarThreadFamilyNode } from "./sidebar-project-groups";
import { projectFamilyNode } from "./sidebar-projects";

test("product children retain their own native-subagent projection", () => {
  const node = {
    id: "product-child",
    title: "Build calendar grid",
    status: "running",
    engine: "codex",
    model: "gpt-5.6-sol",
    activityAt: "2026-09-01T10:00:00.000Z",
    run: {
      id: "product-child",
      native_children: [{
        execution_id: "execution-1",
        run_id: "product-child-run",
        provider: "codex",
        native_session_id: "reused-native-id",
        title: "Check accessibility",
        status: "running",
        started_at: null,
      }],
      native_children_total: 1,
    },
    relationship: null,
    children: [],
  } as unknown as SidebarThreadFamilyNode;

  const projected = projectFamilyNode(node, "/session/root");
  expect(projected.nativeChildren?.rows[0]).toMatchObject({
    id: "execution-1",
    label: "Check accessibility",
    href: "/session/product-child?agent_execution=execution-1&agent_run=product-child-run",
  });
});
