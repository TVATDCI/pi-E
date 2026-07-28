// prompt-hash.ts — D1 OBSERVER util (partial-revert v1.3).
// The registry/flusher mechanism was DROPPED (pi's per-extension module isolation made a
// shared registry impossible — verified live 2026-07-29; see fact
// `pi_extension_module_isolation`). What survives is the HIGH-VALUE half of D1: a content
// hash of the COMPOSED prompt for drift detection. The observer (prompt-observer.ts) hooks
// `agent_start` — AFTER before_agent_start composes the prompt — and hashes
// ctx.getSystemPrompt(), i.e. the event chain's OUTPUT, regardless of how it was assembled
// or in what order. This sidesteps module isolation entirely.
//
// Residual: HASH-level drift (the composed prompt changed) ships now. ORDER-level drift
// (which extension moved) needs upstream event-chain instrumentation → deferred.
//
// Pure (node:crypto only) → unit-testable in isolation.

import { createHash } from "node:crypto";

/** 16-hex sha256 of a prompt string. Content-addressed; assembly-order-independent. */
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 16);
}

/**
 * Known-good composed-prompt hashes (curated). A hash NOT in this set = drift — either an
 * intended composition change (add the hash here, reviewed) or an unintended one
 * (investigate). Seeded EMPTY: after the first post-revert boot, copy the live-verified
 * hash from the session's `prompt-composition` log entry into this set. (See
 * prompt-hash.test.ts for the canonical-prompt golden.)
 */
export const KNOWN_GOOD_HASHES: Set<string> = new Set<string>([
  // Live-verified composed-prompt hash (2026-07-29, post partial-revert + observer boot).
  // Confirmed via the session's prompt-composition log entry. Drift fires only when the
  // composed prompt (AGENTS.md base + purpose + bridge + memory-context + cost + notes)
  // actually changes — re-seed legitimate changes here after review.
  "fd6891a5f489e8a4",
]);

export function isKnownGood(hash: string): boolean {
  return KNOWN_GOOD_HASHES.has(hash);
}
