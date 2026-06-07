"use client";

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useContext,
  useRef,
  useState,
} from "react";

type TurnUiState = Map<string, unknown>;

const TurnUiStateContext = createContext<TurnUiState | null>(null);

/**
 * Stable state owner for one turn row. The row itself remains mounted while
 * virtualization swaps its heavy contents for a placeholder, so disclosure
 * choices survive off-window unmount/remount and the 30 -> 31 turn cutover.
 */
export function TurnUiStateProvider({ children }: { children: ReactNode }) {
  const stateRef = useRef<TurnUiState>(new Map());
  return (
    <TurnUiStateContext.Provider value={stateRef.current}>
      {children}
    </TurnUiStateContext.Provider>
  );
}

/** A disclosure state slot scoped to the containing turn row. */
export function useTurnUiState<T>(
  key: string,
  initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(TurnUiStateContext);
  const [value, setValue] = useState<T>(() =>
    store?.has(key) ? (store.get(key) as T) : initialValue,
  );
  const setPersistentValue: Dispatch<SetStateAction<T>> = (next) => {
    setValue((current) => {
      const resolved = typeof next === "function" ? (next as (value: T) => T)(current) : next;
      store?.set(key, resolved);
      return resolved;
    });
  };
  return [value, setPersistentValue];
}
