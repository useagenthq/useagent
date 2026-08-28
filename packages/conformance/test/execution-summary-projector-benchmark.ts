import { cpus, freemem, hostname, release, totalmem } from "node:os";
import { createExecutionSummaryProjector } from "@useagent/agent-client";
import {
  executionSummaryBytes,
  recomputeExecutionSummary,
} from "./execution-summary-projector";
import { executionSummaryEvents } from "./execution-summary-fixtures";

const EVENT_COUNTS = [1_000, 5_000, 10_000] as const;
const CHILD_COUNTS = [1, 20, 100] as const;
const WARMUPS = 10;
const SAMPLES = 100;

// Fixed before collecting measurements. Five times faster at 10k is large enough
// to justify an additional projection path without relying on post-hoc thresholds.
const PASS_CRITERIA = {
  minimumP95SpeedupAt10k: 5,
  minimumP95SpeedupAtEverySize: 1.5,
  maximumCorrectnessMismatches: 0,
  maximumRetainedSlotContributionsPerChildAfterCompaction: 17,
} as const;

interface Distribution {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly meanMs: number;
  readonly maxMs: number;
  readonly samplesMs: readonly number[];
}

function quantile(values: readonly number[], percentile: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]!;
}

function distribution(samplesMs: readonly number[]): Distribution {
  return {
    medianMs: quantile(samplesMs, 0.5),
    p95Ms: quantile(samplesMs, 0.95),
    meanMs: samplesMs.reduce((sum, sample) => sum + sample, 0) / samplesMs.length,
    maxMs: Math.max(...samplesMs),
    samplesMs,
  };
}

function benchmarkCase(eventCount: number, childCount: number) {
  const allEvents = executionSummaryEvents(eventCount + WARMUPS + SAMPLES, childCount);
  const history = allEvents.slice(0, eventCount);
  const updates = allEvents.slice(eventCount);
  const incremental = createExecutionSummaryProjector();
  for (const event of history) incremental.ingest(event);

  const baselineSamples: number[] = [];
  const candidateSamples: number[] = [];
  let correctnessMismatches = 0;

  for (let index = 0; index < updates.length; index++) {
    const update = updates[index]!;
    let baselineBytes = "";
    let candidateBytes = "";
    const candidateFirst = index % 2 === 1;

    const baseline = () => {
      const started = performance.now();
      history.push(update);
      baselineBytes = executionSummaryBytes(recomputeExecutionSummary(history));
      return performance.now() - started;
    };
    const candidate = () => {
      const started = performance.now();
      incremental.ingest(update);
      candidateBytes = executionSummaryBytes(incremental.snapshot());
      return performance.now() - started;
    };

    let baselineMs: number;
    let candidateMs: number;
    if (candidateFirst) {
      candidateMs = candidate();
      baselineMs = baseline();
    } else {
      baselineMs = baseline();
      candidateMs = candidate();
    }
    if (baselineBytes !== candidateBytes) correctnessMismatches++;
    if (index >= WARMUPS) {
      baselineSamples.push(baselineMs);
      candidateSamples.push(candidateMs);
    }
  }

  const baseline = distribution(baselineSamples);
  const candidate = distribution(candidateSamples);
  const pairedSpeedups = baselineSamples.map((sample, index) => sample / candidateSamples[index]!);
  const beforeCompaction = executionSummaryBytes(incremental.snapshot());
  const retentionBeforeCompaction = incremental.retention();
  const retentionAfterCompaction = incremental.compactThrough(updates.at(-1)!.deliverySeq);
  const compactionPreservedSnapshot = executionSummaryBytes(incremental.snapshot()) === beforeCompaction;
  return {
    eventCount,
    childCount,
    warmups: WARMUPS,
    samples: SAMPLES,
    correctnessMismatches,
    summaryBytes: Buffer.byteLength(beforeCompaction),
    retentionBeforeCompaction,
    retentionAfterCompaction,
    compactionPreservedSnapshot,
    baseline,
    candidate,
    speedup: {
      median: baseline.medianMs / candidate.medianMs,
      p95: baseline.p95Ms / candidate.p95Ms,
      mean: baseline.meanMs / candidate.meanMs,
      paired: {
        p05: quantile(pairedSpeedups, 0.05),
        median: quantile(pairedSpeedups, 0.5),
        p95: quantile(pairedSpeedups, 0.95),
        minimum: Math.min(...pairedSpeedups),
        samples: pairedSpeedups,
      },
    },
  };
}

const measurements = CHILD_COUNTS.flatMap((childCount) =>
  EVENT_COUNTS.map((eventCount) => benchmarkCase(eventCount, childCount))
);
const at = (childCount: number, eventCount: number) =>
  measurements.find(
    (measurement) => measurement.childCount === childCount && measurement.eventCount === eventCount,
  )!;
