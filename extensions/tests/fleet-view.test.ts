// extensions/tests/fleet-view.test.ts — formatFleet snapshot + ordering + cap tests.
// Run: node --experimental-strip-types fleet-view.test.ts   (from extensions/tests/)
import { formatFleet, type FleetEntry } from "../background-helpers.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

const mkEntry = (id: number, chainName: string, status: string, elapsed = 0, background = false): FleetEntry => ({
  id, chainName, status, elapsed, background,
  steps: status === "running"
    ? [{ name: "scout", status: "running", modelFlag: "zai/glm-4.7", toolCount: 3, usage: { contextTokens: 4200 } }]
    : [{ name: "scout", status: "done" }],
});

// --- empty state ---
check("empty: returns 'No chain runs'", formatFleet([])[0]?.includes("No chain runs") === true);

// --- single running foreground ---
const one = formatFleet([mkEntry(1, "scout-twice", "running", 45000)]);
check("single: header count", one[0]?.includes("Chain runs (1)") === true);
check("single: glyph + id + name", one[1]?.includes("⟳ #1 scout-twice") === true);
check("single: elapsed seconds", one[1]?.includes("45s") === true);
check("single: step detail", one[1]?.includes("step 1/1: scout") === true);
check("single: model id (after /)", one[1]?.includes("glm-4.7") === true);
check("single: tool count", one[1]?.includes("3🛠") === true);
check("single: tokens", one[1]?.includes("4.2k tok") === true);

// --- [bg] marker ---
const bg = formatFleet([mkEntry(2, "build", "running", 5000, true)]);
check("bg: [bg] marker present", bg[1]?.includes("[bg]") === true);

// --- ordering: running-first, newest-first within group ---
const mixed = formatFleet([
  mkEntry(3, "old-done", "done", 30000),
  mkEntry(1, "oldest-running", "running", 10000),
  mkEntry(5, "newest-done", "done", 20000),
  mkEntry(4, "newest-running", "running", 8000),
]);
check("order: running before done", mixed.indexOf(mixed.find((l) => l.includes("oldest-running"))!) < mixed.indexOf(mixed.find((l) => l.includes("old-done"))!));
check("order: newest running first (4 before 1)", mixed.indexOf(mixed.find((l) => l.includes("#4"))!) < mixed.indexOf(mixed.find((l) => l.includes("#1"))!));

// --- cap: 12 entries → shows 10 + "+2 more" ---
const many = formatFleet(Array.from({ length: 12 }, (_, i) => mkEntry(i + 1, `chain-${i + 1}`, "running")));
check("cap: header notes 12 showing 10", many[0]?.includes("12") === true);
check("cap: +2 more suffix", many[many.length - 1]?.includes("+2 more") === true);
check("cap: 10 detail rows + header + more = 12 lines", many.length === 12);

// --- done chain: no step detail (just glyph + elapsed) ---
const done = formatFleet([mkEntry(7, "finished", "done", 12000)]);
check("done: ✓ glyph", done[1]?.includes("✓ #7 finished") === true);
check("done: no step detail", done[1]?.includes("step") === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
