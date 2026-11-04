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
import { extractModelState, TIER_MAP_REL, JUDGING_CATEGORIES, resolveDeskHostname } from "../scripts/lib/model-state.ts";
import {
  LEGACY_MANIFEST_NAME,
  manifestFilenameForHost,
  readManifestText,
  resolveManifestPaths,
  seedSuffixedFromLegacy,
} from "../scripts/lib/manifest-path.ts";
import process from "node:process";
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
  "model-state: extracts all 12 categories from live tier-map (re-pinned 2026-09-29: security-review + local-research joined after authoring)",
  Object.keys(currentState.assignments).length === 12,
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
  "model-state: parent vs current assignments DIVERGED legitimately (ultrabrain primary re-pinned since the parent era) — both digest and assignments carry drift now",
  JSON.stringify(parentState.assignments) !== JSON.stringify(currentState.assignments) &&
    currentState.assignments.ultrabrain?.primary !== parentState.assignments.ultrabrain?.primary,
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

// ─── desk-suffixed manifests (mirrors the oc-sisyphus twin landing) ─────────

// Set SCAFFOLD_DESK_HOST for a deterministic desk inside a scope; restore the
// prior value (or absence) afterwards. The env knob is the SAME one
// resolveDeskHostname() reads — the single hostname mechanism behind the
// manifest-suffix table.
function withDeskHost<T>(host: string | undefined, fn: () => T): T {
  const prior = process.env.SCAFFOLD_DESK_HOST;
  if (host === undefined) delete process.env.SCAFFOLD_DESK_HOST;
  else process.env.SCAFFOLD_DESK_HOST = host;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.SCAFFOLD_DESK_HOST;
    else process.env.SCAFFOLD_DESK_HOST = prior;
  }
}

check(
  "manifest path: tnt → manifest.tnt.json, dropdeaddev → manifest.ddd.json",
  manifestFilenameForHost("tnt") === "manifest.tnt.json" &&
    manifestFilenameForHost("dropdeaddev") === "manifest.ddd.json",
);
check(
  "manifest path: SCAFFOLD_DESK_HOST env injection drives both the hostname resolution and the suffix table (deterministic tests)",
  withDeskHost("tnt", () => resolveDeskHostname()) === "tnt" &&
    withDeskHost("tnt", () => resolveManifestPaths("/x").activePath) ===
      "/x/manifest.tnt.json" &&
    withDeskHost("dropdeaddev", () => resolveManifestPaths("/x").activePath) ===
      "/x/manifest.ddd.json",
);
let unknownHostThrew = false;
try {
  manifestFilenameForHost("bogus");
} catch {
  unknownHostThrew = true;
}
check(
  "manifest path: unknown host → fail-closed throw (no shared-file fallback — or the ping-pong returns)",
  unknownHostThrew,
);

// ── legacy-seed migration (one-time, in the recording path) ──

const migDir = tempStateDir();
const migLegacyText = manifestJson(parentState);
writeFileSync(join(migDir, LEGACY_MANIFEST_NAME), migLegacyText, "utf8");
const migPaths = withDeskHost("dropdeaddev", () => resolveManifestPaths(migDir));
const seededNow = seedSuffixedFromLegacy(migPaths);
check(
  "migration: suffixed absent + legacy present → seeded byte-identically from legacy",
  seededNow === true &&
    readFileSync(migPaths.activePath, "utf8") === migLegacyText,
);
check(
  "migration: legacy file left in place, untouched (inert; never deleted in a code change)",
  readFileSync(join(migDir, LEGACY_MANIFEST_NAME), "utf8") === migLegacyText,
);
writeFileSync(migPaths.activePath, manifestJson(currentState), "utf8");
check(
  "migration: one-time — an existing suffixed file is never re-seeded or overwritten",
  seedSuffixedFromLegacy(migPaths) === false &&
    readFileSync(migPaths.activePath, "utf8") === manifestJson(currentState),
);
const noLegacyDir = tempStateDir();
check(
  "migration: no legacy file → nothing seeded",
  seedSuffixedFromLegacy(
    withDeskHost("tnt", () => resolveManifestPaths(noLegacyDir)),
  ) === false && readdirSync(noLegacyDir).length === 0,
);

