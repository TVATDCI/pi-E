// yaml-merge.ts — D5: deny/allow YAML layer-merge as a VERSIONED SECURITY BOUNDARY.
// Not a refactor: for teams/chains the merged result decides which agent files get
// SPAWNED (which code runs); for mini-dc rules it decides which bash is ALLOWED. The
// invariant — project can ADD, never REMOVE a global deny — is the containment contract.
//
// This primitive centralizes the security-critical parts (fail-closed load, schema
// version, source labeling) and delegates the per-schema append logic to the caller via
// addInto(). planning/improvement-plan-v1.md §D5.
//
// ADOPTION STATUS (2026-07-29): primitive shipped + verified (12/12 invariant tests) but
// NOT adopted at any call site. The 3 existing sites (mini-damage-control rules,
// orchestration teams, chain-runner chains) already implement the security property
// (fail-closed + deny-additive) locally; adopting there is marginal-value (versioning +
// centralization, not security) and friction: rules is the SAFETY GATE (don't touch
// unverified-boot); chains/teams have last-wins scalars (version, default_team) this
// primitive's addInto doesn't express. ADOPTION TRIGGER: a 4th merge site appears →
// adopt the primitive at the new site (mandatory) + backfill rules as the clean-fit
// demonstration (lowest friction, highest reference value). Until then, primitive-only.
//
// Why addInto and not a generic concat: the 3 schemas differ — rules concat arrays,
// teams merge keyed members (+ override scalar fields), chains add-new-keys-only. The
// shared security property is "append-only into acc"; each schema supplies its own
// addInto. The primitive GUARANTEES: missing/parse-error ⇒ null layer (fail-closed for
// that layer); both-present ⇒ global folded FIRST, then project — so a project layer can
// never cause a global entry to be absent from the result at the primitive level.
//
// Pure logic + node:fs only → unit-testable in isolation (temp-file fixtures).

import { readFileSync, existsSync } from "node:fs";
import { parse as yamlParse } from "yaml";

export const MERGE_SCHEMA_VERSION = 1;
export type MergeSource = "none" | "global" | "project" | "merged";

export interface MergeResult<T> {
  /** null ONLY when both layers are absent/failed (fully fail-closed). */
  data: T | null;
  source: MergeSource;
  schemaVersion: number;
}

export interface DenyAdditiveOptions<T> {
  globalPath: string;
  projectPath: string;
  /** Parse raw YAML → typed layer, or null on parse-error / wrong shape (fail-closed). */
  parse: (raw: unknown) => T | null;
  /** Identity element for an empty layer (used as the accumulator when both present). */
  empty: T;
  /**
   * Fold `layer` INTO `acc` — APPEND-ONLY. Must never remove from acc. This is the
   * security invariant. Called with global first, then project.
   */
  addInto: (acc: T, layer: T) => void;
}

/** Load + parse one layer. Missing file or parse error ⇒ null (fail-closed for this layer). */
function loadLayer<T>(path: string, parse: (raw: unknown) => T | null): T | null {
  if (!existsSync(path)) return null;
  try {
    return parse(yamlParse(readFileSync(path, "utf-8")));
  } catch {
    return null; // parse error → treat as absent (fail-closed for this layer)
  }
}

export function denyAdditiveMerge<T>(opts: DenyAdditiveOptions<T>): MergeResult<T> {
  const global = loadLayer(opts.globalPath, opts.parse);
  const project = loadLayer(opts.projectPath, opts.parse);

  if (!global && !project) {
    return { data: null, source: "none", schemaVersion: MERGE_SCHEMA_VERSION };
  }
  if (global && !project) {
    return { data: global, source: "global", schemaVersion: MERGE_SCHEMA_VERSION };
  }
  if (!global && project) {
    return { data: project, source: "project", schemaVersion: MERGE_SCHEMA_VERSION };
  }
  // both present → fold global first, then project. addInto is append-only (caller contract).
  const acc = opts.empty;
  opts.addInto(acc, global as T);
  opts.addInto(acc, project as T);
  return { data: acc, source: "merged", schemaVersion: MERGE_SCHEMA_VERSION };
}
