import {
  createExecutionProjector,
  expandedSyntheticEvents,
  fixtureEvidenceMatrix,
  normalizeAllFixtures,
  projectExecutions,
  replayThroughCanonicalStore,
  simulateFanOutAccounting,
  SYNTHETIC_FIXTURE_NOTICE,
} from "./child-execution-evaluator";
import { createCanonicalThreadStore, type CanonicalThreadEvent } from "@useagent/agent-client";
import { cpus, release } from "node:os";

const EVENT_COUNT = 10_000;
const WARMUPS = 10;
const ITERATIONS = 100;

function quantile(values: readonly number[], percentile: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)]!;
}

function measure(run: () => void): { medianMs: number; p95Ms: number; totalMs: number; samplesMs: number[] } {
  for (let index = 0; index < WARMUPS; index++) run();
  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return {
    medianMs: quantile(samples, 0.5),
    p95Ms: quantile(samples, 0.95),
    totalMs: samples.reduce((sum, sample) => sum + sample, 0),
    samplesMs: samples,
  };
}

function incrementalStoreMeasure(baseEventCount: number) {
  const store = createCanonicalThreadStore();
  const base = expandedSyntheticEvents(baseEventCount);
  store.batch(() => {
    for (const event of base) store.ingest(event);
  });
  store.getSnapshot();
  let seq = baseEventCount + 1;
  const template = base.find((event) => event.kind === "child.updated")!;
  return measure(() => {
    const next: CanonicalThreadEvent = {
      ...template,
      eventId: `store-incremental:${baseEventCount}:${seq}`,
      seq,
      deliverySeq: seq,
      ts: seq++,
    };
    store.ingest(next);
    store.getSnapshot();
  });
}

const fixtures = normalizeAllFixtures();
const events = expandedSyntheticEvents(EVENT_COUNT);

const syntheticContractGeneration = measure(() => {
  let normalized = 0;
  while (normalized < EVENT_COUNT) normalized += normalizeAllFixtures().length;
});
const inMemoryStoreAppendAndSnapshot = measure(() => {
  replayThroughCanonicalStore(events).getSnapshot();
});
const pureExecutionProjection = measure(() => {
  projectExecutions(events);
});
const incrementalProjector = createExecutionProjector();
for (const event of events) incrementalProjector.ingest(event);
let incrementalSeq = EVENT_COUNT + 1;
const incrementalPureExecutionProjection = measure(() => {
  incrementalProjector.ingest({
    ...events.find((event) => event.kind === "child.updated")!,
    eventId: `incremental:${incrementalSeq}`,
    seq: incrementalSeq,
    deliverySeq: incrementalSeq++,
    ts: incrementalSeq,
  });
  incrementalProjector.snapshot();
});
const inMemoryStoreReconnectReplay = measure(() => {
  const store = replayThroughCanonicalStore(events);
  store.reconcile([...events].reverse());
  store.getSnapshot();
});
const inMemoryStoreLiveUpdate1k = incrementalStoreMeasure(1_000);
const inMemoryStoreLiveUpdate10k = incrementalStoreMeasure(10_000);

const fanOutAccounting = simulateFanOutAccounting(20, 8);
const encodedFixtureBytes1k = Buffer.byteLength(JSON.stringify(expandedSyntheticEvents(1_000)));
const encodedFixtureBytes10k = Buffer.byteLength(JSON.stringify(events));
const budgets = {
  syntheticContractGeneration10kP95Ms: 50,
  inMemoryStoreAppendAndSnapshot10kP95Ms: 50,
  pureExecutionProjection100Children10kP95Ms: 50,
  incrementalPureExecutionProjectionP95Ms: 5,
  inMemoryStoreLiveUpdate1kP95Ms: 5,
  inMemoryStoreLiveUpdate10kP95Ms: 10,
  inMemoryStoreReconnectReplay10kP95Ms: 100,
};
const measured = {
  fixtureEvents: fixtures.length,
  benchmarkEvents: EVENT_COUNT,
  warmups: WARMUPS,
  iterations: ITERATIONS,
  syntheticContractGeneration,
  inMemoryStoreAppendAndSnapshot,
  pureExecutionProjection,
  incrementalPureExecutionProjection,
  inMemoryStoreLiveUpdate1k,
  inMemoryStoreLiveUpdate10k,
  inMemoryStoreReconnectReplay,
  encodedFixtureBytes: {
    at1k: encodedFixtureBytes1k,
    at10k: encodedFixtureBytes10k,
    growthRatio: encodedFixtureBytes10k / encodedFixtureBytes1k,
  },
  inMemoryStoreThroughputEventsPerSecond: Math.round(
    EVENT_COUNT / (inMemoryStoreAppendAndSnapshot.p95Ms / 1000),
  ),
  pureProjectionThroughputEventsPerSecond: Math.round(
    EVENT_COUNT / (pureExecutionProjection.p95Ms / 1000),
  ),
  fanOutAccounting,
};

const failures = [
  syntheticContractGeneration.p95Ms <= budgets.syntheticContractGeneration10kP95Ms || "syntheticContractGeneration10kP95Ms",
  inMemoryStoreAppendAndSnapshot.p95Ms <= budgets.inMemoryStoreAppendAndSnapshot10kP95Ms || "inMemoryStoreAppendAndSnapshot10kP95Ms",
  pureExecutionProjection.p95Ms <= budgets.pureExecutionProjection100Children10kP95Ms || "pureExecutionProjection100Children10kP95Ms",
  incrementalPureExecutionProjection.p95Ms <= budgets.incrementalPureExecutionProjectionP95Ms || "incrementalPureExecutionProjectionP95Ms",
  inMemoryStoreLiveUpdate1k.p95Ms <= budgets.inMemoryStoreLiveUpdate1kP95Ms || "inMemoryStoreLiveUpdate1kP95Ms",
  inMemoryStoreLiveUpdate10k.p95Ms <= budgets.inMemoryStoreLiveUpdate10kP95Ms || "inMemoryStoreLiveUpdate10kP95Ms",
  inMemoryStoreReconnectReplay.p95Ms <= budgets.inMemoryStoreReconnectReplay10kP95Ms || "inMemoryStoreReconnectReplay10kP95Ms",
  fanOutAccounting.maxRunning === 8 || "fanOutAccountingMaxRunning",
  fanOutAccounting.completed.length === 20 || "fanOutAccountingCompletion",
].filter((value): value is string => typeof value === "string");

const gitSha = new TextDecoder().decode(
  Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir }).stdout,
).trim();

const report = {
  scope: SYNTHETIC_FIXTURE_NOTICE,
  syntheticFixtureEvidence: fixtureEvidenceMatrix(),
  runtime: {
    gitSha,
    bun: Bun.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "unknown",
  },
  exclusions: [
    "real adapter parser behavior",
    "durable scheduler and lease enforcement",
    "database transactions",
    "browser paint",
    "React rendering",
    "multi-instance realtime delivery",
    "network",
    "model latency",
    "sandbox startup",
    "live provider fidelity",
    "retained JavaScript heap (GC noise makes a same-process microbenchmark non-deterministic; encoded fixture byte growth is reported instead)",
  ],
  budgets,
  measured,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  failures,
};
const reportJson = JSON.stringify(report, null, 2);
const reportPath = process.env.USEAGENT_CHILD_BENCHMARK_OUTPUT
  ?? "/tmp/useagent-child-execution-benchmark.json";
await Bun.write(reportPath, `${reportJson}\n`);
console.log(reportJson);
console.error(`raw benchmark report: ${reportPath}`);

if (failures.length > 0) process.exit(1);
