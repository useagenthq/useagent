"use client";

import { useEffect, useRef } from "react";
import { type OrgChange, subscribeOrgChanges } from "@/lib/org-changes";

export function useOrgChanges(listener: (change: OrgChange) => void, onOpen?: () => void): void {
  const listenerRef = useRef(listener);
  const openRef = useRef(onOpen);
  listenerRef.current = listener;
  openRef.current = onOpen;

  useEffect(
    () =>
      subscribeOrgChanges(
        (change) => listenerRef.current(change),
        () => openRef.current?.(),
      ),
    [],
  );
}
