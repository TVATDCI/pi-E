// extensions/tests/review-orchestration.test.ts — ②b reviewer-orchestration pure-helper tests.
// Run: node --experimental-strip-types review-orchestration.test.ts   (from extensions/tests/)
//
// Covers the pure, spawn-free parts of ②b: buildReviewTask (focus + truncation + the required
// review-result block instruction) and parseReviewerResult (block parsed / empty blockers / absent ⇒
// undefined / malformed ⇒ undefined / non-string filtering / first-block-wins). The live resolveAndSpawn
// path is a smoke test, not unit-tested here.
import { buildReviewTask, parseReviewerResult } from "../orchestration-engine/review-helpers.ts";

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

// ── buildReviewTask ─────────────────────────────────────────────────────────────
const defaultTask = buildReviewTask("did the thing", undefined);
check("buildReviewTask: default focus present", defaultTask.includes("Focus: correctness, security, regressions, scope-widening, missing tests"));
check("buildReviewTask: requires the review-result block", defaultTask.includes("```review-result") && defaultTask.includes("empty blockers = approved"));
check("buildReviewTask: work output included", defaultTask.includes("did the thing"));
check("buildReviewTask: independent-reviewer framing", defaultTask.includes("Independent acceptance review REQUIRED"));

const focusedTask = buildReviewTask("work", { focus: "diff safety only" });
check("buildReviewTask: custom focus honored", focusedTask.includes("Focus: diff safety only") && !focusedTask.includes("Focus: correctness, security, regressions"));

const big = "x".repeat(25000);
const truncatedTask = buildReviewTask(big, undefined);
check("buildReviewTask: work truncated past cap (marker present)", truncatedTask.includes("work truncated at 20000 chars"));
check("buildReviewTask: truncated task smaller than raw work", truncatedTask.length < big.length + 1000);
const smallTask = buildReviewTask("tiny", undefined);
check("buildReviewTask: work under cap not truncated", !smallTask.includes("work truncated"));

// ── parseReviewerResult ─────────────────────────────────────────────────────────
const withBlockers = "prose\n```review-result\n" + JSON.stringify({ blockers: ["file.ts:12 bug", "missing test"], summary: "two blockers" }) + "\n```";
const pr1 = parseReviewerResult(withBlockers);
check("parse: blockers extracted", pr1?.blockers?.length === 2 && pr1?.blockers?.[0] === "file.ts:12 bug");
check("parse: summary extracted", pr1?.summary === "two blockers");

const approved = "```review-result\n" + JSON.stringify({ blockers: [], summary: "approved" }) + "\n```";
const pr2 = parseReviewerResult(approved);
check("parse: empty blockers ⇒ approved shape", pr2?.blockers?.length === 0 && pr2?.summary === "approved");

check("parse: no block ⇒ undefined (not auto-approve)", parseReviewerResult("just prose, no block") === undefined);
check("parse: malformed JSON block ⇒ undefined", parseReviewerResult("```review-result\n{not json}\n```") === undefined);
check("parse: block without blockers array ⇒ undefined", parseReviewerResult("```review-result\n" + JSON.stringify({ summary: "no blockers key" }) + "\n```") === undefined);

const mixed = "```review-result\n" + JSON.stringify({ blockers: [1, "real blocker", true, "x"] }) + "\n```";
const pr3 = parseReviewerResult(mixed);
check("parse: non-string blockers filtered out", pr3?.blockers?.length === 2 && pr3?.blockers?.[0] === "real blocker");

const twoBlocks = "```review-result\n{not json}\n```\n```review-result\n" + JSON.stringify({ blockers: ["second wins"] }) + "\n```";
check("parse: first PARSEABLE block wins (skips malformed)", parseReviewerResult(twoBlocks)?.blockers?.[0] === "second wins");

const surrounded = "lead prose\n```review-result\n" + JSON.stringify({ blockers: ["b"] }) + "\n```\ntrailing prose";
check("parse: block amid surrounding prose parsed", parseReviewerResult(surrounded)?.blockers?.[0] === "b");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
