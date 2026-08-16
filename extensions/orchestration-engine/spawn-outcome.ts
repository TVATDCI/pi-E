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
