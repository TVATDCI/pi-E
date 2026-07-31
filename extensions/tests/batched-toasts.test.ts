// extensions/tests/batched-toasts.test.ts — formatBatchedToast + batcher logic tests.
// Run: node --experimental-strip-types batched-toasts.test.ts (from extensions/tests/)
import { formatBatchedToast, type BgCompletion } from "../background-helpers.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

const mk = (chainName: string, durationMs: number, preview: string): BgCompletion => ({ chainName, durationMs, preview });

// --- single completion → same format as individual toast ---
const single = formatBatchedToast([mk("scout-twice", 45000, "Found 107 files")]);
check("single: ✓ + chain + seconds", single.includes("✓ scout-twice") && single.includes("45s"));
check("single: preview body", single.includes("Found 107 files"));
check("single: no group header (just one)", !single.includes("(1)"));

// --- multiple completions → grouped format ---
const multi = formatBatchedToast([
  mk("scout-twice", 45000, "Found 107 files"),
  mk("commit-message", 12000, "feat: add handoff"),
  mk("build", 60000, "Build succeeded"),
]);
check("multi: group header with count (3)", multi.includes("(3)"));
check("multi: all three chain names in header", multi.includes("scout-twice") && multi.includes("commit-message") && multi.includes("build"));
check("multi: all three ✓ glyphs in header", (multi.match(/✓/g) ?? []).length === 3);
check("multi: per-completion detail lines", multi.includes("scout-twice · 45s") && multi.includes("commit-message · 12s"));

// --- empty preview → (no output) ---
const emptyPreview = formatBatchedToast([mk("test", 5000, "")]);
check("empty preview: (no output)", emptyPreview.includes("(no output)"));

// --- long preview truncated (single: 300 chars, multi: 200 chars) ---
const longSingle = formatBatchedToast([mk("test", 1000, "A".repeat(500))]);
check("single: preview truncated to ≤300+body", longSingle.includes("A".repeat(300)) && !longSingle.includes("A".repeat(301)));
const longMulti = formatBatchedToast([mk("test1", 1000, "B".repeat(500)), mk("test2", 2000, "C")]);
const detailLine = longMulti.split("\n").find((l) => l.includes("B".repeat(10)));
check("multi: preview truncated (200 Bs in detail, 500 not)", detailLine?.includes("B".repeat(200)) === true && detailLine?.includes("B".repeat(201)) === false);

// --- two completions → grouped (not single) ---
const two = formatBatchedToast([mk("a", 1000, "x"), mk("b", 2000, "y")]);
check("two: group header (2)", two.includes("(2)"));
check("two: both names", two.includes("✓ a") && two.includes("✓ b"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);