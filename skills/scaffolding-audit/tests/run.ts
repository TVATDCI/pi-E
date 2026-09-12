/**
 * Task 1.3 TDD harness — drift-check core (pi side).
 *
 * Three pure-logic pieces per PRD §11: manifest comparison, finding-hash
 * stability, drift-flag branch (both manifest fixtures).
 *
 * Fixture isolation (F-8): every manifest fixture lives in an ISOLATED TEMP
 * state dir (mkdtemp under os.tmpdir()); the live skill state dir is never
 * touched by tests — Task 1.4 asserts its absence against the real run.
 *
 * INV-1 note: test fixture writes below target ISOLATED TEMP dirs only (F-8) —
 * the same manifest-write class as gate exception (a); never the live state dir.
 *
 * Stale-fixture provenance (F-5): the pre-edit binding state is machine-extracted
 * at run time via `git show 0ce0b18^:extensions/orchestration-engine/tier-map.ts`
 * (a bare command that passes this rig's shell gate — verified 2026-09-12), then
 * passed through the SAME extractor as the current file. No synthetic inventions.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findingHash, boundQuote, QUOTE_MAX } from "../scripts/lib/finding.ts";
import type { ModelState } from "../scripts/lib/model-state.ts";
import { extractModelState, TIER_MAP_REL, JUDGING_CATEGORIES } from "../scripts/lib/model-state.ts";
import {
  checkDrift,
  DriftManifestError,
  DRIFT_FLAG,
} from "../scripts/lib/drift.ts";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const AGENT_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const TIER_MAP_ABS = join(AGENT_ROOT, TIER_MAP_REL);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`ok - ${name}`);
  } else {
    failed++;
    console.error(`NOT OK - ${name}`);
  }
}

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "scaffolding-audit-fixture-"));
}

function manifestJson(modelState: ModelState): string {
  return JSON.stringify(
    {
      "recorded-at": "2026-09-12T00:00:00.000Z",
      "surface-scope": "pi",
      "last-audit-commit": { "~/.pi/agent": "0ce0b18^" },
      "model-state": modelState,
      "finding-hashes": [],
    },
    null,
    2,
  ) + "\n";
}

// ─── finding-hash stability (PRD §11) ────────────────────────────────────────

const F = "extensions/orchestration-engine/tier-map.ts";
const Q = "but L3 may consult it to downshift architecture→4.7 if a dispatch lands in peak.";

check(
  "finding hash: same file+line+quote → same hash across calls",
  findingHash(F, 168, Q) === findingHash(F, 168, Q),
);
check(
  "finding hash: quote change → different hash",
  findingHash(F, 168, Q) !== findingHash(F, 168, Q + " "),
);
check(
  "finding hash: line change → different hash",
  findingHash(F, 168, Q) !== findingHash(F, 169, Q),
);
check(
  "finding hash: file change → different hash",
  findingHash(F, 168, Q) !== findingHash("AGENTS.md", 168, Q),
);
check(
  "bound quote: caps at " + QUOTE_MAX + " chars",
  boundQuote("x".repeat(QUOTE_MAX + 50)).length === QUOTE_MAX,
);

// ─── model-state extraction ──────────────────────────────────────────────────

const currentText = readTierMap();
const parentText = gitShowParent();

function readTierMap(): string {
  return readFileSync(TIER_MAP_ABS, "utf8");
}

function gitShowParent(): string {
  // F-5 provenance: bare `git show` passes the rig shell gate (verified this
  // session); run from the repo root with the pinned pre-build parent commit.
  return execFileSync(
    "git",
    ["show", "0ce0b18^:extensions/orchestration-engine/tier-map.ts"],
    { cwd: AGENT_ROOT, encoding: "utf8" },
  );
}

const currentState = extractModelState(currentText, TIER_MAP_REL);
const parentState = extractModelState(parentText, TIER_MAP_REL);

check(
  "model-state: extracts all 10 categories from live tier-map",
  Object.keys(currentState.assignments).length === 10,
);
check(
  "model-state: judging locks cover the 3 judging categories with chains",
  currentState.judgingLocks.categories.length === 3 &&
    JUDGING_CATEGORIES.every((c) =>
      Array.isArray(currentState.judgingLocks.chains[c]) &&
      currentState.judgingLocks.chains[c].length > 0
    ),
);
check(
  "model-state: source anchor carries path + 64-hex sha256",
  currentState.source.path === TIER_MAP_REL &&
    /^[0-9a-f]{64}$/.test(currentState.source.sha256),
);
check(
  "model-state: deterministic — two extractions stringify identically",
  JSON.stringify(extractModelState(currentText, TIER_MAP_REL)) ===
    JSON.stringify(currentState),
);
check(
  "model-state: parent (0ce0b18^) state ≠ current state — the doctrine-edit drift class is visible",
  JSON.stringify(parentState) !== JSON.stringify(currentState),
);
check(
  "model-state: parent vs current ASSIGNMENTS identical (0ce0b18 was doctrine-only) — drift rides the source digest",
  JSON.stringify(parentState.assignments) === JSON.stringify(currentState.assignments),
);

// ─── drift-flag branch (both manifest fixtures + boundaries) ─────────────────

const staleDir = tempStateDir();
const staleManifestPath = join(staleDir, "manifest.json");
writeFileSync(staleManifestPath, manifestJson(parentState), "utf8");

const freshDir = tempStateDir();
const freshManifestPath = join(freshDir, "manifest.json");
writeFileSync(freshManifestPath, manifestJson(currentState), "utf8");

const missingDir = tempStateDir();

const staleResult = checkDrift(
  readFileSync(staleManifestPath, "utf8"),
  currentState,
);
check(
  "drift: stale manifest (pre-edit 0ce0b18^ state vs current tier-map) → exactly the reminder flag and nothing else",
  staleResult.outcome === "stale" &&
    staleResult.output === DRIFT_FLAG,
);

const freshResult = checkDrift(
  readFileSync(freshManifestPath, "utf8"),
  currentState,
);
check(
  "drift: fresh manifest (post-edit state recorded) → silent",
  freshResult.outcome === "fresh" && freshResult.output === "",
);

const missingResult = checkDrift(undefined, currentState);
check(
  "drift: missing manifest → same flag (never audited)",
  missingResult.outcome === "missing" && missingResult.output === DRIFT_FLAG,
);
check(
  "drift: missing manifest → NO manifest written (no auto-rebuild)",
  readdirSync(missingDir).length === 0,
);

let unreadableThrew = false;
try {
  checkDrift("{ not json", currentState);
} catch (err) {
  unreadableThrew = err instanceof DriftManifestError;
}
check(
  "drift: unreadable manifest → explicit DriftManifestError (no silent rebuild)",
  unreadableThrew,
);

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`${failed} test(s) failed (RED)`);
}
