/**
 * Storm result contract + a tiny invariant recorder. Each storm script builds a
 * StormResult and prints it as a single `SOAK_RESULT=<json>` line; the
 * orchestrator (run.ts) parses that line, accumulates cumulative stats, and
 * surfaces defects. Keeping the contract here means storms and orchestrator can't
 * drift.
 */

/** A concrete invariant violation — everything the lead needs to reproduce it. */
export interface Defect {
  storm: string;
  invariant: string;
  detail: string;
  /** Reproduction context: seed, crash phase, ids, counts. */
  evidence: Record<string, unknown>;
  seed?: number | string;
  phase?: string;
}

export interface StormResult {
  storm: string;
  ok: boolean;
  iterations: number; // logical scenarios exercised this cycle
  checks: number; // invariant assertions made
  failures: number; // assertions that failed
  defects: Defect[];
  stats: Record<string, number>;
  ms: number;
  /** Commit the storm ran against (filled by the orchestrator if absent). */
  head?: string;
}

/** Accumulates checks/defects for one storm cycle. */
export class Recorder {
  checks = 0;
  failures = 0;
  readonly defects: Defect[] = [];
  readonly stats: Record<string, number> = {};

  constructor(readonly storm: string) {}

  /** Record an invariant. On failure, capture a defect with full evidence. */
  check(ok: boolean, invariant: string, detail: string, evidence: Record<string, unknown> = {}): boolean {
    this.checks++;
    if (!ok) {
      this.failures++;
      this.defects.push({ storm: this.storm, invariant, detail, evidence, seed: evidence.seed as number, phase: evidence.phase as string });
    }
    return ok;
  }

  bump(key: string, by = 1): void {
    this.stats[key] = (this.stats[key] ?? 0) + by;
  }

  result(ms: number, iterations: number): StormResult {
    return {
      storm: this.storm,
      ok: this.failures === 0,
      iterations,
      checks: this.checks,
      failures: this.failures,
      defects: this.defects,
      stats: this.stats,
      ms,
    };
  }

  /** Print the machine-readable line the orchestrator greps, then exit. */
  emit(ms: number, iterations: number): never {
    const r = this.result(ms, iterations);
    console.log(`SOAK_RESULT=${JSON.stringify(r)}`);
    process.exit(r.ok ? 0 : 1);
  }
}

/** Deterministic PRNG (mulberry32) so a storm cycle is reproducible from a seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
