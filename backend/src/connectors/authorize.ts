// Ported from a peer tool (Apache-2.0): src/kiro_crew/slack/transport.py (authorize)
// Ported from a peer tool (Apache-2.0): src/kiro_crew/telegram/transport.py (authorize)
//
// The deny-by-default allow-list model, extracted into one reusable primitive.

/**
 * A deny-by-default owner allow-list, frozen at construction.
 *
 * Ports a peer tool's transport `authorize` model: every concrete transport copies
 * its allow-list into an immutable set at construction (`frozenset(...)`) so the
 * list can never mutate under an in-flight authorization decision, and an
 * UNCONFIGURED transport (empty allow-list) authorizes NOBODY — never everybody
 * (fail closed). A blank / missing id is always denied, so deny-by-default stays
 * observable even for empty input.
 */
export class AllowList {
  readonly #allowed: ReadonlySet<string>;

  constructor(entries: Iterable<string> = []) {
    // Copy into a fresh set (so a caller can't mutate it post-construction) and
    // drop blanks (so an empty id can never slip in as an allowed principal).
    this.#allowed = new Set(
      [...entries].map((e) => e.trim()).filter((e) => e !== ""),
    );
  }

  /** True iff `id` is a non-empty, allow-listed principal. Deny-by-default. */
  authorize(id: string): boolean {
    const trimmed = id.trim();
    return trimmed !== "" && this.#allowed.has(trimmed);
  }

  /** Alias for `authorize`, reads naturally at membership call sites. */
  has(id: string): boolean {
    return this.authorize(id);
  }

  get size(): number {
    return this.#allowed.size;
  }

  /** The allowed principals, sorted (for stable dashboard listing). */
  values(): string[] {
    return [...this.#allowed].sort();
  }
}
