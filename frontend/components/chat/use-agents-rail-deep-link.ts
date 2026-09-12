"use client";

// Sidebar native-subagent rows deep-link into a session with
// `?agent_execution=<execution id>&agent_run=<run id>`. This hook surfaces that
// collision-safe focus and forces
// the Agents surface open so the rail can select the matching card's EXISTING
// detail view - the native child stays inspect-only, never a thread of its own.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";

export function hrefWithoutAgentFocus(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("agent_execution");
  params.delete("agent_run");
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function useAgentsRailDeepLink(
  setRailTabOverride: (tab: "agents" | null) => void,
  setRailOverride: (open: boolean | null) => void,
): {
  focusExecutionId: string | null;
  focusExecutionRunId: string | null;
  clearAgentFocus: () => void;
} {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const requestedExecutionId = searchParams.get("agent_execution");
  const requestedRunId = searchParams.get("agent_run");
  const hasCompleteFocus = Boolean(requestedExecutionId && requestedRunId);
  const focusExecutionId = hasCompleteFocus ? requestedExecutionId : null;
  const focusExecutionRunId = hasCompleteFocus ? requestedRunId : null;
  const ownsRailRef = useRef(false);
  useEffect(() => {
    if (focusExecutionId) {
      ownsRailRef.current = true;
      setRailTabOverride("agents");
      setRailOverride(true);
      return;
    }
    if (!ownsRailRef.current) return;
    ownsRailRef.current = false;
    setRailTabOverride(null);
    setRailOverride(null);
  }, [focusExecutionId, setRailTabOverride, setRailOverride]);
  const clearAgentFocus = useCallback(() => {
    router.replace(hrefWithoutAgentFocus(pathname, search), { scroll: false });
  }, [pathname, router, search]);
  return { focusExecutionId, focusExecutionRunId, clearAgentFocus };
}
