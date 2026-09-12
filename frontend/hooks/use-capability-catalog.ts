"use client";

import { useEffect, useState } from "react";
import { type CapabilityCatalog, fetchCapabilityCatalog } from "@/lib/capability-catalog";

export function useCapabilityCatalog(): {
  catalog: CapabilityCatalog | null;
  loaded: boolean;
} {
  const [state, setState] = useState<{ catalog: CapabilityCatalog | null; loaded: boolean }>({
    catalog: null,
    loaded: false,
  });
  useEffect(() => {
    let cancelled = false;
    void fetchCapabilityCatalog().then((catalog) => {
      if (!cancelled) setState({ catalog, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
