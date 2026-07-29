// extensions/acceptance.ts — acceptance gates for chain steps.
// Ported (slimmed) from pi-subagents/src/runs/shared/acceptance.ts.
//
// SECURITY POSTURE (ABSORPTION-PLAN.md §A, Oracle GO-WITH-CHANGES 2026-07-30):
// verify-commands are a FIXED ENUM command table — kind ∈ {test,typecheck,lint,build} → fixed
// argv, shell:false, NO YAML env/cwd override. The reference runs spawn(command.command,
// {env:{...process.env,...command.env}, shell:true}) — YAML-driven arbitrary parent-process exec.
// Our chain config is deny-additive (project layer adds chains) and run_chain is LLM-callable,
// so arbitrary exec would let any checked-out repo run shell in the parent. Enum-only fixes that;
// arbitrary commands are deferred to a future global-layer + trust-gated config.
//
// SCOPE NOTES (deliberate slimming vs the reference — doc honesty):
//  - `checked` here = report present + git-clean (no staged files). The reference additionally
//    cross-checks required-evidence presence and criteria satisfaction; those are NOT ported, so
//    our `checked` is thinner. Upgrade intentionally if you need stricter structural gates.
//  - FOOTGUN: a `verify:` list is only executed when level === "verified". `verify:` on a lower
//    level (or under auto) silently never runs. Always pair `verify:` with level: verified.
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AcceptanceLevel = "none" | "attested" | "checked" | "verified";
export type ResolvedLevel = Exclude<AcceptanceLevel, "none">;
export type Provenance = "claimed" | "attested" | "checked" | "verified" | "rejected";
export type VerifyKind = "test" | "typecheck" | "lint" | "build";

export interface VerifySpec {
  id: string;
  kind: VerifyKind;
  timeoutMs?: number;
  allowFailure?: boolean;
}

export interface AcceptanceInput {
  level?: "auto" | AcceptanceLevel;
  criteria?: { id: string; must: string }[];
  evidence?: string[];
  verify?: VerifySpec[];
  reason?: string;
}

export interface ResolvedAcceptance {
  level: ResolvedLevel;
  criteria: { id: string; must: string }[];
  evidence: string[];
  verify: VerifySpec[];
  reason?: string;
  inferred: boolean; // true ⇒ auto-inferred ⇒ badge-only, NEVER rejects
}

export interface AcceptanceReport {
  criteriaSatisfied?: unknown;
  changedFiles?: unknown;
  testsAddedOrUpdated?: unknown;
  commandsRun?: unknown;
  validationOutput?: unknown;
  residualRisks?: unknown;
  noStagedFiles?: unknown;
  diffSummary?: unknown;
  reviewFindings?: unknown;
  manualNotes?: unknown;
}

export interface VerifyResult {
  id: string;
  kind: VerifyKind;
  status: "passed" | "failed" | "timed-out";
  durationMs: number;
  output?: string;
}

/** Compact form attached to ChainStepResult for the widget + dispatch-log. */
export interface StepAcceptance {
  level: ResolvedLevel;
  provenance: Provenance;
  inferred: boolean;
  failStep: boolean;
  parseError?: string;
  verifyResults?: VerifyResult[];
}

// --- Security: fixed enum command table. shell:false, parent env only, no YAML env/cwd. ---
const VERIFY_ARGV: Record<VerifyKind, readonly string[]> = {
  test: ["npm", "test"],
  typecheck: ["tsc", "--noEmit"],
  lint: ["npm", "run", "lint"],
  build: ["npm", "run", "build"],
};
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000;
const VALID_KINDS = new Set<VerifyKind>(["test", "typecheck", "lint", "build"]);
const LEVELS = new Set<string>(["auto", "none", "attested", "checked", "verified"]);
const LEVEL_RANK: Record<Provenance, number> = { claimed: 0, attested: 1, checked: 2, verified: 3, rejected: -1 };

