// hazard-tripwire.ts — session-start scaffolding integrity gate.
//
// The 2026-09-27 omo-setup incident rider (operator-ordered, bd: senpi_tnt_tripwire):
// `omo setup` MOVED the whole ~/.pi/agent tree (memory store, .git, exports) and
// planted 4 OmO extension shims in extensions/ — and pi ran ~40 min silently
// degraded before a memory_remember ENOENT gave it away. This gate makes that
// class LOUD at session start instead of discovered by accident:
//
//   1. memory/store.jsonl exists and is non-empty   (the ENOENT tell, promoted to a check)
//   2. memory.md exists                             (narrative substrate)
//   3. .git exists at the agent root                (wholesale-move tell — a moved/recreated
//                                                    tree has no git identity)
//   4. no adoption markers                          (.adopted-from-omo-flat et al.)
//   5. extension manifest matches the pinned baseline (loader-discovery mirror: missing
//      entries = lost scaffolding; EXTRA entries = planted shims like diff.js/tps.js)
//
// Baseline lives at <agentDir>/hazard-tripwire.json — agent ROOT, outside the
// loader's scan, committed to pi-E → tamper-evident in git. A missing baseline is
// a distinct UNARMED state (fresh clone, or the tree was replaced) — never a
// silent pass. Host field is informational: both desks share the repo and must
// match on `entries`, not on host.
//
// Fail-loud surfaces: notify(error) + persistent footer status + widget banner
// (TUI), stderr (all modes), and a per-turn system-prompt block so the MODEL
// itself is told the session is degraded (before_agent_start composes through
// the systemPrompt getter chain — starts from event.systemPrompt, never a
// cached base, so prompt-coordinator and this gate compose in any order).
//
// Re-arm after INTENTIONAL extension changes: /tripwire rearm (confirm dialog,
// prints the diff vs the old baseline for the audit trail).
//
// The discovery mirror below is verified against pi 0.87.1 loader.js
// (discoverExtensionsInDir / resolveExtensionEntries / readPiManifest). If pi's
// discovery rules ever change, re-verify + re-arm.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import * as os from "node:os";

const AGENT_DIR = join(os.homedir(), ".pi", "agent");
const EXT_DIR = join(AGENT_DIR, "extensions");
const BASELINE_PATH = join(AGENT_DIR, "hazard-tripwire.json");
const BASELINE_VERSION = 1;
/** Files whose presence at the agent root means an adoption/flat-copy happened. */
const ADOPTION_MARKERS = [".adopted-from-omo-flat"];

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for tests. All mirror pi 0.87.1 loader semantics.
// ─────────────────────────────────────────────────────────────────────────────

export function isExtensionFile(name: string): boolean {
  return name.endsWith(".ts") || name.endsWith(".js");
}

/** Mirror of core/pi-manifest.ts readPiManifest — pi field, string-array entries only. */
export function readPiManifestMirror(pkgJsonPath: string): { extensions?: string[] } | null {
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8").replace(/^\uFEFF/, ""));
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) return null;
    const pi = pkg.pi;
    if (typeof pi !== "object" || pi === null || Array.isArray(pi)) return null;
    const exts = pi.extensions;
    if (Array.isArray(exts) && exts.every((e: unknown) => typeof e === "string")) {
      return { extensions: exts as string[] };
    }
    return null;
  } catch {
    return null;
  }
}

/** Mirror of loader resolveExtensionEntries — absolute entry paths, or null. */
export function resolveExtensionEntriesMirror(dir: string): string[] | null {
  const pkgJson = join(dir, "package.json");
  if (existsSync(pkgJson)) {
    const manifest = readPiManifestMirror(pkgJson);
    if (manifest?.extensions?.length) {
      const entries = manifest.extensions
        .map((p) => join(dir, p))
        .filter((p) => existsSync(p));
      if (entries.length > 0) return entries;
    }
  }
  const indexTs = join(dir, "index.ts");
  if (existsSync(indexTs)) return [indexTs];
  const indexJs = join(dir, "index.js");
  if (existsSync(indexJs)) return [indexJs];
  return null;
}

