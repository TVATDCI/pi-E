/**
 * Manifest CLI (pi) — the EXPLICIT non-dry audit run.
 *
 * INV-1 exception (a): the writeFileSync below is the skill's ONLY write —
 * its own state-dir manifest, on this explicit non-dry invocation only.
 * Never at session start; superseded by each new audit; no cleanup job.
 *
 * Invocation: deno run --allow-read --allow-run=git --allow-env \
 *   --allow-write=<skill-dir>/state scripts/manifest.ts --scope=full
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseRuleTable } from "./lib/spec.ts";
import { runScan, renderReport } from "./lib/scan-core.ts";
import type { ManifestAnchor } from "./lib/scan-core.ts";
import { piSurfaces } from "./lib/surfaces.ts";
import { extractModelState, TIER_MAP_REL } from "./lib/model-state.ts";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SKILL_DIR = join(SCRIPT_DIR, "..");
const AGENT_ROOT = join(SKILL_DIR, "..", "..");
const SPEC_SELF = join(SKILL_DIR, "spec", "spec-shared.md");
const SPEC_TWIN = join(
  AGENT_ROOT,
  "..",
  "..",
  ".config",
  "opencode",
  "skills",
  "scaffolding-audit",
  "spec",
  "spec-shared.md",
);
const STATE_DIR = join(SKILL_DIR, "state");
const MANIFEST_PATH = join(STATE_DIR, "manifest.json");
const TIER_MAP_ABS = join(AGENT_ROOT, TIER_MAP_REL);

function usage(): never {
  console.error(
    "usage: manifest.ts --scope=full | --scope=diff\n" +
      "  --scope is REQUIRED and invocation-selected — never auto-detected.",
  );
  process.exit(2);
}

function parseScope(argv: string[]): "full" | "diff" | undefined {
  let scope: "full" | "diff" | undefined;
  for (const arg of argv) {
    if (arg === "--scope=full") scope = "full";
    else if (arg === "--scope=diff") scope = "diff";
    else usage();
  }
  return scope;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function headCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: AGENT_ROOT,
    encoding: "utf8",
  }).trim();
}

function main(): void {
  const scope = parseScope(process.argv.slice(2));
  if (scope === undefined) usage();

  const specText = readFileSync(SPEC_SELF, "utf8");
  const table = parseRuleTable(specText);
  const twinText = readIfExists(SPEC_TWIN);

  let anchor: ManifestAnchor = {};
  const priorText = readIfExists(MANIFEST_PATH);
  if (priorText !== undefined) {
    try {
      const prior: unknown = JSON.parse(priorText);
      if (
        typeof prior === "object" && prior !== null &&
        "last-audit-commit" in prior
      ) {
        const a = (prior as { "last-audit-commit": unknown })[
          "last-audit-commit"
        ];
        if (typeof a === "object" && a !== null && !Array.isArray(a)) {
          const clean: Record<string, string> = {};
          for (const [k, v] of Object.entries(a)) {
            if (typeof v === "string") clean[k] = v;
          }
          anchor = { lastAuditCommit: clean };
        }
      }
    } catch {
      console.error("prior manifest unreadable — refusing to record over it");
      process.exit(1);
    }
  }
  if (scope === "diff" && anchor.lastAuditCommit === undefined) {
    console.error(
      "diff-scope requires a manifest anchor — none on record (never audited).",
    );
    process.exit(2);
  }

  const result = runScan(
    AGENT_ROOT,
    scope,
    table,
    specText,
    twinText,
    piSurfaces(AGENT_ROOT),
    anchor,
    (p) => readFileSync(p, "utf8"),
  );
  process.stdout.write(renderReport(result));
  if (!result.hashIdentical) process.exit(3);

  const tierMapText = readFileSync(TIER_MAP_ABS, "utf8");
  const manifest = {
    "recorded-at": new Date().toISOString(),
    "surface-scope": "pi",
    "last-audit-commit": { "~/.pi/agent": headCommit() },
    "model-state": extractModelState(tierMapText, TIER_MAP_REL),
    "finding-hashes": result.flags.map((f) => f.hash),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  // INV-1 exception (a): the skill's own state-dir manifest, explicit non-dry
  // run only — the single permitted write in this entire skill.
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.stdout.write(`\nmanifest recorded: ${MANIFEST_PATH}\n`);
}

main();
