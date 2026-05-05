// Ad-hoc engine bake-off harness (not part of `bun test`). Usage:
//   bun test/bakeoff.ts <engine> "<prompt>"
const [engine, prompt] = [process.argv[2]!, process.argv[3]!];
const BASE = "http://localhost:3201";

const post = await fetch(`${BASE}/api/runs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ prompt, engine }),
});
if (post.status !== 201) {
  console.error("POST failed", post.status, await post.text());
  process.exit(1);
}
const { id } = (await post.json()) as { id: string };
console.log(`run id: ${id}  engine: ${engine}`);

const deadline = Date.now() + 200_000;
let run: any;
for (;;) {
  run = await (await fetch(`${BASE}/api/runs/${id}`)).json();
  if (run.status === "completed" || run.status === "failed") break;
  if (Date.now() > deadline) {
    console.error("timed out polling");
    break;
  }
  await new Promise((r) => setTimeout(r, 1500));
}

console.log(`\nstatus: ${run.status}`);
console.log(`engine (persisted): ${run.engine}`);
console.log(`duration_ms: ${run.duration_ms}`);
console.log(`summary: ${JSON.stringify(run.summary)}`);
console.log(`\nsteps (${run.steps.length}):`);
for (const s of run.steps) {
  console.log(`  [${s.idx}] ${s.kind.padEnd(8)} chip=${String(s.chip).padEnd(6)} ${s.label}`);
}

// Verify the artifact on disk.
const path = `${import.meta.dir}/../.runs/${id}/greeting.txt`;
const f = Bun.file(path);
if (await f.exists()) {
  console.log(`\ngreeting.txt: ${JSON.stringify(await f.text())}  @ .runs/${id}/greeting.txt`);
} else {
  console.log(`\ngreeting.txt: MISSING at ${path}`);
}