/**
 * Infer the default level from an agent's declared tools. `edit`/`write` present ⇒ writer ⇒
 * `checked` (there are changed files to structurally verify); otherwise `attested` (recon /
 * reasoning / review / drafting — output is text, nothing to structurally check).
 */
export function inferDefaultLevel(tools: string | undefined): ResolvedLevel {
  const t = (tools ?? "").toLowerCase();
  return t.includes("edit") || t.includes("write") ? "checked" : "attested";
}

function defaultEvidence(level: ResolvedLevel): string[] {
  return level === "attested" ? [] : ["changed-files", "no-staged-files"];
}

/**
 * Resolve the effective acceptance config. `null` ⇒ gate disabled (level:none). `inferred:true`
 * ⇒ auto-inferred (or no config) ⇒ badge-only, never rejects the step.
 */
export function resolveAcceptance(input: AcceptanceInput | undefined, inferred: ResolvedLevel): ResolvedAcceptance | null {
  if (!input) return { level: inferred, criteria: [], evidence: defaultEvidence(inferred), verify: [], inferred: true };
  const rawLevel = input.level ?? "auto";
  if (rawLevel === "none") return null;
  const level: ResolvedLevel = rawLevel === "auto" ? inferred : (rawLevel as ResolvedLevel);
  const isAuto = rawLevel === "auto" || input.level === undefined;
  return {
    level,
    criteria: input.criteria ?? [],
    evidence: input.evidence ?? defaultEvidence(level),
    verify: input.verify ?? [],
    reason: input.reason,
    inferred: isAuto,
  };
}

/**
 * Coerce/validate raw YAML acceptance config (called from normalizeChainsFile so `acceptance:`
 * survives parsing instead of being silently stripped). Drops verify entries whose `kind` is not
 * in the enum, and never copies `command`/`env`/`cwd` (those keys are unsupported on purpose).
 */
export function coerceAcceptance(raw: unknown): AcceptanceInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  let level: AcceptanceInput["level"] | undefined;
  if (typeof r.level === "string" && LEVELS.has(r.level)) level = r.level as AcceptanceInput["level"];
  else if (r.level !== undefined) return undefined; // invalid level ⇒ drop the whole gate

  let criteria: AcceptanceInput["criteria"] | undefined;
  if (Array.isArray(r.criteria)) {
    criteria = r.criteria
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({ id: String(c.id ?? ""), must: String(c.must ?? "") }))
      .filter((c) => c.id);
    if (!criteria.length) criteria = undefined;
  }

  let evidence: string[] | undefined;
  if (Array.isArray(r.evidence)) {
    evidence = r.evidence.filter((e): e is string => typeof e === "string");
    if (!evidence.length) evidence = undefined;
  }

  let verify: VerifySpec[] | undefined;
  if (Array.isArray(r.verify)) {
    const list: VerifySpec[] = [];
    for (const v of r.verify) {
      if (!v || typeof v !== "object") continue;
      const vv = v as Record<string, unknown>;
      if (typeof vv.kind === "string" && VALID_KINDS.has(vv.kind as VerifyKind)) {
        // Only id/kind/timeoutMs/allowFailure are copied — command/env/cwd are intentionally ignored.
        list.push({
          id: typeof vv.id === "string" ? vv.id : (vv.kind as string),
          kind: vv.kind as VerifyKind,
          ...(typeof vv.timeoutMs === "number" && vv.timeoutMs > 0 ? { timeoutMs: vv.timeoutMs } : {}),
          ...(typeof vv.allowFailure === "boolean" ? { allowFailure: vv.allowFailure } : {}),
        });
      }
    }
    if (list.length) verify = list;
  }

  const out: AcceptanceInput = {};
  if (level !== undefined) out.level = level;
  if (criteria) out.criteria = criteria;
  if (evidence) out.evidence = evidence;
  if (verify) out.verify = verify;
  if (typeof r.reason === "string") out.reason = r.reason;
  return Object.keys(out).length ? out : undefined;
}

