// extensions/tests/transcript-tail.test.ts — formatTranscript snapshot + edge tests.
// Run: node --experimental-strip-types transcript-tail.test.ts (from extensions/tests/)
import { formatTranscript, type TranscriptEntry } from "../background-helpers.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

const mkStep = (name: string, status: string, extra: Partial<{ modelFlag: string; toolCount: number; output: string; accumulatedText: string }> = {}) => ({
  name, status, ...extra,
});

const mkEntry = (id: number, chainName: string, status: string, steps: ReturnType<typeof mkStep>[], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  id, chainName, status, elapsed: 30000, steps, ...extra,
});

// --- running step with accumulated text → shows tail ---
const running = formatTranscript(mkEntry(1, "scout-twice", "running", [
  mkStep("scout", "done", { output: "Found 107 .ts files.", modelFlag: "zai/glm-4.7" }),
  mkStep("verify", "running", { accumulatedText: "Cross-checking... Entry point is auth.ts:42. The token validation happens after decode which is wrong. Need to move it before.", modelFlag: "zai/glm-4.7", toolCount: 3 }),
], { background: true }));

check("running: header with id + name + [bg]", running[0]?.includes("Transcript #1 scout-twice [bg]") === true);
check("running: header has elapsed", running[0]?.includes("30s") === true);
check("running: step 1 done with output", running.some((l) => l.includes("✓ step 1/2: scout") && l.includes("(done)")) === true);
check("running: step 1 output shown", running.some((l) => l.includes("Found 107 .ts files")) === true);
check("running: step 2 running with details", running.some((l) => l.includes("⟳ step 2/2: verify") && l.includes("(running)")) === true);
check("running: step 2 accumulated text shown (⎿)", running.some((l) => l.includes("⎿") && l.includes("token validation")) === true);

// --- done step shows output (not accumulatedText) ---
const done = formatTranscript(mkEntry(2, "commit-message", "done", [
  mkStep("draft", "done", { output: "feat: add handoff context param" }),
  mkStep("review", "done", { output: "PASS" }),
]));
check("done: ✓ glyph + step details", done.some((l) => l.includes("✓ step 1/2: draft") && l.includes("(done)")) === true);
check("done: draft output shown", done.some((l) => l.includes("feat: add handoff")) === true);
check("done: review output (PASS)", done.some((l) => l.includes("PASS")) === true);

// --- pending step shows nothing (no output/text) ---
const pending = formatTranscript(mkEntry(3, "plan-build", "running", [
  mkStep("explore", "running", { accumulatedText: "Looking at src/", toolCount: 1 }),
  mkStep("plan", "pending"),
  mkStep("build", "pending"),
]));
check("pending: ○ glyph for pending step", pending.some((l) => l.includes("○ step 2/3: plan") && l.includes("(pending)")) === true);
check("pending: no ⎿ for pending step (no text)", pending.some((l) => l.includes("⎿") && l.includes("plan")) === false);

// --- truncation: text > 600 chars → tail with … prefix ---
const longText = "A".repeat(800);
const truncated = formatTranscript(mkEntry(4, "test", "running", [
  mkStep("step", "running", { accumulatedText: longText }),
]));
const transcriptLine = truncated.find((l) => l.includes("⎿"));
check("truncation: starts with … prefix", transcriptLine?.startsWith("    ⎿ …") === true);
check("truncation: shows last 600 chars not full 800", (transcriptLine?.length ?? 0) < 700);

// --- foreground (not bg) ---
const fg = formatTranscript(mkEntry(5, "test", "running", [
  mkStep("step", "running", { accumulatedText: "working" }),
]));
check("foreground: no [bg] marker", fg[0]?.includes("[bg]") === false);

// --- empty accumulated text → no ⎿ line ---
const emptyText = formatTranscript(mkEntry(6, "test", "running", [
  mkStep("step", "running", { accumulatedText: "" }),
]));
check("empty text: no ⎿ line", emptyText.some((l) => l.includes("⎿")) === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);