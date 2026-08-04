// extensions/orchestration-engine/review-helpers.ts — pure helpers for ②b reviewer orchestration.
// buildReviewTask + parseReviewerResult (+ a local balanced-JSON extractor). No external/value deps
// (the `import type` from acceptance.ts is erased at runtime) ⇒ unit-testable in isolation.
// Imported by chain-runner.ts; the live spawn (resolveAndSpawn) lives there, not here.
//
// DESIGN (PORT-PLAN-v0.40.md ②b; see memory acceptance_review_gate_2b_decisions):
//  - buildReviewTask: focus + the step's work (truncated) + a REQUIRED fenced `review-result` block.
//  - parseReviewerResult: REQUIRES that block with a `blockers` array; absent/malformed ⇒ undefined
//    (the caller leaves a review-required badge + warns — NOT auto-approve, Q-2b-2/Q-2b-3).
import type { AcceptanceReview, ReviewerResult } from "../acceptance.ts";

const REVIEW_WORK_CAP = 20000;

/**
 * Build the independent-reviewer task string. Pure. Includes the focus, the step's work output
 * (truncated at REVIEW_WORK_CAP — the reviewer can read the actual changed files anyway), and a
 * REQUIRED fenced `review-result` JSON block instruction (empty blockers = approved). */
export function buildReviewTask(workOutput: string, review: AcceptanceReview | undefined): string {
  const focus = review?.focus ?? "correctness, security, regressions, scope-widening, missing tests";
  const work =
    workOutput.length > REVIEW_WORK_CAP
      ? workOutput.slice(0, REVIEW_WORK_CAP) + `\n…[work truncated at ${REVIEW_WORK_CAP} chars]`
      : workOutput;
  return [
    "Independent acceptance review REQUIRED. You are the independent reviewer for a completed step.",
    `Focus: ${focus}.`,
    "Inspect the work below — and the actual changed files in the repo, which you may read — for BLOCKERS: correctness bugs, security issues, regressions, missing tests, scope-widening, or anything that should block acceptance.",
    "If there are NO blockers, approve. Otherwise list each blocker concretely (file:line where possible).",
    "",
    "End with a fenced JSON block tagged `review-result` in EXACTLY this shape (empty blockers = approved):",
    "```review-result",
    JSON.stringify({ blockers: ["blocker 1", "blocker 2"], summary: "approved, or what you found" }),
    "```",
    "",
    "## Work to review",
    work,
  ].join("\n");
}

/** Balanced-brace JSON object extractor (mirrors acceptance.ts's extractBalancedJson; local to keep
 *  this module dep-free). Returns the substring from `start` to the matching close brace, or undefined. */
function extractBalancedJson(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function parseReviewBody(body: string): ReviewerResult | undefined {
  const extract = (s: string): ReviewerResult | undefined => {
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return undefined;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
    const o = obj as Record<string, unknown>;
    if (!Array.isArray(o.blockers)) return undefined; // blockers array is REQUIRED
    const blockers = o.blockers.filter((b): b is string => typeof b === "string");
    const summary = typeof o.summary === "string" ? o.summary : undefined;
    return { blockers, ...(summary ? { summary } : {}) };
  };
  const trimmed = body.trim();
  const direct = extract(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;
  const json = extractBalancedJson(trimmed, start);
  return json ? extract(json) : undefined;
}

/**
 * Parse the reviewer's output into a ReviewerResult. Requires a fenced ```review-result JSON block
 * with a `blockers` array (the first parseable block wins). Absent or malformed ⇒ `undefined` — the
 * caller then leaves the step at a non-terminal `review-required` badge + emits a dispatch-log
 * warning (Q-2b-2/Q-2b-3): never auto-approve, never hard-fail on a formatting miss. */
export function parseReviewerResult(output: string): ReviewerResult | undefined {
  const blocks = [...output.matchAll(/```review-result\s*\n([\s\S]*?)```/gi)]
    .map((m) => m[1]?.trim())
    .filter((v): v is string => Boolean(v));
  for (const body of blocks) {
    const parsed = parseReviewBody(body);
    if (parsed) return parsed;
  }
  return undefined;
}
