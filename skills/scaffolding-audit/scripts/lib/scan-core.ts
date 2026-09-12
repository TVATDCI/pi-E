/**
 * Deterministic classification engine + report renderer (pi landing).
 *
 * Determinism contract (shared spec §7 + E-2 harness pin): no network, no model
 * calls, no wall-clock fields in the report — output is a pure function of
 * (tree state, vendored spec, manifest anchor).
 */

import type { ScanRule, RuleTable } from "./spec.ts";
import { hashIdentity } from "./spec.ts";
import type { FlagRecord } from "./finding.ts";
import { makeFlag } from "./finding.ts";
import type { Surface } from "./surfaces.ts";
import { isCommentLine } from "./surfaces.ts";
import { execFileSync } from "node:child_process";

export type ScopeMode = "full" | "diff";

export type ManifestAnchor = {
  lastAuditCommit?: Record<string, string>;
};

export type ScanResult = {
  scope: ScopeMode;
  specSelf: string;
  specTwin: string | undefined;
  hashIdentical: boolean;
  surfacesPlanned: Surface[];
  surfacesScanned: Surface[];
  flags: FlagRecord[];
  doctrineDiff: string;
};

function git(agentRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: agentRoot, encoding: "utf8" });
  } catch {
    return undefined;
  }
}

function ruleAppliesToLine(
  rule: ScanRule,
  line: string,
  surface: Surface,
): boolean {
  if (rule.where === "comment" && surface.kind === "ts" && !isCommentLine(line)) {
    return false;
  }
  return true;
}

function lineExcluded(rule: ScanRule, line: string): boolean {
  if (rule.excludeLine === undefined) return false;
  const re = new RegExp(rule.excludeLine, rule.excludeLineFlags ?? "");
  return re.test(line);
}

