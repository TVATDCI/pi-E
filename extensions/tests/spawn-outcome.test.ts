// extensions/tests/spawn-outcome.test.ts — Edit 7: classifySpawnOutcome pure-function tests.
// Run: node --experimental-strip-types spawn-outcome.test.ts   (from extensions/tests/)
//
// Imports the ZERO-DEP spawn-outcome.ts module directly (NOT spawn.ts — it has external
// @earendil-works deps; see spawn-wiring.test.ts header for the same constraint). Covers the full
// precedence table: aborted > timeout > done/error, incl. the race-window and exit-code edges.
import { classifySpawnOutcome } from "../orchestration-engine/spawn-outcome.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

// ── base outcomes (no kill cause) ────────────────────────────────────────────────
check("code 0, no cause ⇒ done", classifySpawnOutcome({ timedOut: false, aborted: false, code: 0 }) === "done");
check("code 1, no cause ⇒ error", classifySpawnOutcome({ timedOut: false, aborted: false, code: 1 }) === "error");
check("code 143 (SIGTERM-killed), no cause ⇒ error", classifySpawnOutcome({ timedOut: false, aborted: false, code: 143 }) === "error");

// ── single kill cause ────────────────────────────────────────────────────────────
check("timedOut, not aborted ⇒ timeout", classifySpawnOutcome({ timedOut: true, aborted: false, code: 143 }) === "timeout");
check("timeout beats a clean exit code (timedOut + code 0 ⇒ timeout)", classifySpawnOutcome({ timedOut: true, aborted: false, code: 0 }) === "timeout");
check("aborted, not timedOut ⇒ aborted", classifySpawnOutcome({ timedOut: false, aborted: true, code: 143 }) === "aborted");
check("aborted beats a clean exit code (aborted + code 0 ⇒ aborted)", classifySpawnOutcome({ timedOut: false, aborted: true, code: 0 }) === "aborted");

// ── precedence: aborted > timeout (operator's Q1 flip) ───────────────────────────
check("race window (aborted + timedOut) ⇒ aborted wins", classifySpawnOutcome({ timedOut: true, aborted: true, code: 143 }) === "aborted");
check("race window with clean exit ⇒ aborted still wins", classifySpawnOutcome({ timedOut: true, aborted: true, code: 0 }) === "aborted");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