const failures = [
  ...measurements.flatMap((measurement) => [
    measurement.correctnessMismatches <= PASS_CRITERIA.maximumCorrectnessMismatches
      ? null
      : `correctness-mismatch-${measurement.eventCount}`,
    measurement.speedup.p95 >= PASS_CRITERIA.minimumP95SpeedupAtEverySize
      ? null
      : `p95-speedup-below-${PASS_CRITERIA.minimumP95SpeedupAtEverySize}x-${measurement.eventCount}`,
    measurement.compactionPreservedSnapshot
      ? null
      : `compaction-changed-snapshot-${measurement.childCount}-${measurement.eventCount}`,
    measurement.retentionAfterCompaction.acceptedEvents === 0
      ? null
      : `accepted-events-retained-after-compaction-${measurement.childCount}-${measurement.eventCount}`,
    measurement.retentionAfterCompaction.pendingContributions === 0
      ? null
      : `orphans-retained-after-compaction-${measurement.childCount}-${measurement.eventCount}`,
    measurement.retentionAfterCompaction.slotContributions
      <= measurement.childCount * PASS_CRITERIA.maximumRetainedSlotContributionsPerChildAfterCompaction
      ? null
      : `slot-contributions-unbounded-after-compaction-${measurement.childCount}-${measurement.eventCount}`,
  ]),
  ...CHILD_COUNTS.map((childCount) =>
    at(childCount, 10_000).speedup.p95 >= PASS_CRITERIA.minimumP95SpeedupAt10k
      ? null
      : `p95-speedup-below-${PASS_CRITERIA.minimumP95SpeedupAt10k}x-${childCount}-children-10000`
  ),
].filter((failure): failure is string => failure !== null);

const git = (args: readonly string[]) => new TextDecoder().decode(
  Bun.spawnSync(["git", ...args], { cwd: import.meta.dir }).stdout,
).trim();
const report = {
  benchmark: "two-level-execution-summary-projector",
  claim: "Incremental bounded summary projection is faster than rebuilding the same summary from full canonical history after every update.",
  scope: "Local CPU and in-memory projection only; provider network, model latency, sandbox startup, database I/O, and browser paint are excluded variables.",
  passCriteria: PASS_CRITERIA,
  design: {
    baseline: "dedupe full canonical history, rank accepted contributions, rebuild all child summaries, serialize snapshot",
    candidate: "production @useagent/agent-client projector: compact event-version register, per-child slots, delegation edges, serialize snapshot",
    candidateRetainsFullTranscripts: false,
    candidateRequiresCompactionForBoundedBookkeeping: true,
    liveUpdateMeasurement: "both paths receive the same next event; history/projector initialization is outside the timed update",
    compactionMeasurement: "retention is inspected before and after compacting through the final durable delivery sequence; compaction is outside timed update samples",
    ordering: "baseline and candidate timing order alternates every sample",
    fixtureSeed: "deterministic summary-event ordinal stream",
  },
  runtime: {
    timestamp: new Date().toISOString(),
    gitSha: git(["rev-parse", "HEAD"]),
    gitStatus: git(["status", "--short"]),
    bun: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    hostname: hostname(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtReport: freemem(),
  },
  measurements,
  scaling: CHILD_COUNTS.map((childCount) => ({
    childCount,
    baselineP95Ratio10kTo1k:
      at(childCount, 10_000).baseline.p95Ms / at(childCount, 1_000).baseline.p95Ms,
    candidateP95Ratio10kTo1k:
      at(childCount, 10_000).candidate.p95Ms / at(childCount, 1_000).candidate.p95Ms,
    summaryByteRatio10kTo1k:
      at(childCount, 10_000).summaryBytes / at(childCount, 1_000).summaryBytes,
  })),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  failures,
};

const reportJson = JSON.stringify(report, null, 2);
const reportPath = process.env.USEAGENT_EXECUTION_SUMMARY_BENCHMARK_OUTPUT
  ?? "/tmp/useagent-execution-summary-benchmark.json";
await Bun.write(reportPath, `${reportJson}\n`);
console.log(JSON.stringify({
  benchmark: report.benchmark,
  verdict: report.verdict,
  failures: report.failures,
  measurements: report.measurements.map((measurement) => ({
    children: measurement.childCount,
    events: measurement.eventCount,
    correctnessMismatches: measurement.correctnessMismatches,
    baselineP95Ms: measurement.baseline.p95Ms,
    candidateP95Ms: measurement.candidate.p95Ms,
    p95Speedup: measurement.speedup.p95,
    pairedP05Speedup: measurement.speedup.paired.p05,
    summaryBytes: measurement.summaryBytes,
    retentionBeforeCompaction: measurement.retentionBeforeCompaction,
    retentionAfterCompaction: measurement.retentionAfterCompaction,
    compactionPreservedSnapshot: measurement.compactionPreservedSnapshot,
  })),
}, null, 2));
console.error(`raw benchmark report: ${reportPath}`);

if (failures.length > 0) process.exit(1);
