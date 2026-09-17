// extensions/tests/spawn-outcome-r2.test.ts — R2 walker discrimination tests (design-v0.2 (v)).
// Run: node --experimental-strip-types spawn-outcome-r2.test.ts   (from extensions/tests/)
//
// Imports the ZERO-DEP spawn-outcome.ts module directly (same constraint as spawn-outcome.test.ts).
// Covers: isMinidcRefusal predicate, shouldWalkAfterFailure gate (marker = secondary defense),
// both documented failure directions (C3), and a SOURCE-WIRING lock proving spawn.ts actually
// consults the new gate at both walk sites (the 11-test list alone cannot catch an unwired predicate).
import { isMinidcRefusal, shouldWalkAfterFailure } from "../orchestration-engine/spawn-outcome.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

// ── isMinidcRefusal predicate ────────────────────────────────────────────────────
check("marker in output ⇒ refusal", isMinidcRefusal("result: 🛑 BLOCKED by mini-dc (headless ASK→deny): git commit — …"));
check("marker in inbandError ⇒ refusal", isMinidcRefusal("partial text", "🛑 BLOCKED by mini-dc: rm -rf — denied"));
check("no marker anywhere ⇒ not refusal", isMinidcRefusal("normal output", undefined) === false);
check("empty strings ⇒ not refusal", isMinidcRefusal("", undefined) === false);

// ── shouldWalkAfterFailure: refusal never walks (7, 8) ──────────────────────────
check("(7) output marker ⇒ NO walk", shouldWalkAfterFailure(300, undefined, false, "🛑 BLOCKED by mini-dc (headless ASK→deny): …") === false);
check("(8) inbandError marker ⇒ NO walk", shouldWalkAfterFailure(0, "🛑 BLOCKED by mini-dc: stash drop", false, "") === false);

// ── genuine model failures still walk (9, 10 — regression locks) ────────────────
check("(9) plain empty output ⇒ walk (quota exhaustion regression lock)", shouldWalkAfterFailure(0, undefined, false, "") === true);
check("(10) 429 in-band error without marker ⇒ walk", shouldWalkAfterFailure(120, "429: GoUsageLimitError", false, "partial output…") === true);
check("timeout still aborts chain (Edit-7 lock, unchanged)", shouldWalkAfterFailure(0, undefined, true, "") === false);

// ── C3 documented failure directions, locked (11) ───────────────────────────────
check("(11a) refusal + EMPTY output ⇒ walk fires (accepted false-negative residual)", shouldWalkAfterFailure(0, undefined, false, "") === true);
check("(11b) marker echo + genuine later error ⇒ walk suppressed (accepted false-positive)", shouldWalkAfterFailure(200, "429: quota", false, "earlier: BLOCKED by mini-dc text quoted…") === false);

// ── SOURCE-WIRING lock (crew finding 4): spawn.ts consults the gate at both sites ─
const spawnSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "orchestration-engine", "spawn.ts"), "utf8");
const walkGateUses = spawnSrc.split("shouldWalkAfterFailure(").length - 1;
check("spawn.ts consults shouldWalkAfterFailure at BOTH walk sites (entry + hop)", walkGateUses >= 2);
check("spawn.ts hop site guards refusals via isMinidcRefusal", spawnSrc.includes("isMinidcRefusal(fbResult.output"));
check("spawn.ts imports the R2 gate", spawnSrc.includes("shouldWalkAfterFailure") && spawnSrc.includes("isMinidcRefusal"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
