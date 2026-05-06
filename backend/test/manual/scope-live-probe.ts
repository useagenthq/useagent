/**
 * LIVE per-user isolation probe against the REAL Tencent memory gateway
 * (MEMORY_API_URL, default :8420). NOT in `bun test` — it writes to and reads
 * from the live service. Run:  bun run test/manual/scope-live-probe.ts
 *
 * Proves the memory-scope partition end to end against the real service:
 *   - writes an ORG fact to the org pool (user_id = org:<team>) and a PERSONAL
 *     fact to Alice's personal pool (user_id = alice);
 *   - Alice (personal scope → [personal, org]) eventually recalls BOTH;
 *   - Bob (personal scope → [bob, org]) recalls the ORG fact but NEVER the
 *     personal one — the security gate (a partition property, independent of the
 *     gateway's async L0→L1 distillation timing);
 *   - Alice under ORG scope (→ [org]) does NOT surface her personal fact (org
 *     scope never reads a personal pool).
 *
 * HARD gates (fail → exit 1): Bob never sees Alice's personal fact; org scope
 * never surfaces a personal fact. Recall-COMPLETENESS (Alice sees her fact / the
 * org fact within the budget) is best-effort: the gateway's distillation is async
 * and cold-start is non-deterministic (documented in the progress log), so a miss
 * there is reported honestly, not a failure of the scope logic.
 */
import { deliverTeamMemory, searchScopedMemory, type MemoryIdentity, type ScopedPool } from "../../src/memory/team-memory";
import { memoryConfig } from "../../src/env";

const cfg = memoryConfig();
if (!cfg) {
  console.error("MEMORY_API_URL is unset — cannot run the live probe.");
  process.exit(2);
}
console.log(`[probe] live gateway: ${cfg.url}`);

const TS = Date.now();
const team = `memscope-live-${TS}`;
const session = `thread-${TS}`;
const alice = `alice-${TS}`;
const bob = `bob-${TS}`;
const orgPoolUser = `org:${team}`;

const ORG_TOKEN = `ORGWIN-${TS}`;
const PRIV_TOKEN = `PRIV-${TS}`;
const ORG_FACT = `The organization-wide deploy window identifier is ${ORG_TOKEN}.`;
const PRIV_FACT = `Alice's personal laptop asset tag is ${PRIV_TOKEN}.`;

const ident = (userId: string): MemoryIdentity => ({
  teamId: team,
  agentId: cfg.agentId,
  userId,
  actorUserId: userId,
  sessionId: session,
});
const orgPool = (): ScopedPool => ({ sourceScope: "org", identity: ident(orgPoolUser) });
const personalPool = (u: string): ScopedPool => ({ sourceScope: "personal", identity: ident(u) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True if `needle` appears in any recalled item across `pools`. */
async function visible(query: string, pools: readonly ScopedPool[], needle: string): Promise<boolean> {
  const recall = await searchScopedMemory(query, pools);
  return recall.items.some((i) => i.content.includes(needle));
}

async function main(): Promise<void> {
  console.log(`[probe] team=${team} alice=${alice} bob=${bob} orgPool=${orgPoolUser}`);
  // Write the two facts into their pools (L0 turns; the gateway distills to L1).
  const wOrg = await deliverTeamMemory({ prompt: `Team note: ${ORG_FACT}`, summary: ORG_FACT }, ident(orgPoolUser));
  const wPriv = await deliverTeamMemory({ prompt: `Personal note: ${PRIV_FACT}`, summary: PRIV_FACT }, ident(alice));
  console.log(`[probe] wrote org fact ok=${wOrg}, personal fact ok=${wPriv}`);
  if (!wOrg || !wPriv) {
    console.error("[probe] a write to the live gateway FAILED — aborting.");
    process.exit(1);
  }

  const orgQuery = "what is the organization-wide deploy window identifier?";
  const privQuery = "what is Alice's personal laptop asset tag?";

  let aliceSeesPriv = false;
  let aliceSeesOrg = false;
  let bobSeesOrg = false;
  let hardFail = false;

  // Budget for the gateway's async L0→L1 distillation (cold-start is slow/non-
  // deterministic on the beta service). Override with PROBE_BUDGET_MS.
  const deadline = Date.now() + Number(process.env.PROBE_BUDGET_MS ?? 120_000);
  let round = 0;
  while (Date.now() < deadline) {
    round++;
    // Best-effort completeness.
    if (!aliceSeesPriv) aliceSeesPriv = await visible(privQuery, [personalPool(alice), orgPool()], PRIV_TOKEN);
    if (!aliceSeesOrg) aliceSeesOrg = await visible(orgQuery, [personalPool(alice), orgPool()], ORG_TOKEN);
    if (!bobSeesOrg) bobSeesOrg = await visible(orgQuery, [personalPool(bob), orgPool()], ORG_TOKEN);

    // HARD gates — checked every round; must ALWAYS hold.
    const bobSeesPriv = await visible(privQuery, [personalPool(bob), orgPool()], PRIV_TOKEN);
    const orgScopeSeesPriv = await visible(privQuery, [orgPool()], PRIV_TOKEN);
    if (bobSeesPriv) {
      console.error(`  ❌ ISOLATION BREACH: Bob recalled Alice's personal fact (${PRIV_TOKEN})`);
      hardFail = true;
      break;
    }
    if (orgScopeSeesPriv) {
      console.error(`  ❌ SCOPE BREACH: org scope surfaced a personal fact (${PRIV_TOKEN})`);
      hardFail = true;
      break;
    }
    console.log(
      `  round ${round}: alicePriv=${aliceSeesPriv} aliceOrg=${aliceSeesOrg} bobOrg=${bobSeesOrg} ` +
        `| bobPriv=false orgScopePriv=false (isolation holding)`,
    );
    if (aliceSeesPriv && aliceSeesOrg && bobSeesOrg) break;
    await sleep(6000);
  }

  console.log("\n── LIVE PROBE RESULT ──");
  console.log(`  [HARD] Bob never recalled Alice's personal fact:      ${!hardFail ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  [HARD] org scope never surfaced a personal fact:      ${!hardFail ? "✅ PASS" : "❌ FAIL"}`);
  console.log(`  [soft] Alice recalled her personal fact:              ${aliceSeesPriv ? "✅" : "⏳ not within budget (async distill)"}`);
  console.log(`  [soft] Alice recalled the org fact:                   ${aliceSeesOrg ? "✅" : "⏳ not within budget (async distill)"}`);
  console.log(`  [soft] Bob recalled the shared org fact:              ${bobSeesOrg ? "✅" : "⏳ not within budget (async distill)"}`);

  // Only the isolation gates fail the probe; distillation timing does not.
  process.exit(hardFail ? 1 : 0);
}

await main();