/**
 * Mirror of loader discoverExtensionsInDir over the GLOBAL agent extensions dir,
 * returning sorted POSIX-relative entry paths (e.g. "agent-chain.ts",
 * "calm/index.ts"). Order-independent (sorted) because the loader's readdir
 * order is filesystem-defined; the SET is what the baseline pins.
 */
export function discoverExtensionEntries(extDir: string): string[] {
  if (!existsSync(extDir)) return [];
  const found: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(extDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const entryPath = join(extDir, entry.name);
    const isLink = entry.isSymbolicLink();
    if ((entry.isFile() || isLink) && isExtensionFile(entry.name)) {
      found.push(entryPath);
      continue;
    }
    if (entry.isDirectory() || isLink) {
      const resolved = resolveExtensionEntriesMirror(entryPath);
      if (resolved) found.push(...resolved);
    }
  }
  return found
    .map((p) => relative(extDir, p).split(sep).join("/"))
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline + classification
// ─────────────────────────────────────────────────────────────────────────────

export interface Baseline {
  version: number;
  armedAt: string;
  host: string;
  mirrorOf: string;
  entries: string[];
}

export type TripwireStatus = "pass" | "unarmed" | "hazard";

export interface TripwireState {
  status: TripwireStatus;
  /** Baseline entries no longer discovered — lost/moved scaffolding. */
  missing: string[];
  /** Discovered entries not in the baseline — planted shims / drift. */
  extra: string[];
  /** Non-manifest failures (memory store, narrative, .git, markers, baseline). */
  failures: string[];
}

export function writeBaseline(
  baselinePath: string,
  extDir: string,
  host: string,
): Baseline {
  const baseline: Baseline = {
    version: BASELINE_VERSION,
    armedAt: new Date().toISOString(),
    host,
    mirrorOf: "pi 0.87.1 loader discovery rules",
    entries: discoverExtensionEntries(extDir),
  };
  mkdirSync(join(baselinePath, ".."), { recursive: true });
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
  return baseline;
}

/** Returns null when the file is absent; throws nothing; corrupt JSON → hazard via failures. */
export function loadBaseline(baselinePath: string): { baseline: Baseline | null; failure?: string } {
  if (!existsSync(baselinePath)) return { baseline: null };
  try {
    const raw = JSON.parse(readFileSync(baselinePath, "utf-8"));
    if (
      typeof raw !== "object" || raw === null ||
      raw.version !== BASELINE_VERSION ||
      !Array.isArray(raw.entries) || !raw.entries.every((e: unknown) => typeof e === "string")
    ) {
      return { baseline: null, failure: "baseline present but malformed (version/shape) — tamper-evidence trip" };
    }
    return {
      baseline: {
        version: raw.version,
        armedAt: typeof raw.armedAt === "string" ? raw.armedAt : "",
        host: typeof raw.host === "string" ? raw.host : "",
        mirrorOf: typeof raw.mirrorOf === "string" ? raw.mirrorOf : "",
        entries: raw.entries as string[],
      },
    };
  } catch {
    return { baseline: null, failure: "baseline present but unparseable — tamper-evidence trip" };
  }
}

export function checkScaffolding(agentDir: string, baselinePath: string): TripwireState {
  const failures: string[] = [];

  const store = join(agentDir, "memory", "store.jsonl");
  if (!existsSync(store)) failures.push("memory store missing: memory/store.jsonl");
  else if (statSync(store).size === 0) failures.push("memory store EMPTY: memory/store.jsonl");

  if (!existsSync(join(agentDir, "memory.md"))) failures.push("memory.md missing");
  if (!existsSync(join(agentDir, ".git"))) failures.push("agent dir lost git identity (.git missing)");

  for (const marker of ADOPTION_MARKERS) {
    if (existsSync(join(agentDir, marker))) failures.push(`adoption marker present: ${marker}`);
  }

  const { baseline, failure } = loadBaseline(baselinePath);
  if (failure) failures.push(failure);

  const current = discoverExtensionEntries(join(agentDir, "extensions"));
  const missing: string[] = [];
  const extra: string[] = [];
  if (baseline) {
    const pinned = new Set(baseline.entries);
    const have = new Set(current);
    missing.push(...[...pinned].filter((e) => !have.has(e)).sort());
    extra.push(...current.filter((e) => !pinned.has(e)));
  }

  let status: TripwireStatus = "pass";
  if (failures.length > 0 || missing.length > 0 || extra.length > 0) status = "hazard";
  else if (!baseline) status = "unarmed";
  return { status, missing, extra, failures };
}

// ─────────────────────────────────────────────────────────────────────────────
// Presentation (pure formatting — exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

function listFmt(items: string[], max = 4): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} +${items.length - max} more` : shown;
}

// State→status-key mapping: color lives in settings.json customItems per key
// (static theme tokens), so the footer "turns green when all green" by the
// extension publishing exactly one key per state. See statusline-encom.ts
// CustomItem: { id, color, hideWhenMissing } — text-only setStatus.
export function statusKeyFor(state: TripwireState): "tripwire-ok" | "tripwire-warn" | "tripwire-hazard" {
  if (state.status === "pass") return "tripwire-ok";
  if (state.status === "unarmed") return "tripwire-warn";
  return "tripwire-hazard";
}

export function formatStatusLine(state: TripwireState): string {
  if (state.status === "pass") return "tripwire: armed ✓";
  if (state.status === "unarmed") return "⚠ tripwire UNARMED (no baseline — /tripwire rearm)";
  const bits: string[] = [];
  if (state.missing.length) bits.push(`${state.missing.length} missing`);
  if (state.extra.length) bits.push(`${state.extra.length} extra`);
  if (state.failures.length) bits.push(`${state.failures.length} failures`);
  return `⛔ TRIPWIRE: ${bits.join(" · ") || "integrity violated"}`;
}

export function formatDetail(state: TripwireState): string {
  const lines: string[] = [formatStatusLine(state)];
  if (state.failures.length) lines.push(`failures:\n  - ${state.failures.join("\n  - ")}`);
  if (state.missing.length) lines.push(`missing (pinned but not discovered):\n  - ${state.missing.join("\n  - ")}`);
  if (state.extra.length) lines.push(`extra (discovered but not pinned — planted?):\n  - ${state.extra.join("\n  - ")}`);
  if (state.status !== "hazard") lines.push("all checks green");
  return lines.join("\n");
}

export function formatWidget(state: TripwireState): string[] {
  const w = ["⛔ HAZARD TRIPWIRE FIRED — pi scaffolding integrity violated"];
  if (state.missing.length) w.push(`  missing: ${listFmt(state.missing)}`);
  if (state.extra.length) w.push(`  extra (planted?): ${listFmt(state.extra)}`);
  if (state.failures.length) w.push(`  ${listFmt(state.failures)}`);
  w.push("  → /tripwire for detail — do NOT trust memory/skills/extensions until repaired");
  return w;
}

export function formatHazardBlock(state: TripwireState): string {
  const parts: string[] = [];
  if (state.failures.length) parts.push(`failures: ${state.failures.join("; ")}`);
  if (state.missing.length) parts.push(`missing: ${state.missing.join(", ")}`);
  if (state.extra.length) parts.push(`extra: ${state.extra.join(", ")}`);
  return [
    "<hazard-tripwire>",
    "SESSION HAZARD ACTIVE: pi's own scaffolding failed integrity verification at session start.",
    parts.join(" | "),
    "Do NOT assume memory, skills, or extensions are intact. Surface this hazard to the operator in your next reply,",
    "avoid writing to memory tools until the tree is verified, and refer to the incident runbook",
    "(exports/incident-omo-setup-20260927/) for the repair pattern.",
    "</hazard-tripwire>",
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

let current: TripwireState = { status: "pass", missing: [], extra: [], failures: [] };

function paint(ctx: { ui?: { notify(m: string, t?: "info" | "warning" | "error"): void; setStatus(k: string, t: string | undefined): void; setWidget(k: string, c: string[] | undefined): void } }): void {
  const ui = ctx.ui;
  if (!ui) return;
  const key = statusKeyFor(current);
  // Publish exactly one key (the customItem bound to it carries the state
  // color); clear the siblings so no stale label survives a re-arm.
  for (const k of ["tripwire-ok", "tripwire-warn", "tripwire-hazard"]) {
    if (k !== key) ui.setStatus(k, undefined);
  }
  ui.setStatus(key, formatStatusLine(current));
  if (current.status === "hazard") {
    ui.setWidget("hazard-tripwire", formatWidget(current));
    ui.notify(`HAZARD TRIPWIRE\n\n${formatDetail(current)}`, "error");
  } else {
    ui.setWidget("hazard-tripwire", undefined);
    if (current.status === "unarmed") {
      ui.notify("Hazard tripwire is UNARMED — no baseline pinned. Run /tripwire rearm after verifying the tree.", "warning");
    }
  }
}

export default function register(pi: ExtensionAPI): void {
  // Session-start verify: the ordered rider. Runs in EVERY mode (checks are
  // mode-independent); UI surfaces only exist in TUI. Never throws — a broken
  // tripwire must not brick session start, it must degrade to stderr.
  pi.on("session_start", async (_e, ctx) => {
    try {
      current = checkScaffolding(AGENT_DIR, BASELINE_PATH);
    } catch (e) {
      current = { status: "hazard", missing: [], extra: [], failures: [`tripwire itself failed: ${(e as Error).message}`] };
    }
    if (current.status === "hazard") {
      console.error(`[hazard-tripwire] ${formatDetail(current)}`);
    }
    if (ctx?.mode === "tui") paint(ctx);
  });

  // Agent-loud: while hazard is active, append a constant block to the system
  // prompt every turn. Composes from the getter (never a cached base) so
  // prompt-coordinator and this gate chain correctly in any discovery order.
  pi.on("before_agent_start", async (event) => {
    if (current.status !== "hazard") return;
    return { systemPrompt: event.systemPrompt + "\n\n" + formatHazardBlock(current) };
  });

  pi.registerCommand("tripwire", {
    description: "Scaffolding integrity gate: status, or rearm after intentional changes (/tripwire rearm)",
    handler: async (args, ctx) => {
      if (args.trim() === "rearm") {
        const preview = discoverExtensionEntries(EXT_DIR);
        const ok = await ctx.ui.confirm(
          "Re-arm hazard tripwire?",
          `Pin ${preview.length} discovered extension entries as the new baseline?\n` +
          (current.missing.length || current.extra.length
            ? `Diff vs current state — missing: ${listFmt(current.missing) || "none"}; extra: ${listFmt(current.extra) || "none"}\n`
            : "") +
          "Only do this after an INTENTIONAL extension change.",
        );
        if (!ok) return;
        writeBaseline(BASELINE_PATH, EXT_DIR, os.hostname());
        current = checkScaffolding(AGENT_DIR, BASELINE_PATH);
        paint(ctx);
        ctx.ui.notify(`Tripwire re-armed: ${preview.length} entries pinned.\n${formatDetail(current)}`, "info");
        return;
      }
      current = checkScaffolding(AGENT_DIR, BASELINE_PATH);
      paint(ctx);
      ctx.ui.notify(`Hazard tripwire\n\n${formatDetail(current)}`, current.status === "hazard" ? "error" : "info");
    },
  });
}