export function formatAcceptancePrompt(a: ResolvedAcceptance): string {
  const lines: string[] = [
    "",
    "## Acceptance Contract",
    `Acceptance level: ${a.level}`,
    "Completion is not accepted from prose alone. End with a structured acceptance report.",
    "",
    "Criteria:",
    ...(a.criteria.length ? a.criteria.map((c) => `- ${c.id}: ${c.must}`) : ["- Return the requested result."]),
    "",
    `Required evidence: ${a.evidence.join(", ") || "none"}`,
  ];
  if (a.verify.length > 0) {
    lines.push("", "Runtime verification (parent-run, fixed commands):");
    for (const v of a.verify) lines.push(`- ${v.id}: ${v.kind}`);
  }
  lines.push(
    "",
    "Finish with a fenced JSON block tagged `acceptance-report` in this shape:",
    "Use empty arrays when no items apply.",
    "```acceptance-report",
    JSON.stringify(
      {
        criteriaSatisfied: [{ id: "criterion-1", status: "satisfied", evidence: "specific proof" }],
        changedFiles: ["src/file.ts"],
        testsAddedOrUpdated: ["test/file.test.ts"],
        commandsRun: [{ command: "command", result: "passed", summary: "short result" }],
        validationOutput: ["validation output or concise summary"],
        residualRisks: ["none"],
        noStagedFiles: true,
        diffSummary: "short description of the diff",
        reviewFindings: ["blocker: file.ts:12 - issue, or no blockers"],
        manualNotes: "anything else the parent should know",
      },
      null,
      2,
    ),
    "```",
  );
  return lines.join("\n");
}

// --- report parsing (ported) ---

function extractBalancedJson(text: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return undefined;
}

function fencedBlocks(output: string, tag: string): string[] {
  return [...output.matchAll(new RegExp("```" + tag + "\\s*\\n([\\s\\S]*?)```", "gi"))]
    .map((m) => m[1]?.trim())
    .filter((v): v is string => Boolean(v));
}

function parseReportJson(body: string): AcceptanceReport {
  const trimmed = body.trim();
  try {
    return JSON.parse(trimmed) as AcceptanceReport;
  } catch {
    const start = trimmed.indexOf("{");
    if (start >= 0) {
      const json = extractBalancedJson(trimmed, start);
      if (json) return JSON.parse(json) as AcceptanceReport;
    }
    throw new Error("no JSON object found");
  }
}

export function parseAcceptanceReport(output: string): { report?: AcceptanceReport; error?: string } {
  const errs: string[] = [];
  for (const body of fencedBlocks(output, "acceptance-report")) {
    try {
      return { report: parseReportJson(body) };
    } catch (e) {
      errs.push(e instanceof Error ? e.message : String(e));
    }
  }
  // fallback: ACCEPTANCE_REPORT: marker
  const idx = output.search(/ACCEPTANCE_REPORT\s*:/i);
  if (idx !== -1) {
    const js = output.indexOf("{", idx);
    if (js !== -1) {
      const json = extractBalancedJson(output, js);
      if (json) {
        try {
          return { report: JSON.parse(json) as AcceptanceReport };
        } catch {
          /* drop */
        }
      }
    }
  }
  if (errs.length) return { error: `Failed to parse acceptance-report: ${errs.join("; ")}` };
  return {}; // no report ⇒ claimed
}

/** Remove fenced ```acceptance-report blocks so they don't propagate as noise into the next
 * step's $INPUT. Only called when a gate was active (resolvedAcceptance non-null), so a child in
 * a level:none step that spontaneously writes about the fence is left untouched. */
export function stripAcceptanceReport(output: string): string {
  const stripped = output.replace(/```acceptance-report\s*\n[\s\S]*?```\s*/gi, "");
  if (stripped === output) return output;
  return stripped.replace(/\n{3,}/g, "\n\n").trimEnd();
}

// --- structural checks ---

