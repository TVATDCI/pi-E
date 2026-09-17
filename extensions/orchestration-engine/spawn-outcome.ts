// extensions/orchestration-engine/spawn-outcome.ts
// Edit 7 (PORT-PLAN-v0.40): pure spawn-outcome classification. Lives in its own ZERO-DEP module
// (not spawn.ts) so it can be unit-tested — spawn.ts has external @earendil-works deps and can't be
// imported by the test suite (see spawn-wiring.test.ts header). spawn.ts imports + re-exports this.
//
// Separation of concerns: spawnSub is MECHANISM (it owns the proc, reports whether its wall-clock
// timer fired via `timedOut`); classifySpawnOutcome is POLICY (which human-readable cause wins when
// Esc + timeout race). Kept pure so the precedence table is auditable in one read + fully testable.

/** Classified outcome of one dispatch/chain-step spawn. Surfaced on SpawnResult + the dispatch-log. */
export type SpawnOutcome = "done" | "error" | "timeout" | "aborted";

/**
 * PORT-PLAN-v0.40 ③ (live-error half, 2026-08-16): should the cross-provider fallback chain
 * walk after a spawn? TRUE when the spawn produced no usable output — SOFT failure (empty
 * output: Z-AI quota exhaustion has no balance fallback, exhaustion = empty) OR LOUD failure
 * (in-band agent error: e.g. opencode-go 429 GoUsageLimitError arrives as an error event and is
 * appended to output — non-empty, but a failure nonetheless). FALSE when timedOut (Edit 7:
 * retrying a hung model never helps — abort the chain instead) or on real output with no error.
 *
 * POLICY twin of spawnSub's mechanism, kept pure + zero-dep for the same reason as
 * classifySpawnOutcome: spawn.ts can't be imported by the test suite.
 */
export function spawnFailedForFallback(
  outputLength: number,
  inbandError: string | undefined,
  timedOut: boolean,
): boolean {
  return !timedOut && (outputLength === 0 || Boolean(inbandError));
}

/**
 * R2 (2026-09-17, design-v0.2 + sis-verdict-v0.1 C3): mini-dc refusal discrimination.
 *
 * The PRIMARY cure is structural (mini-dc headless denials settle in-band without ctx.abort(),
 * so output is non-empty and inbandError unset — the walk cannot fire on its own predicates).
 * This marker check is the SECONDARY defense, and its channel is model-echo text — untrusted
 * and probabilistic. Both failure directions are ACCEPTED and documented here:
 *   • FALSE NEGATIVE — refusal + empty/paraphrased output → marker absent → walk fires →
 *     downshift. Accepted: conservative bias is justified by the stale-tail poisoning cost
 *     (R5: 2 landings, $1.147; dispatch-log receipts 2026-09-17).
 *   • FALSE POSITIVE — marker echo + a genuine later in-band error (e.g. quota 429 after an
 *     earlier refusal) → walk suppressed → rescue lost. Also: a task that merely QUOTES
 *     "BLOCKED by mini-dc" (plans/reviews about mini-dc) can suppress walks. Accepted.
 * Follow-up (named, NOT this branch): a structured channel — spawnSub already parses the
 * child event stream; a deterministic tool-execution block event would discriminate by
 * construction instead of by echo.
 */
export const MINIDC_REFUSAL_RE = /BLOCKED by mini-dc/;

/** True when the spawn's output (or in-band error text) carries a mini-dc refusal marker. */
export function isMinidcRefusal(output: string, inbandError?: string): boolean {
  return MINIDC_REFUSAL_RE.test(output) || (inbandError !== undefined && MINIDC_REFUSAL_RE.test(inbandError));
}

/**
 * R2 walk gate: consult BEFORE spawnFailedForFallback at BOTH walk sites in spawn.ts.
 * A mini-dc refusal is a POLICY denial, not a model failure — downshifting the model cannot
 * cure it (the same denial recurs on every rung; the walk just burns quota and can land on
 * the stale global tail). Refusal → no walk; everything else → the original predicates.
 */
export function shouldWalkAfterFailure(
  outputLength: number,
  inbandError: string | undefined,
  timedOut: boolean,
  output: string,
): boolean {
  if (isMinidcRefusal(output, inbandError)) return false;
  return spawnFailedForFallback(outputLength, inbandError, timedOut);
}

/**
 * Classify a spawn's outcome from its kill causes + exit code.
 *
 * Precedence: **aborted > timeout > done/error**.
 *   - `aborted` wins the race window: an operator/caller abort (Esc / AbortSignal) is an intentional
 *     act, so "aborted" is the truthful label even if a generous timeout was about to fire. In the
 *     real race (Esc within the child's close latency), Esc is almost always the primary cause.
 *   - `timeout` beats `done`/`error`: a timed-out spawn that happens to exit 0 (graceful SIGTERM
 *     handler) is still a timeout, not a success — the wall-clock budget was breached.
 *   - Otherwise the exit code decides: 0 → done, non-zero → error.
 *
 * Moot for review-loop Mode A's hung-reviewer escape: that path runs with signal.aborted=false, so
 * `timeout` is the only flag and this precedence never has to choose (Edit 4a unblock).
 *
 * Exported for unit testing (extensions/tests/spawn-outcome.test.ts).
 */
export function classifySpawnOutcome(opts: { timedOut: boolean; aborted: boolean; code: number }): SpawnOutcome {
  if (opts.aborted) return "aborted";
  if (opts.timedOut) return "timeout";
  return opts.code === 0 ? "done" : "error";
}
