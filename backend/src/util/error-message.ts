// Uniform message extraction for an unknown catch value. Prefer a real Error's
// message; otherwise stringify. Replaces the repeated
// `e instanceof Error ? e.message : String(e)` ternary across the backend.

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