/** True if no staged files exist in `cwd` (untracked/modified-unstaged are fine). Non-repo ⇒ pass. */
function noStagedFilesOk(cwd: string): boolean {
  try {
    const r = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf-8" });
    if (r.status !== 0) return true;
    // git status --short XY format: staged iff col 0 is non-space and not '?'
    return !r.stdout.split("\n").some((l) => l.length > 0 && l[0] !== " " && l[0] !== "?");
  } catch {
    return true;
  }
}

// --- enum verify runner (SECURITY-CRITICAL) ---

function runVerify(cmd: VerifySpec, cwd: string, signal?: AbortSignal): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const argv = VERIFY_ARGV[cmd.kind];
    const timeoutMs = cmd.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    const started = Date.now();
    let settled = false;
    let out = "";
    const capture = (d: Buffer | string): void => {
      out += d.toString();
      if (out.length > 8192) out = out.slice(-4096); // bounded tail
    };
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: process.env, // parent env only — NO YAML env. Required for npm/tsc to function.
      shell: false, // fixed argv — never shell interpolation
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // SIGTERM → SIGKILL escalation: a child that traps/ignores SIGTERM (watch-mode test runner,
    // trapped signal) must not be orphaned indefinitely on the security-critical path.
    const escalate = (): void => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, 1000);
    };
    const finish = (status: VerifyResult["status"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ id: cmd.id, kind: cmd.kind, status, durationMs: Date.now() - started, output: out.slice(0, 1024) || undefined });
    };
    const timer = setTimeout(() => {
      escalate();
      finish("timed-out");
    }, timeoutMs);
    const onAbort = (): void => {
      escalate();
      finish("failed");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.on("error", () => finish("failed"));
    child.on("close", (code) => finish(code === 0 ? "passed" : "failed"));
  });
}

async function runVerifyAll(specs: VerifySpec[], cwd: string, signal?: AbortSignal): Promise<{ results: VerifyResult[]; allPassed: boolean }> {
  const results: VerifyResult[] = [];
  for (const s of specs) results.push(await runVerify(s, cwd, signal));
  const allPassed = results.every((r) => {
    if (r.status === "passed") return true;
    return specs.find((s) => s.id === r.id)?.allowFailure === true;
  });
  return { results, allPassed };
}

// --- the gate ---

/**
 * Evaluate a finished step against its acceptance config. Computes provenance
 * (claimed→attested→checked→verified, or `rejected` if the requested level isn't reached).
 * `failStep` is true ONLY for explicit (non-auto) levels whose gate failed — auto is badge-only.
 */
export async function evaluateAcceptance(
  a: ResolvedAcceptance,
  output: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<StepAcceptance> {
  const parsed = parseAcceptanceReport(output);
  const report = parsed.report;

  let achieved: Provenance = report ? "attested" : "claimed";

  // checked/verified: structural (no-staged-files) when evidence requires it
  if (a.level === "checked" || a.level === "verified") {
    const needStructural = a.evidence.includes("no-staged-files");
    const structuralOk = !needStructural || noStagedFilesOk(cwd);
    if (report && structuralOk) achieved = "checked";
  }

  // verified: run the enum verify commands
  let verifyResults: VerifyResult[] | undefined;
  if (a.level === "verified" && a.verify.length > 0) {
    const vr = await runVerifyAll(a.verify, cwd, signal);
    verifyResults = vr.results;
    if (achieved === "checked" && vr.allPassed) achieved = "verified";
  }

  const gatePassed = LEVEL_RANK[achieved] >= LEVEL_RANK[a.level];
  return {
    level: a.level,
    provenance: gatePassed ? achieved : "rejected",
    inferred: a.inferred,
    failStep: !gatePassed && !a.inferred,
    ...(verifyResults ? { verifyResults } : {}),
    ...(parsed.error ? { parseError: parsed.error } : {}),
  };
}

// Library module (imported by chain-runner.ts), not a standalone extension. The empty default
// factory satisfies pi's extension loader, which scans extensions/*.ts for a default export
// (same pattern as chain-runner.ts).
export default function (_pi: ExtensionAPI) {}
