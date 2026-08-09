/**
 * MECHANICAL dev/build cache-isolation proof.
 *
 * The dev server and a production build MUST use different Turbopack distDirs so a build can
 * never poison (or be poisoned by) a running dev server's compiled cache - the corruption that
 * 500'd :3401. next.config.ts now enforces this by PHASE: `next build`/`next start` default to
 * `.next-build`, the dev server keeps `.next`. This script proves the property end to end:
 *   1. boot a dev server (isolated `.next-caveiso-dev` so it can't touch the real :3401 `.next`)
 *   2. GET /agent/new repeatedly -> all 200 (BEFORE)
 *   3. run a production build (DEFAULT distDir -> `.next-build`, a different dir)
 *   4. GET /agent/new repeatedly -> STILL all 200 (AFTER) - the build did not corrupt dev
 *
 * Not a `bun test` unit (it boots a dev server + runs a build). Run: `bun test/cache-isolation-e2e.ts`.
 * Nonzero exit on any non-200.
 */
import { openSync, rmSync, readFileSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.CACHEISO_PORT ?? 3467);
const BASE = `http://localhost:${PORT}`;
const DEV_DIST = ".next-caveiso-dev";
const BUILD_DIST = ".next-build"; // the phase-default build dir (must differ from DEV_DIST)
const frontendDir = new URL("..", import.meta.url).pathname;
const scratch = process.env.SCRATCH_DIR ?? "/tmp";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const checks: { name: string; ok: boolean; note?: string }[] = [];
const ok = (name: string, cond: boolean, note = "") => {
  checks.push({ name, ok: cond, note });
  console.log(`  ${cond ? "OK " : "XX "} ${name}${note ? ` - ${note}` : ""}`);
};

async function code(path: string, timeoutMs = 30_000): Promise<number> {
  try {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.status;
  } catch {
    return 0;
  }
}
async function poll(path: string, n: number, label: string): Promise<boolean> {
  let all = true;
  for (let i = 1; i <= n; i++) {
    const c = await code(path);
    if (c !== 200) all = false;
    console.log(`    ${label} req ${i} -> ${c}`);
  }
  return all;
}

let dev: ReturnType<typeof Bun.spawn> | null = null;
let build: ReturnType<typeof Bun.spawn> | null = null;
// `next build` rewrites tsconfig.json (adds the distDir types) - snapshot + restore it.
const tsconfigPath = `${frontendDir}/tsconfig.json`;
const tsconfigBefore = readFileSync(tsconfigPath, "utf8");
try {
  console.log(`[cache-iso] dev distDir=${DEV_DIST} on :${PORT}, build distDir=${BUILD_DIST}`);
  rmSync(`${frontendDir}/${DEV_DIST}`, { recursive: true, force: true });
  rmSync(`${frontendDir}/${BUILD_DIST}`, { recursive: true, force: true });

  const devLog = openSync(`${scratch}/cacheiso-dev.log`, "a");
  dev = Bun.spawn(["bun", "run", "dev", "--port", String(PORT)], {
    cwd: frontendDir,
    env: { ...process.env, SKYNET_BUILD_DIST: DEV_DIST },
    stdout: devLog,
    stderr: devLog,
  });

  // wait for the dev server to answer at all (first compile), budget 120s
  const deadline = Date.now() + 120_000;
  let up = false;
  while (Date.now() < deadline) {
    if ((await code("/agent/new", 5_000)) === 200) { up = true; break; }
    await sleep(2000);
  }
  ok("dev server boots + first /agent/new is 200", up);

  ok("BEFORE build: 5x /agent/new all 200", up && (await poll("/agent/new", 5, "before")));

  // production build to the PHASE-DEFAULT dir (no SKYNET_BUILD_DIST -> .next-build)
  const buildLog = openSync(`${scratch}/cacheiso-build.log`, "a");
  const buildEnv = { ...process.env };
  delete buildEnv.SKYNET_BUILD_DIST; // prove the DEFAULT isolation, not an override
  build = Bun.spawn(["bun", "run", "build"], { cwd: frontendDir, env: buildEnv, stdout: buildLog, stderr: buildLog });
  const buildExit = await build.exited;
  ok("isolated production build succeeded (distDir .next-build)", buildExit === 0, `exit ${buildExit}`);

  ok("AFTER build: 5x /agent/new STILL all 200 (build did not poison the dev cache)", await poll("/agent/new", 5, "after"));
} catch (e) {
  ok("no fatal error", false, e instanceof Error ? e.message : String(e));
} finally {
  dev?.kill();
  build?.kill();
  await sleep(1000);
  rmSync(`${frontendDir}/${DEV_DIST}`, { recursive: true, force: true });
  rmSync(`${frontendDir}/${BUILD_DIST}`, { recursive: true, force: true });
  if (readFileSync(tsconfigPath, "utf8") !== tsconfigBefore) writeFileSync(tsconfigPath, tsconfigBefore);
  const fails = checks.filter((c) => !c.ok);
  console.log(`\n${fails.length === 0 ? "✅ PASS" : "❌ FAIL"} - ${checks.length - fails.length}/${checks.length}`);
  process.exit(fails.length === 0 ? 0 : 1);
}
