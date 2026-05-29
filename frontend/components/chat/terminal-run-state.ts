import type { Turn } from "./conversation";

/** A failed turn with no provider session never reached a sandbox runtime. Do
 * not point the PTY at that run: the Terminal should stay on its honest idle log
 * instead of entering a reconnect loop for a sandbox that never existed. */
export function terminalRunIdForThread(
  turns: readonly Pick<Turn, "status" | "run">[],
): string | undefined {
  return [...turns].reverse().find((turn) => !!turn.run.engine_session_id)?.run.id;
}
