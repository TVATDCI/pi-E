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

/**
 * Strip the VOLATILE, by-design-changing blocks before hashing, so drift fires only on real
 * system-prompt composition changes — not on memory growth or bridge re-exports. Volatile
 * blocks are XML-tagged by convention: <memory-context> (memory/formatter.ts) and
 * <bridge-context> (bd-bridge.ts). Absent tags ⇒ no-op (safe). Non-greedy + multiline.
 */
export function stableParts(prompt: string): string {
  return prompt
    .replace(/<memory-context>[\s\S]*?<\/memory-context>/g, "")
    .replace(/<bridge-context>[\s\S]*?<\/bridge-context>/g, "");
}

/** 16-hex sha256 of the STABLE parts of a prompt (volatile blocks stripped first). */
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(stableParts(prompt), "utf8").digest("hex").slice(0, 16);
}

/**
 * Known-good STABLE-parts hashes (curated). hashPrompt() strips the volatile blocks
 * (<memory-context>, <bridge-context>) first, so this set tracks the STABLE composition:
 * AGENTS.md base + <purpose> + the `## Cost Discipline` / `## Session notes` sections (those
 * are markdown headings, NOT XML blocks). A hash NOT in this set = drift — an unintended
 * composition change (investigate) or a legit one (add the hash here, reviewed).
 *
 * Seeded with the post-strip STABLE-parts hash (2026-07-30, captured live from the
 * prompt-composition warning after the volatile-block stripping landed). Re-seed only when the
 * STABLE composition legitimately changes (AGENTS.md edit, <purpose> change, a section added).
 */
export const KNOWN_GOOD_HASHES: Set<string> = new Set<string>([
  "c2bfe1b57f74616f", // stable-parts (post memory+bridge strip), pi 0.82.1, captured 2026-07-30
  "7f21df25f4181676", // stable-parts, pi 0.83.0 (base prompt changed in the update), captured 2026-07-30
]);

export function isKnownGood(hash: string): boolean {
  return KNOWN_GOOD_HASHES.has(hash);
}