/** UTC date string (YYYY-MM-DD) for the dated-if-before rule comparison. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export function classifyText(
  text: string,
  surface: Surface,
  rules: ScanRule[],
): FlagRecord[] {
  const seen = new Set<string>();
  const flags: FlagRecord[] = [];
  const lines = text.split("\n");
  const today = utcToday();
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, rule.flags);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const key = `${surface.path}\n${i + 1}\n${rule.class}`;
      if (seen.has(key)) continue;
      if (!ruleAppliesToLine(rule, line, surface)) continue;
      if (lineExcluded(rule, line)) continue;
      const match = re.exec(line);
      if (match === null) continue;
      if (rule.datedIfBefore === true) {
        const date = match[2];
        if (typeof date !== "string" || date >= today) continue;
      }
      seen.add(key);
      flags.push(
        makeFlag(surface.path, i + 1, rule.id, rule.class, line, rule.action),
      );
    }
  }
  flags.sort((a, b) =>
    a.file === b.file
      ? a.line === b.line
        ? a.class - b.class
        : a.line - b.line
      : a.file < b.file
        ? -1
        : 1
  );
  return flags;
}

function changedSince(
  agentRoot: string,
  anchor: Record<string, string> | undefined,
  surfaces: Surface[],
): Surface[] {
  if (anchor === undefined) return surfaces;
  const commit = Object.values(anchor)[0];
  if (commit === undefined || commit === "") return surfaces;
  const diffNames = git(agentRoot, [
    "diff", "--name-only", `${commit}..HEAD`,
  ]) ?? "";
  const porcelain = git(agentRoot, ["status", "--porcelain", "-uall"]) ?? "";
  const changed = new Set<string>();
  for (const name of diffNames.split("\n")) {
    if (name !== "") changed.add(name);
  }
  for (const row of porcelain.split("\n")) {
    if (row === "") continue;
    // "?? path" / " M path" — path starts at column 4 in porcelain -uall output.
    const path = row.slice(3).replace(/^"|"$/g, "");
    changed.add(path);
  }
  return surfaces.filter((s) => changed.has(s.path));
}

function doctrineDiffSection(
  agentRoot: string,
  anchor: Record<string, string> | undefined,
  surfaces: Surface[],
): string {
  if (anchor === undefined) {
    return [
      "No manifest on record — doctrine-diff baseline is not yet anchored.",
      "This run establishes the baseline; record it with an explicit non-dry",
      "audit run (scripts/manifest.ts) to anchor future diffs.",
    ].join("\n");
  }
  const commit = Object.values(anchor)[0];
  if (commit === undefined || commit === "") {
    return "Manifest carries an empty last-audit-commit anchor — re-record the manifest.";
  }
  const paths = surfaces.map((s) => s.path);
  const stat = git(agentRoot, [
    "diff", "--stat", `${commit}..HEAD`, "--", ...paths,
  ]);
  if (stat === undefined) {
    return `git anchor unavailable — last-audit-commit ${commit} not diffable here.`;
  }
  if (stat.trim() === "") {
    return `No doctrine-bearing changes since last-audit-commit ${commit}.`;
  }
  return `Changes since last-audit-commit ${commit}:\n${stat.trimEnd()}`;
}

export function runScan(
  agentRoot: string,
  scope: ScopeMode,
  table: RuleTable,
  specSelfText: string,
  specTwinText: string | undefined,
  surfaces: Surface[],
  anchor: ManifestAnchor,
  readText: (absPath: string) => string,
): ScanResult {
  const identity = hashIdentity(specSelfText, specTwinText);
  const planned = scope === "diff"
    ? changedSince(agentRoot, anchor.lastAuditCommit, surfaces)
    : surfaces;
  const flags: FlagRecord[] = [];
  const scanned: Surface[] = [];
  for (const surface of planned) {
    let text: string;
    try {
      text = readText(surface.absPath);
    } catch {
      continue; // surface vanished between enumeration and read — skip, stay read-only
    }
    scanned.push(surface);
    flags.push(...classifyText(text, surface, table.rules));
  }
  return {
    scope,
    specSelf: identity.self,
    specTwin: identity.twin,
    hashIdentical: identity.identical,
    surfacesPlanned: surfaces,
    surfacesScanned: scanned,
    flags,
    doctrineDiff: doctrineDiffSection(agentRoot, anchor.lastAuditCommit, surfaces),
  };
}

const CLASS_NAMES: Record<FlagRecord["class"], string> = {
  1: "model identifiers (current AND historical) in prose",
  2: "workaround language tied to named failure modes",
  3: "quota/limit constants pinned to a plan/model era",
  4: "tier/doctrine references",
  5: "knowledge now redundant with newer training data",
};

export function renderReport(result: ScanResult): string {
  const out: string[] = [];
  out.push("# scaffolding-audit report — pi surface");
  out.push("");
  out.push(`- scope: ${result.scope} (operator-selected argument)`);
  out.push(`- vendored spec sha256: ${result.specSelf}`);
  out.push(
    result.specTwin === undefined
      ? "- twin spec copy: not reachable on this desk (hash recorded for cross-desk comparison)"
      : `- twin spec sha256: ${result.specTwin} (hash-identity: ${
        result.hashIdentical ? "MATCH" : "MISMATCH — HARD STOP"
      })`,
  );
  out.push(
    `- surfaces scanned: ${result.surfacesScanned.length} of ${result.surfacesPlanned.length} planned (self-enumerated)`,
  );
  out.push(`- flags: ${result.flags.length}`);
  out.push("");
  if (!result.hashIdentical) {
    out.push("## HARD STOP — spec divergence (AC-13)");
    out.push("");
    out.push(
      "Vendored spec copies differ. Re-vendor identical copies into BOTH landings before auditing.",
    );
    return out.join("\n") + "\n";
  }
  out.push("## Flags");
  out.push("");
  if (result.flags.length === 0) {
    out.push("_None — no rule-table hits on scanned surfaces._");
  }
  for (const flag of result.flags) {
    out.push(
      `### [class ${flag.class} — ${CLASS_NAMES[flag.class]}] ${flag.file}:${flag.line}`,
    );
    out.push(`- rule: \`${flag.rule}\``);
    out.push(`- quote: \`${flag.quote}\``);
    out.push(`- action: ${flag.action}`);
    out.push(`- finding-hash: \`${flag.hash}\``);
    out.push("");
  }
  out.push("## Doctrine diff");
  out.push("");
  out.push(result.doctrineDiff);
  out.push("");
  out.push("## model-audit leg (composed — D4)");
  out.push("");
  out.push(
    "Script leg does not probe endpoints (determinism: no network). Invoke the existing",
  );
  out.push(
    "`model-audit` skill and embed its output verbatim here; if unavailable, record a",
  );
  out.push("noted-missing leg — the text audit above still stands.");
  return out.join("\n") + "\n";
}
