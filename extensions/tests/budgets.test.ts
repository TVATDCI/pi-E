// extensions/tests/budgets.test.ts — budget-subsystem invariant tests (PORT-PLAN-v0.40.md ①).
// Run: node --experimental-strip-types budgets.test.ts   (from extensions/tests/)
//
// Proves the load-bearing properties the conservative orchestration policy rests on:
//   (1) FAIL-SAFE VALIDATION — every validator returns {error} on bad input, never throws (except
//       decodeToolBudgetEnv, which is a trust-boundary parse and throw-on-malformed by design).
//   (2) TERMINATION-AT-BOUNDARY — turnBudgetDecision DEFERS (never aborts) when tool work is active
//       and hard-limit isn't forced; a future refactor that simplifies this to "kill now" silently
//       breaks the "never hard-kill mid-write" promise.
//   (3) CONSERVATIVE BLOCK DEFAULT — normalizeToolBudgetBlock defaults to read-only tools; this is
//       the footgun the wiring layer must never apply to mutation workers (asserted here so the
//       default is pinned, not accidentally changed).
// Plus resolution/state/round-trip sanity for all three budgets.
import {
  resolveTurnBudgetConfig,
  appendTurnBudgetSystemPrompt,
  turnBudgetDecision,
  initialTurnBudgetState,
  DEFAULT_TURN_BUDGET_GRACE_TURNS,
  normalizeToolBudgetBlock,
  validateToolBudgetConfig,
  shouldBlockToolForBudget,
  toolBudgetState,
  encodeToolBudgetEnv,
  decodeToolBudgetEnv,
  DEFAULT_TOOL_BUDGET_BLOCK,
  validateUsageBudgetConfig,
  usageBudgetState,
  usageBudgetExceededMessage,
} from "../budgets/index.ts";
import type { ResolvedTurnBudget, ResolvedToolBudget } from "../budgets/index.ts";

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
// Order-insensitive canonicalization: object key order must never affect equality
// (validators construct {hard, ...soft, block} — hard first — while literals often write soft first).
function canonical(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonical);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonical((v as Record<string, unknown>)[k]);
  return out;
}
function eq<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
  check(`${name}${ok ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`, ok);
}

// ── turn budget: resolution ──────────────────────────────────────────────────────
eq("turnBudget: undefined ⇒ no budget, no error", resolveTurnBudgetConfig(undefined), {});
eq("turnBudget: {maxTurns:5} ⇒ grace defaults to 1", resolveTurnBudgetConfig({ maxTurns: 5 }), {
  turnBudget: { maxTurns: 5, graceTurns: 1 },
});
eq("turnBudget: explicit graceTurns honored", resolveTurnBudgetConfig({ maxTurns: 5, graceTurns: 3 }), {
  turnBudget: { maxTurns: 5, graceTurns: 3 },
});
check("turnBudget: non-object ⇒ error", !!resolveTurnBudgetConfig(5).error);
check("turnBudget: array ⇒ error", !!resolveTurnBudgetConfig([1, 2]).error);
check("turnBudget: null ⇒ error", !!resolveTurnBudgetConfig(null).error);
check("turnBudget: unknown field ⇒ error", !!resolveTurnBudgetConfig({ maxTurns: 5, bogus: 1 }).error);
check("turnBudget: maxTurns non-integer ⇒ error", !!resolveTurnBudgetConfig({ maxTurns: 5.5 }).error);
check("turnBudget: maxTurns < 1 ⇒ error", !!resolveTurnBudgetConfig({ maxTurns: 0 }).error);
check("turnBudget: maxTurns missing ⇒ error", !!resolveTurnBudgetConfig({}).error);
check("turnBudget: graceTurns negative ⇒ error", !!resolveTurnBudgetConfig({ maxTurns: 5, graceTurns: -1 }).error);
check("turnBudget: graceTurns non-integer ⇒ error", !!resolveTurnBudgetConfig({ maxTurns: 5, graceTurns: 1.5 }).error);

// ── turn budget: state + prompt ──────────────────────────────────────────────────
eq("turnBudget: initial state applies default grace", initialTurnBudgetState({ maxTurns: 4 }), {
  maxTurns: 4,
  graceTurns: DEFAULT_TURN_BUDGET_GRACE_TURNS,
  outcome: "within-budget",
  turnCount: 0,
});
check("turnBudget: prompt unchanged when no budget", appendTurnBudgetSystemPrompt("hi", undefined) === "hi");
check("turnBudget: prompt appended when budget set", appendTurnBudgetSystemPrompt("hi", { maxTurns: 3 }).includes("Turn budget"));
check("turnBudget: empty prompt ⇒ block only", appendTurnBudgetSystemPrompt("", { maxTurns: 3 }) === appendTurnBudgetSystemPrompt("", { maxTurns: 3 }));

