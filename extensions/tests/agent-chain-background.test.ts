// extensions/tests/agent-chain-background.test.ts — Group 3 background pure-helper tests.
// Run: node --experimental-strip-types agent-chain-background.test.ts   (from extensions/tests/)
//
// Covers the user-facing logic of background dispatch: the /stop-vs-failure status distinction
// (resolveBgStatus) and the toast format (icon/status/duration/preview-truncation). The registry,
// cap enforcement, and live spawn are integration paths covered by the operator smoke test.
import { resolveBgStatus, formatBgToast } from "../background-helpers.ts";

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

// --- resolveBgStatus: /stop abort must be distinct from a natural failure ---
check("resolveBgStatus: /stop abort ⇒ stopped", resolveBgStatus(true, false) === "stopped");
check("resolveBgStatus: stopped wins even if result ok", resolveBgStatus(true, true) === "stopped");
check("resolveBgStatus: natural success ⇒ completed", resolveBgStatus(false, true) === "completed");
check("resolveBgStatus: natural failure ⇒ failed", resolveBgStatus(false, false) === "failed");

// --- formatBgToast: icon + status + name + duration + preview ---
const completed = formatBgToast("scout-twice", "completed", 45000, "found 107 .ts files");
check("toast[completed]: ✓ icon + chain + seconds", completed.includes("✓") && completed.includes("scout-twice") && completed.includes("45s"));
check("toast[completed]: status word", completed.includes("completed"));
check("toast[completed]: preview body", completed.includes("found 107 .ts files"));

const failed = formatBgToast("build", "failed", 3000, "error: tests failed");
check("toast[failed]: ✗ icon + status", failed.includes("✗") && failed.includes("failed"));

const stopped = formatBgToast("scout-twice", "stopped", 10000, "partial output");
check("toast[stopped]: ■ icon DISTINCT from failed ✗", stopped.includes("■") && !stopped.includes("✗") && stopped.includes("stopped"));

const empty = formatBgToast("x", "completed", 0, "");
check("toast: empty preview ⇒ (no output)", empty.includes("(no output)"));

const long = formatBgToast("x", "completed", 0, "A".repeat(2000));
check("toast: preview truncated to ≤600 chars", long.includes("A".repeat(600)) && !long.includes("A".repeat(601)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
