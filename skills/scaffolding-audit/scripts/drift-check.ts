/**
 * Drift-check CLI (pi) — the OPEN-2 session-start slot consumer.
 *
 * Read-only bounded read (INV-2): opens EXACTLY two files — the state
 * manifest and the tier-map (model-binding source of truth) — and nothing
 * else. Never writes (run under `deno run --allow-read` — the grant proves
 * it). Output contract (shared spec §4): stale or missing → the single
 * reminder flag on stdout, exit 0; fresh → silence, exit 0; unreadable
 * manifest → explicit error on stderr, exit 1, no rebuild.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { checkDrift } from "./lib/drift.ts";
import { extractModelState, TIER_MAP_REL } from "./lib/model-state.ts";
import { readManifestText, resolveManifestPaths } from "./lib/manifest-path.ts";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SKILL_DIR = join(SCRIPT_DIR, "..");
const AGENT_ROOT = join(SKILL_DIR, "..", "..");
// Desk-suffixed manifest: hostname-resolved (state/manifest.<ddd|tnt>.json); the
// legacy shared manifest.json is a migration-seed read only while the suffixed
// file is absent.
const MANIFEST_PATHS = resolveManifestPaths(join(SKILL_DIR, "state"));
const DEFAULT_MANIFEST = MANIFEST_PATHS.activePath;
const DEFAULT_TIER_MAP = join(AGENT_ROOT, TIER_MAP_REL);

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let manifestPath = DEFAULT_MANIFEST;
  let tierMapPath = DEFAULT_TIER_MAP;
  let json = false;
  for (const arg of argv) {
    if (arg.startsWith("--manifest=")) manifestPath = arg.slice("--manifest=".length);
    else if (arg.startsWith("--tier-map=")) tierMapPath = arg.slice("--tier-map=".length);
    else if (arg === "--json") json = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }

  // Distinguish missing (flag, exit 0) from present-but-unreadable (error, exit 1).
  // The DEFAULT path resolves desk-suffixed with a one-time legacy migration
  // seed; an explicit --manifest= override is honored as the exact path given
  // (no seed fallback — explicit means explicit).
  let manifestText: string | undefined;
  if (manifestPath === DEFAULT_MANIFEST) {
    const resolved = readManifestText(MANIFEST_PATHS);
    manifestText = resolved?.text;
    if (resolved?.legacySeed === true) {
      console.error(
        `note: ${MANIFEST_PATHS.activePath} absent — using the legacy shared ` +
          `manifest as a ONE-TIME migration seed (desk-suffixed manifests); ` +
          `if the inherited anchor was the other desk's, the flag below fires ` +
          `once — re-record locally and it stays silent.`,
      );
    }
  } else {
    try {
      manifestText = readFileSync(manifestPath, "utf8");
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "ENOENT") manifestText = undefined;
      else throw err;
    }
  }

  const tierMapText = readFileSync(tierMapPath, "utf8");
  const currentState = extractModelState(tierMapText, TIER_MAP_REL);

  let result;
  try {
    result = checkDrift(manifestText, currentState);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else if (result.output !== "") {
    process.stdout.write(result.output + "\n");
  }
  process.exit(0);
}

main();