// ── cross-desk file isolation ──

const isoDir = tempStateDir();
writeFileSync(
  join(isoDir, "manifest.tnt.json"),
  manifestJson(parentState),
  "utf8",
);
check(
  "isolation: a tnt-suffixed manifest NEVER satisfies/silences a ddd drift check (missing, not fresh)",
  readManifestText(
    withDeskHost("dropdeaddev", () => resolveManifestPaths(isoDir)),
  ) === undefined,
);
const isoAsTnt = withDeskHost("tnt", () => resolveManifestPaths(isoDir));
check(
  "isolation: the tnt desk reads its own suffixed file",
  readManifestText(isoAsTnt)?.text === manifestJson(parentState),
);
// Stale/garbage legacy alongside an owned suffixed file: never opened.
writeFileSync(join(isoDir, LEGACY_MANIFEST_NAME), "{ garbage not json", "utf8");
const activeWins = readManifestText(isoAsTnt);
check(
  "isolation: once the desk owns its suffixed file, the legacy shared file is never read (stale legacy can neither alarm nor silence)",
  activeWins?.legacySeed === false &&
    activeWins?.text === manifestJson(parentState) &&
    readFileSync(join(isoDir, LEGACY_MANIFEST_NAME), "utf8") ===
      "{ garbage not json",
);

// ── first-run semantics + the ping-pong kill (end-to-end, pure) ──
// On pi both desks share the tier-map binding source; the cross-desk
// differentiator in a manifest is the anchor itself — parentState stands in
// for "the other desk's (stale-for-us) anchor", the realized ping-pong class.

const pingDir = tempStateDir();
// ddd pulls the change: the repo carries ONLY the legacy shared manifest,
// recorded from the other desk's anchor (the realized ping-pong class).
writeFileSync(join(pingDir, LEGACY_MANIFEST_NAME), manifestJson(parentState), "utf8");
const dddPaths = withDeskHost("dropdeaddev", () => resolveManifestPaths(pingDir));
const inherited = readManifestText(dddPaths);
check(
  "first-run: suffixed absent → legacy read as ONE-TIME migration seed (read-only)",
  inherited?.legacySeed === true && inherited?.text === manifestJson(parentState),
);
const firstCheck = checkDrift(inherited?.text, currentState);
check(
  "first-run: inherited the OTHER desk's anchor → drift fires ONCE (exactly the flag, exit-0 semantics)",
  firstCheck.outcome === "stale" && firstCheck.output === DRIFT_FLAG,
);
// The desk re-records locally (manifest.ts: seed migration, then record).
seedSuffixedFromLegacy(dddPaths);
writeFileSync(dddPaths.activePath, manifestJson(currentState), "utf8");
const secondCheck = checkDrift(readManifestText(dddPaths)?.text, currentState);
check(
  "first-run: after the local re-record → fresh (silence thereafter)",
  secondCheck.outcome === "fresh" && secondCheck.output === "",
);
// The other desk re-anchors — its own file AND the legacy shared file:
// neither can invalidate ddd's own file ever again.
writeFileSync(
  join(pingDir, "manifest.tnt.json"),
  manifestJson(parentState),
  "utf8",
);
writeFileSync(
  join(pingDir, LEGACY_MANIFEST_NAME),
  manifestJson(parentState),
  "utf8",
);
const thirdCheck = checkDrift(readManifestText(dddPaths)?.text, currentState);
check(
  "ping-pong dead: the other desk re-anchoring (its own suffixed file AND rewriting the legacy shared file) can never invalidate ddd again",
  thirdCheck.outcome === "fresh",
);

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  throw new Error(`${failed} test(s) failed (RED)`);
}
