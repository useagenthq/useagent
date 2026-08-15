"use client";

import { useEffect, useRef } from "react";
import { type OrgChange, subscribeOrgChanges } from "@/lib/org-changes";

export function useOrgChanges(listener: (change: OrgChange) => void): void {
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => subscribeOrgChanges((change) => listenerRef.current(change)), []);
}