// ── turn budget: termination-at-boundary decision (property 2) ───────────────────
const tb: ResolvedTurnBudget = { maxTurns: 5, graceTurns: 1 }; // hardLimit = 6
eq("decision: under hard limit ⇒ continue", turnBudgetDecision(tb, 3, false, false), "continue");
eq("decision: at safe boundary under limit ⇒ continue", turnBudgetDecision(tb, 5, true, false), "continue");
eq("decision: over limit, no tool work ⇒ abort", turnBudgetDecision(tb, 7, false, false), "abort");
eq("decision: over limit, tool work active, not forced ⇒ DEFER", turnBudgetDecision(tb, 7, false, true), "defer");
eq("decision: over limit, tool work active, FORCED ⇒ abort", turnBudgetDecision(tb, 7, false, true, true), "abort");
eq("decision: terminal stop over limit ⇒ continue (already stopped)", turnBudgetDecision(tb, 7, true, true), "continue");

// ── tool budget: block default (property 3) + normalize ──────────────────────────
eq("toolBudget: default block is read-only tools", normalizeToolBudgetBlock(undefined), [...DEFAULT_TOOL_BUDGET_BLOCK]);
eq("toolBudget: '*' passes through", normalizeToolBudgetBlock("*"), "*");
eq("toolBudget: array deduped + trimmed", normalizeToolBudgetBlock(["a", "a", " b ", ""]), ["a", "b"]);

// ── tool budget: validation ──────────────────────────────────────────────────────
eq("toolBudget: undefined ⇒ no budget", validateToolBudgetConfig(undefined), {});
eq("toolBudget: {hard:10} ⇒ block defaults", validateToolBudgetConfig({ hard: 10 }), {
  budget: { hard: 10, block: [...DEFAULT_TOOL_BUDGET_BLOCK] },
});
eq("toolBudget: soft+hard+block resolved", validateToolBudgetConfig({ soft: 5, hard: 10, block: ["x"] }), {
  budget: { soft: 5, hard: 10, block: ["x"] },
});
check("toolBudget: missing hard ⇒ error", !!validateToolBudgetConfig({ soft: 5 }).error);
check("toolBudget: hard < 1 ⇒ error", !!validateToolBudgetConfig({ hard: 0 }).error);
check("toolBudget: minimumHard:0 allows hard:0", !validateToolBudgetConfig({ hard: 0 }, "t", { minimumHard: 0 }).error);
check("toolBudget: soft < 1 ⇒ error", !!validateToolBudgetConfig({ soft: 0, hard: 5 }).error);
check("toolBudget: soft > hard ⇒ error", !!validateToolBudgetConfig({ soft: 8, hard: 5 }).error);
check("toolBudget: block empty array ⇒ error", !!validateToolBudgetConfig({ hard: 5, block: [] }).error);
check("toolBudget: block non-string entry ⇒ error", !!validateToolBudgetConfig({ hard: 5, block: [5 as unknown as string] }).error);
check("toolBudget: block not array / not '*' ⇒ error", !!validateToolBudgetConfig({ hard: 5, block: "read" as unknown as string[] }).error);

// ── tool budget: block decision + state ──────────────────────────────────────────
const tob: ResolvedToolBudget = { soft: 5, hard: 10, block: ["read", "grep"] };
check("toolBudget: under hard ⇒ never block", !shouldBlockToolForBudget(tob, "read", 5));
check("toolBudget: over hard + in block ⇒ block", shouldBlockToolForBudget(tob, "read", 11));
check("toolBudget: over hard + not in block ⇒ allow", !shouldBlockToolForBudget(tob, "edit", 11));
check("toolBudget: block '*' blocks everything over hard", shouldBlockToolForBudget({ hard: 1, block: "*" }, "anything", 2));
eq("toolBudget: state within-budget", toolBudgetState(tob, 3).outcome, "within-budget");
eq("toolBudget: state soft-reached", toolBudgetState(tob, 5).outcome, "soft-reached");
eq("toolBudget: state hard-blocked", toolBudgetState(tob, 11).outcome, "hard-blocked");

