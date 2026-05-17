export type SelectionActionsPhase =
  | "idle"
  | "thinking"
  | "streaming"
  | "result"
  | "error"
  | "accepted";

export interface SelectionActionsState {
  phase: SelectionActionsPhase;
  request: string | null;
  replacement: string | null;
}

export type SelectionActionsEvent =
  | { type: "request"; request: string }
  | { type: "stream"; replacement: string }
  | { type: "complete" }
  | { type: "reject" }
  | { type: "keep" }
  | { type: "discard" }
  | { type: "retry" };

const IDLE_STATE: SelectionActionsState = {
  phase: "idle",
  request: null,
  replacement: null,
};

export function createSelectionActionsState(
  state: Partial<SelectionActionsState> = {},
): SelectionActionsState {
  return { ...IDLE_STATE, ...state };
}

export function selectionActionsReducer(
  state: SelectionActionsState,
  event: SelectionActionsEvent,
): SelectionActionsState {
  switch (event.type) {
    case "request":
      return { phase: "thinking", request: event.request, replacement: null };
    case "stream":
      return { ...state, phase: "streaming", replacement: event.replacement };
    case "complete":
      return state.replacement ? { ...state, phase: "result" } : state;
    case "reject":
      return state.request ? { ...state, phase: "error", replacement: null } : state;
    case "keep":
      return state.phase === "result" ? { ...state, phase: "accepted" } : state;
    case "discard":
      return createSelectionActionsState();
    case "retry":
      return state.request
        ? { phase: "thinking", request: state.request, replacement: null }
        : state;
  }
}

export function visibleSelectionText(state: SelectionActionsState, source: string): string {
  return state.replacement ?? source;
}
