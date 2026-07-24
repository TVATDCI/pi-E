// Memory schema types for the memory extension (v1).
// Fork C: 5 categories, scope=global, provenance field, schemaVersion stamp.
// Compatible with node --experimental-strip-types (no enums, no parameter properties).

export type Scope = "global";

// Category ranking order (Fork B ranker depends on this order):
// constraint > decision > convention > preference > fact
export type Category = "constraint" | "decision" | "convention" | "preference" | "fact";

export type Provenance = "operator" | "inferred";

export interface MemoryRecord {
  schemaVersion: 1; // Momus M4: version stamp for forward-compat (v1.1 SQLite migration)
  scope: Scope;
  category: Category;
  key: string; // topic-based, normalized lowercase_underscore
  value: string;
  provenance: Provenance;
  turn: number;
  recordedAt: number; // epoch ms — cross-session recency (Momus m2: NOT session-local turn)
}