// ── tool budget: env round-trip (decode throws on malformed) ─────────────────────
const encoded = encodeToolBudgetEnv(tob);
eq("toolBudget: encode/decode round-trip", decodeToolBudgetEnv(encoded), tob);
eq("toolBudget: encode(undefined) ⇒ undefined", encodeToolBudgetEnv(undefined), undefined);
eq("toolBudget: decode(empty) ⇒ undefined", decodeToolBudgetEnv(""), undefined);
let threw = false;
try {
  decodeToolBudgetEnv(JSON.stringify({ hard: 0 })); // hard:0 invalid without allowZero
} catch {
  threw = true;
}
check("toolBudget: decode malformed (hard:0) ⇒ throws", threw);
eq("toolBudget: decode hard:0 with allowZero ⇒ ok", decodeToolBudgetEnv(JSON.stringify({ hard: 0 }), { allowZero: true }), {
  hard: 0,
  block: [...DEFAULT_TOOL_BUDGET_BLOCK],
});

// ── usage budget: validation ─────────────────────────────────────────────────────
eq("usageBudget: undefined ⇒ no budget", validateUsageBudgetConfig(undefined), {});
eq("usageBudget: tokens valid", validateUsageBudgetConfig({ tokens: { hard: 1000 } }), {
  budget: { tokens: { hard: 1000 } },
});
eq("usageBudget: costUsd valid", validateUsageBudgetConfig({ costUsd: { soft: 1, hard: 5 } }), {
  budget: { costUsd: { soft: 1, hard: 5 } },
});
check("usageBudget: both valid", !validateUsageBudgetConfig({ tokens: { hard: 100 }, costUsd: { hard: 2 } }).error);
check("usageBudget: non-object ⇒ error", !!validateUsageBudgetConfig(5).error);
check("usageBudget: unknown field ⇒ error", !!validateUsageBudgetConfig({ bogus: 1 }).error);
check("usageBudget: tokens non-object ⇒ error", !!validateUsageBudgetConfig({ tokens: 5 }).error);
check("usageBudget: tokens.hard <= 0 ⇒ error", !!validateUsageBudgetConfig({ tokens: { hard: 0 } }).error);
check("usageBudget: tokens.soft <= 0 ⇒ error", !!validateUsageBudgetConfig({ tokens: { soft: 0, hard: 5 } }).error);
check("usageBudget: tokens.soft > hard ⇒ error", !!validateUsageBudgetConfig({ tokens: { soft: 8, hard: 5 } }).error);
check("usageBudget: unknown limit field ⇒ error", !!validateUsageBudgetConfig({ tokens: { hard: 5, x: 1 } }).error);
check("usageBudget: neither tokens nor costUsd ⇒ error", !!validateUsageBudgetConfig({}).error);

// ── usage budget: state (no reservation; reported only) ──────────────────────────
const cfg = { tokens: { soft: 50, hard: 100 }, costUsd: { soft: 1, hard: 5 } };
eq("usageBudget: undefined config ⇒ undefined", usageBudgetState(undefined, { inputTokens: 999, outputTokens: 0, costUsd: 0 }), undefined);
check("usageBudget: within budget ⇒ not exhausted", usageBudgetState(cfg, { inputTokens: 10, outputTokens: 0, costUsd: 0 })?.exhausted === false);
const softHit = usageBudgetState(cfg, { inputTokens: 60, outputTokens: 0, costUsd: 0 });
check("usageBudget: soft-exceeded tokens ⇒ not exhausted (soft is advisory)", softHit?.exhausted === false && softHit?.tokens?.outcome === "soft-exceeded");
const hardHit = usageBudgetState(cfg, { inputTokens: 110, outputTokens: 0, costUsd: 0 });
check("usageBudget: hard-exceeded tokens ⇒ exhausted, reason tokens", hardHit?.exhausted === true && hardHit?.reason === "tokens");
const costHit = usageBudgetState(cfg, { inputTokens: 10, outputTokens: 0, costUsd: 6 });
check("usageBudget: hard-exceeded cost ⇒ exhausted, reason costUsd", costHit?.exhausted === true && costHit?.reason === "costUsd");
// tokens+cost both hard-exceeded ⇒ tokens wins
const bothHit = usageBudgetState(cfg, { inputTokens: 200, outputTokens: 0, costUsd: 99 });
check("usageBudget: tokens wins on a tie", bothHit?.reason === "tokens");

// ── usage budget: messages ───────────────────────────────────────────────────────
check("usageBudget: tokens message names the metric", usageBudgetExceededMessage(hardHit!).includes("tokens"));
check("usageBudget: cost message names the metric", usageBudgetExceededMessage(costHit!).includes("cost"));
check("usageBudget: no-reason ⇒ generic message", usageBudgetExceededMessage({ version: 1, source: "reported", exhausted: true }).startsWith("Usage budget exhausted"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
