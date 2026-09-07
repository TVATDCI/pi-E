// extensions/tests/bd-bridge-status.test.ts — tri-state bridge health (missing/stale/fresh).
// Regression lock for the 2026-09-07 diagnostic finding: a MISSING export file logged
// telemetry "stale=fresh" and injected nothing — the dead pipe was invisible in-turn.
// Pure tests: bridgeStatus() is disk-free by construction.

import { bridgeStatus } from "../bd-bridge.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}`);
  }
}

check("missing: null timestamp (file absent/empty) => missing", bridgeStatus(null, null) === "missing");
check("stale: timestamp + checkStale hit => stale", bridgeStatus("2026-09-07T00:00:00Z", "stale") === "stale");
check("fresh: timestamp + no staleness => fresh", bridgeStatus("2026-09-07T00:00:00Z", null) === "fresh");
check(
  "missing wins over contradictory stale signal (no timestamp => missing regardless)",
  bridgeStatus(null, "stale") === "missing",
);

console.log(`\nbd-bridge-status: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
