// Injection ranker (Fork B). Deterministic sort for the memory-context block.
// Order is load-bearing:
//   1. Category priority: constraint > decision > convention > preference > fact
//   2. Within category: operator-provenance first, inferred last
//   3. Within provenance: recency by recordedAt, NEWEST first
//      (Momus m2: recordedAt, NOT session-local `turn` which resets each session)
//
// Pure: returns a NEW array; does not mutate input. Stable (Array.prototype.sort
// is stable in modern V8), so equal-key records keep insertion order.

import type { Category, MemoryRecord, Provenance } from "./schema.ts";

const CATEGORY_RANK: Record<Category, number> = {
  constraint: 0,
  decision: 1,
  convention: 2,
  preference: 3,
  fact: 4,
};

const PROVENANCE_RANK: Record<Provenance, number> = {
  operator: 0,
  inferred: 1,
};

/**
 * Rank records for injection. Returns a new sorted array; input is untouched.
 */
export function rankForInjection(records: readonly MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => {
    if (a.category !== b.category) return CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category];
    if (a.provenance !== b.provenance) return PROVENANCE_RANK[a.provenance] - PROVENANCE_RANK[b.provenance];
    // Same category + provenance: newest recordedAt first.
    return b.recordedAt - a.recordedAt;
  });
}
