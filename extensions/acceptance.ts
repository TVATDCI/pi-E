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
//
// ②a (PORT-PLAN-v0.40.md ②, 2026-08-04): added the REVIEW dimension — `review: { agent?, focus?,
// required }` config, `acceptanceRole`, the `review-required`/`reviewed` provenance states, risky-task
// auto-badge (Q2.1 suggest — NO spawn; the reviewer is orchestrated in ②b on an explicit
// `review.required`), slimmed parser canonicalization, and the `"reviewed"`-is-not-requestable rule.
// An unmet `review.required` resolves to a NON-TERMINAL `review-required` badge (Q2.2) — the chain
// continues. `acceptanceRole` in ②a influenced REVIEW inference only; ②b added level-override parity
// (read-only⇒attested, writer⇒checked via inferLevelFromRoleAndTask + a slimmed task-intent
// classifier) and enum synonym normalization in canonicalizeReport.
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AcceptanceLevel = "none" | "attested" | "checked" | "verified";
export type ResolvedLevel = Exclude<AcceptanceLevel, "none">;
export type Provenance =
  | "claimed"
  | "attested"
  | "checked"
  | "verified"
  | "review-required" // ② evidence passed but an independent review is still owed
  | "reviewed" // ② independent reviewer result present, no blockers
  | "rejected";
export type VerifyKind = "test" | "typecheck" | "lint" | "build";

/** ② Explicit read-only/writer role. ②b: the role OVERRIDES the inferred level (read-only⇒attested,
 *  writer⇒checked) via inferLevelFromRoleAndTask; it also biases REVIEW inference (read-only suppresses
 *  the risky-task suggestion). */
export type AcceptanceRole = "read-only" | "writer";

/** ② Independent-review gate, orthogonal to evidence. `required` activates the review dimension. */
export interface AcceptanceReview {
  agent?: string;
  focus?: string;
  required?: boolean;
}

/** ② Result of an independent reviewer run (supplied by the chain-runner orchestration in ②b;
 *  absent in ②a ⇒ an unmet `review.required` resolves to a non-terminal `review-required` badge). */
export interface ReviewerResult {
  blockers: string[];
  summary?: string;
}

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
  review?: AcceptanceReview; // ②
  acceptanceRole?: AcceptanceRole; // ②
  reason?: string;
}

export interface ResolvedAcceptance {
  level: ResolvedLevel;
  criteria: { id: string; must: string }[];
  evidence: string[];
  verify: VerifySpec[];
  review?: AcceptanceReview; // ② explicit OR risky-task-inferred
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
  review?: AcceptanceReview; // ② surfaces the review gate on the widget/dispatch-log
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
const LEVEL_RANK: Record<Provenance, number> = {
  claimed: 0,
  attested: 1,
  checked: 2,
  verified: 3,
  // ② SAFETY: review-required/reviewed are computed POST-rank in evaluateAcceptance (the review block
  // runs AFTER gatePassed). These ranks exist ONLY to satisfy Record<Provenance,number> — they are
  // NEVER operands in the gatePassed comparison (left side is always claimed/attested/checked/verified;
  // right side is a ResolvedLevel). Do NOT add a comparison that uses them.
  "review-required": 4,
  reviewed: 5,
  rejected: -1,
};
// ② review-gate validation + risky-task auto-suggest (ported slimmed from upstream inferLevel).
const ACCEPTANCE_REVIEW_KEYS = new Set<string>(["agent", "focus", "required"]);
const RISKY_RE = /\b(?:release|migration|migrate|security|data[- ]loss|destructive|post-review|fix pass)\b/i;

/**
 * Infer the default level from an agent's declared tools. `edit`/`write` present ⇒ writer ⇒
 * `checked` (there are changed files to structurally verify); otherwise `attested` (recon /
 * reasoning / review / drafting — output is text, nothing to structurally check).
 */
export function inferDefaultLevel(tools: string | undefined): ResolvedLevel {
  const t = (tools ?? "").toLowerCase();
  return t.includes("edit") || t.includes("write") ? "checked" : "attested";
}

/**
 * ② Infer an independent-review requirement from the TASK text. A write-capable task whose wording
 * matches risky-context keywords (release/migration/security/data-loss/destructive/post-review/fix
 * pass) ⇒ `review: { required: true, agent: "reviewer" }`. This is the Q2.1 "suggest" — it produces a
 * `review-required` BADGE; the reviewer is orchestrated ONLY on an explicit `review.required` (②b).
 * Ported (slimmed) from pi-subagents inferLevel's risky branch.
 */
export function inferReview(task: string, isWriter: boolean): AcceptanceReview | undefined {
  if (!isWriter) return undefined;
  return RISKY_RE.test(task) ? { required: true, agent: "reviewer" } : undefined;
}

// --- ②b task-intent classifier (slimmed port of pi-subagents/src/runs/shared/task-intent.ts).
// TASK-ONLY (no agent param): uses the general implementation grammar. The known successor that needs
// agent-specialized grammars (worker/reviewer) is the prompt to extract this into its own file. ---

export type TaskIntent = { kind: "implementation" } | { kind: "read-only" } | { kind: "unknown" };

const REVIEW_ONLY_PATTERNS = [
  /\breview only\b/i,
  /\bsuggest fixes only\b/i,
  /\bonly return findings\b/i,
  /\breturn findings only\b/i,
];

const NO_TOOL_INTENT_PATTERNS = [
  /\bno tools? needed\b/i,
  /\bno tools? required\b/i,
  /\bwithout using tools\b/i,
  /\bdo not use tools\b/i,
  /\bdon't use tools\b/i,
];

// Prohibition object ends at punctuation or a coordinator (but/and/then) so a follow-on like
// "but implement the fix" survives for write-intent testing instead of being swallowed.
const NO_EDIT_PROHIBITION_PATTERN = /\b(?:do not|don't|must not)\s+(?:edit|modify|write(?:\s+to)?|touch|change)\b((?:(?!\b(?:but|and|then)\b)[^.;,:!?\n\u2013\u2014-])*)/gi;

// Objects of a no-edit prohibition meaning "the codebase in general" — a blanket prohibition wins.
const GENERIC_PROHIBITION_OBJECT = /^\s*(?:(?:any|all|the|these|those|your|our|existing|project|product|source|sources|config|configs|repo|repository)[\s/,-]*)*(?:files?|code|codebase|sources?|anything|repo(?:sitory)?)?\s*$/i;

const SCOPED_NO_EDIT_CONSTRAINT_PATTERNS = [
  /\bdo not edit files?\s+outside\b/i,
  /\bdo not edit\s+outside\b/i,
  /\bdo not edit\s+unrelated files?\b/i,
  /\bdo not change\s+unrelated files?\b/i,
  /\bdo not modify\s+unrelated files?\b/i,
];

const READ_ONLY_DELIVERABLE_PATTERNS = [
  /\b(?:draft|write|compose|prepare|produce)\s+(?:(?:a|an|the)\s+)?(?:github\s+)?(?:issue|bug report|issue draft|issue body|proposal|plan|report|summary|findings?|analysis|recommendations?)\b/i,
  /\b(?:issue|bug report)\s+(?:draft|body|template)\b/i,
  /\b(?:return|provide|produce)\s+(?:text|markdown|answer|findings?|recommendations?)\s+only\b/i,
];

const FIX_OR_PATCH_IMPLEMENTATION_PATTERN = /\b(?:fix|patch)\s+(?:(?:it|this|that|them|each|any|all|these|those)\b|(?:(?:a|an|the|any|all)\s+)?(?:(?:failing|failed|broken|flaky|red|cold|start|current|existing|reported|approved|known|regression|unit|integration|e2e|source|typescript|type-?script|ts|type-?check|compiler)\s+)*(?:bug|defect|issues?|problems?|failures?|regressions?|tests?|errors?|items?|typos?|code|source|implementation|component|function|module|class|method|logic|file|files|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command|lint(?:ing)?|build|ci|type-?check|type\s+checking)\b)/i;

const GENERAL_IMPLEMENTATION_PATTERNS = [
  /\b(?:implement|edit|modify|refactor)\b/i,
  FIX_OR_PATCH_IMPLEMENTATION_PATTERN,
  /\bapply\s+(?:the\s+)?(?:(?:suggested|proposed|recommended)\s+)?(?:changes?|fix(?:es)?|patch)\b/i,
  /\bmake\s+(?:the\s+)?changes\b/i,
  /\bdo those fixes\b/i,
  /\b(?:update|add|remove|replace|delete|create)\s+(?:the\s+)?(?:file|files|code|source|implementation|test|tests|component|function|module|class|method|logic|import|imports|readme|docs?|changelog|package\.json|config|manifest|extension|prompt|command)\b/i,
];

// Bare write verbs that make a task write-capable for acceptance level inference (broad vocabulary —
// only raises evidence gates, never blocks completion).
const MAY_MUTATE_VERB_PATTERN = /\b(?:fix|implement|update|write|edit|modify|migrate|delete|remove|refactor|commit)\b/i;

function stripFrameworkInstructions(task: string): string {
  return task
    .split("\n")
    .filter((line) => !/^\s*\[(?:Write to|Read from):/i.test(line))
    .filter((line) => !/^\s*(?:Create and maintain progress at:|Update progress at:|\*\*Output:\*\*|Write your findings to(?: exactly this path)?:|Return the complete artifact in your final response\.|The runtime will persist it to exactly this path:|Do not call contact_supervisor merely because no write-capable tool is available\.|This path is authoritative for this run\.|Ignore any other output filename or output path mentioned elsewhere)/i.test(line))
    .join("\n");
}

function stripPatterns(task: string, patterns: RegExp[]): string {
  let stripped = task;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    stripped = stripped.replace(new RegExp(pattern.source, flags), " ");
  }
  return stripped;
}

interface NoEditProhibitionAnalysis {
  present: boolean;
  blanket: boolean;
  strippedText: string;
}

function analyzeNoEditProhibitions(taskText: string): NoEditProhibitionAnalysis {
  let present = REVIEW_ONLY_PATTERNS.some((pattern) => pattern.test(taskText))
    || NO_TOOL_INTENT_PATTERNS.some((pattern) => pattern.test(taskText));
  let blanket = present;
  let strippedText = stripPatterns(taskText, [...REVIEW_ONLY_PATTERNS, ...NO_TOOL_INTENT_PATTERNS]);
  strippedText = strippedText.replace(
    new RegExp(NO_EDIT_PROHIBITION_PATTERN.source, NO_EDIT_PROHIBITION_PATTERN.flags),
    (_match, object: string) => {
      present = true;
      if (GENERIC_PROHIBITION_OBJECT.test(object)) blanket = true;
      return " ";
    },
  );
  return { present, blanket, strippedText };
}

function hasGeneralImplementationIntent(taskText: string): boolean {
  return GENERAL_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(taskText));
}

function taskHasReadOnlyDeliverable(taskText: string): boolean {
  return READ_ONLY_DELIVERABLE_PATTERNS.some((pattern) => pattern.test(taskText));
}

/**
 * ②b Classify a task's mutation intent from its wording (slimmed port of upstream
 * classifyTaskMutationIntent — TASK-ONLY, no agent param: uses the general implementation grammar).
 * - "implementation": the task looks like it requires file changes (write verbs / fix patterns).
 * - "read-only": explicit no-edit prohibition (blanket, or scoped with no surviving write intent) or
 *   a read-only deliverable phrase (draft/write a report/summary/findings).
 * - "unknown": neither signal. Consumed by inferLevelFromRoleAndTask. */
export function classifyTaskIntent(task: string): TaskIntent {
  const taskText = stripFrameworkInstructions(task);
  const taskTextWithoutScopedConstraints = stripPatterns(taskText, SCOPED_NO_EDIT_CONSTRAINT_PATTERNS);
  const prohibitions = analyzeNoEditProhibitions(taskTextWithoutScopedConstraints);
  if (prohibitions.present) {
    if (prohibitions.blanket) return { kind: "read-only" };
    return hasGeneralImplementationIntent(prohibitions.strippedText) ? { kind: "implementation" } : { kind: "read-only" };
  }
  if (hasGeneralImplementationIntent(taskText)) return { kind: "implementation" };
  return taskHasReadOnlyDeliverable(taskTextWithoutScopedConstraints) ? { kind: "read-only" } : { kind: "unknown" };
}

/**
 * ②b Whether the task could plausibly change files (slimmed port of upstream taskMayMutate). Blanket
 * prohibitions win; read-only-deliverable phrases ("write a summary report") don't count; any other
 * bare write verb does. Broad vocabulary — only raises evidence gates. Exported for parity/tests. */
export function taskMayMutate(task: string): boolean {
  const taskText = stripPatterns(stripFrameworkInstructions(task), SCOPED_NO_EDIT_CONSTRAINT_PATTERNS);
  const prohibitions = analyzeNoEditProhibitions(taskText);
  if (prohibitions.blanket) return false;
  return MAY_MUTATE_VERB_PATTERN.test(stripPatterns(prohibitions.strippedText, READ_ONLY_DELIVERABLE_PATTERNS));
}

/**
 * ②b Infer the effective acceptance LEVEL from an explicit role and/or the task wording. The role
 * OVERRIDES the tools-based level: read-only⇒attested (even with edit tools), writer⇒checked. Absent a
 * role, read-only task wording — an explicit no-edit/read-only intent, a read-only deliverable phrase,
 * or the keyword set (review/inspect/summarize/no-edits) on an otherwise-unknown task — ⇒ attested.
 * Returns undefined when neither signal is present, so resolveAcceptance falls back to
 * inferDefaultLevel(tools) and existing chains (no role, non-read-only task) are unchanged. */
export function inferLevelFromRoleAndTask(role: AcceptanceRole | undefined, task: string | undefined): ResolvedLevel | undefined {
  if (role === "read-only") return "attested";
  if (role === "writer") return "checked";
  if (task) {
    const intent = classifyTaskIntent(task);
    if (intent.kind === "read-only") return "attested";
    if (intent.kind === "unknown" && /\b(?:read[- ]only|review[- ]only|no edits|without edits|inspect|summari[sz]e)\b/i.test(task)) {
      return "attested";
    }
  }
  return undefined;
}

function defaultEvidence(level: ResolvedLevel): string[] {
  return level === "attested" ? [] : ["changed-files", "no-staged-files"];
}

/**
 * Resolve the effective acceptance config. `null` ⇒ gate disabled (level:none). `inferred:true`
 * ⇒ auto-inferred (or no config) ⇒ badge-only, never rejects the step. ② `task?` enables risky-task
 * review auto-suggest; explicit `input.review` always wins; `acceptanceRole: "read-only"` suppresses
 * the risky suggestion. ②b: under `auto`, the role and read-only task wording OVERRIDE the tools-based
 * `inferred` level (inferLevelFromRoleAndTask); absent both, `inferred` is used (existing chains
 * unchanged).
 */
export function resolveAcceptance(
  input: AcceptanceInput | undefined,
  inferred: ResolvedLevel,
  task?: string,
): ResolvedAcceptance | null {
  if (!input) {
    // No explicit config: still infer a risky-task review badge for write-capable agents (Q2.1).
    const review = inferReview(task ?? "", inferred === "checked");
    return {
      level: inferred,
      criteria: [],
      evidence: defaultEvidence(inferred),
      verify: [],
      ...(review ? { review } : {}),
      inferred: true,
    };
  }
  const rawLevel = input.level ?? "auto";
  if (rawLevel === "none") return null;
  // ②b role/task level-override: under auto, an explicit role or read-only task wording overrides the
  // tools-based inferred level (read-only⇒attested, writer⇒checked, read-only task⇒attested); absent
  // both signals, fall back to `inferred` so existing chains (no role, non-read-only task) are unchanged.
  const roleAwareInferred = inferLevelFromRoleAndTask(input.acceptanceRole, task) ?? inferred;
  const level: ResolvedLevel = rawLevel === "auto" ? roleAwareInferred : (rawLevel as ResolvedLevel);
  const isAuto = rawLevel === "auto" || input.level === undefined;
  // ② explicit review wins; otherwise infer from task text. "read-only" role ⇒ no risky suggestion.
  // isWriter uses the role-aware level so a read-only task on a write-capable agent suppresses review.
  const isWriter = input.acceptanceRole === "writer" || (input.acceptanceRole === undefined && roleAwareInferred === "checked");
  const review = input.review ?? (input.acceptanceRole === "read-only" ? undefined : inferReview(task ?? "", isWriter));
  return {
    level,
    criteria: input.criteria ?? [],
    evidence: input.evidence ?? defaultEvidence(level),
    verify: input.verify ?? [],
    ...(review ? { review } : {}),
    reason: input.reason,
    inferred: isAuto,
  };
}

/**
 * Coerce/validate raw YAML acceptance config (called from normalizeChainsFile so `acceptance:`
 * survives parsing instead of being silently stripped). Drops verify entries whose `kind` is not
 * in the enum, and never copies `command`/`env`/`cwd` (those keys are unsupported on purpose).
 * ② validates `review` keys (ACCEPTANCE_REVIEW_KEYS) and passes `acceptanceRole` through; an invalid
 * review sub-shape drops JUST the review (lenient), not the whole gate.
 */
export function coerceAcceptance(raw: unknown): AcceptanceInput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;

  let level: AcceptanceInput["level"] | undefined;
  if (typeof r.level === "string" && LEVELS.has(r.level)) level = r.level as AcceptanceInput["level"];
  else if (r.level === "reviewed") {
    // ② "reviewed" is an ACHIEVED status, not a requestable level (upstream EXPLICIT_REVIEWED_UNAVAILABLE).
    // Coerce to auto-inferred rather than dropping the whole gate.
    level = undefined;
  } else if (r.level !== undefined) return undefined; // invalid level ⇒ drop the whole gate

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

  // ② review gate: validate keys (ACCEPTANCE_REVIEW_KEYS); drop JUST the review on invalid shape.
  let review: AcceptanceReview | undefined;
  if (r.review !== undefined && r.review !== false && r.review && typeof r.review === "object" && !Array.isArray(r.review)) {
    const rv = r.review as Record<string, unknown>;
    if (!Object.keys(rv).some((k) => !ACCEPTANCE_REVIEW_KEYS.has(k))) {
      review = {
        ...(typeof rv.agent === "string" ? { agent: rv.agent } : {}),
        ...(typeof rv.focus === "string" ? { focus: rv.focus } : {}),
        ...(typeof rv.required === "boolean" ? { required: rv.required } : {}),
      };
      if (!Object.keys(review).length) review = undefined;
    }
  }

  // ② acceptanceRole pass-through.
  let acceptanceRole: AcceptanceRole | undefined;
  if (r.acceptanceRole === "read-only" || r.acceptanceRole === "writer") acceptanceRole = r.acceptanceRole;

  const out: AcceptanceInput = {};
  if (level !== undefined) out.level = level;
  if (criteria) out.criteria = criteria;
  if (evidence) out.evidence = evidence;
  if (verify) out.verify = verify;
  if (review) out.review = review;
  if (acceptanceRole) out.acceptanceRole = acceptanceRole;
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
  if (a.review?.required) {
    // ② tell the child an independent review is required so it scopes accordingly.
    lines.push(
      "",
      `Independent review REQUIRED${a.review.agent ? ` (agent: ${a.review.agent})` : ""}${a.review.focus ? `; focus: ${a.review.focus}` : ""}. Evidence alone is not sufficient — the parent requires an independent reviewer's sign-off before accepting this work.`,
    );
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

// --- ②b enum synonym normalization (additive report canonicalization) ---

/** Canonical criterion-status enum. Synonyms a child emits map here. */
const CRITERION_STATUS_CANON: Record<string, "satisfied" | "not-satisfied" | "not-applicable"> = {
  satisfied: "satisfied", met: "satisfied", complete: "satisfied", completed: "satisfied", done: "satisfied",
  pass: "satisfied", passed: "satisfied", success: "satisfied", succeeded: "satisfied",
  "not-satisfied": "not-satisfied", "not-met": "not-satisfied", unmet: "not-satisfied",
  incomplete: "not-satisfied", fail: "not-satisfied", failed: "not-satisfied",
  "not-applicable": "not-applicable", "n-a": "not-applicable", na: "not-applicable",
  skip: "not-applicable", skipped: "not-applicable",
};

/** Canonical command-result enum. Synonyms a child emits map here. */
const COMMAND_RESULT_CANON: Record<string, "passed" | "failed" | "not-run"> = {
  passed: "passed", pass: "passed", success: "passed", successful: "passed", succeeded: "passed", ok: "passed",
  failed: "failed", fail: "failed", failure: "failed", error: "failed",
  "not-run": "not-run", "not-executed": "not-run", skip: "not-run", skipped: "not-run",
};

/** ②b Normalize a criterion `.status` to the canonical enum; non-strings/unknown values pass through. */
export function normalizeCriterionStatus(status: unknown): unknown {
  if (typeof status !== "string") return status;
  return CRITERION_STATUS_CANON[status.toLowerCase().trim()] ?? status;
}

/** ②b Normalize a command `.result` to the canonical enum; non-strings/unknown values pass through. */
export function normalizeCommandResult(result: unknown): unknown {
  if (typeof result !== "string") return result;
  return COMMAND_RESULT_CANON[result.toLowerCase().trim()] ?? result;
}

/** Map .status over each criteriaSatisfied item (non-object items pass through unchanged). */
function normalizeCriterionItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const obj = item as Record<string, unknown>;
  return { ...obj, status: normalizeCriterionStatus(obj.status) };
}

/** Map .result over each commandsRun item (non-object items pass through unchanged). */
function normalizeCommandItem(item: unknown): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const obj = item as Record<string, unknown>;
  return { ...obj, result: normalizeCommandResult(obj.result) };
}

/**
 * ② Canonicalize a parsed report for robustness (slimmed port of upstream's canonicalization):
 * snake_case keys → camelCase, string booleans → boolean, bare scalars → single-item arrays.
 * ②b enum synonym normalization: criteriaSatisfied[].status → {satisfied,not-satisfied,not-applicable};
 * commandsRun[].result → {passed,failed,not-run} (synonym maps). Purely ADDITIVE — accepts MORE
 * shapes; a well-formed report canonicalizes to itself. */
function canonicalizeReport(raw: unknown): AcceptanceReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {} as AcceptanceReport;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const camel = (k: string): string => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const asArray = (v: unknown): unknown[] | undefined =>
    Array.isArray(v) ? v : typeof v === "string" || typeof v === "number" ? [v] : undefined;
  const asBool = (v: unknown): unknown => (v === "true" ? true : v === "false" ? false : v);
  const ARRAY_FIELDS = new Set([
    "changedFiles",
    "testsAddedOrUpdated",
    "commandsRun", // M2: template shows arrays; a scalar child emission gets wrapped
    "validationOutput",
    "residualRisks",
    "reviewFindings",
    "criteriaSatisfied", // M2
  ]);
  for (const [k, v] of Object.entries(src)) {
    const key = camel(k);
    if (key === "noStagedFiles") {
      out[key] = asBool(v);
    } else if (key === "criteriaSatisfied") {
      const arr = asArray(v);
      out[key] = arr ? arr.map(normalizeCriterionItem) : v;
    } else if (key === "commandsRun") {
      const arr = asArray(v);
      out[key] = arr ? arr.map(normalizeCommandItem) : v;
    } else if (ARRAY_FIELDS.has(key)) {
      out[key] = asArray(v) ?? v;
    } else {
      out[key] = v;
    }
  }
  return out as AcceptanceReport;
}

function parseReportJson(body: string): AcceptanceReport {
  const trimmed = body.trim();
  const parse = (s: string): AcceptanceReport => canonicalizeReport(JSON.parse(s));
  try {
    return parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    if (start >= 0) {
      const json = extractBalancedJson(trimmed, start);
      if (json) return parse(json);
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
          return { report: canonicalizeReport(JSON.parse(json)) }; // ② canonicalize the fallback path too
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
 *
 * ② REVIEW dimension (orthogonal to evidence): activates only on `review.required`. With no
 * `reviewerResult` (the ②a case — ②b orchestrates the reviewer), an unmet required review resolves
 * to a NON-TERMINAL `review-required` badge (Q2.2); the chain continues. A supplied reviewer result
 * with no blockers ⇒ `reviewed`; with blockers ⇒ `rejected` (and fails an explicit/non-auto step). */
export async function evaluateAcceptance(
  a: ResolvedAcceptance,
  output: string,
  cwd: string,
  signal?: AbortSignal,
  reviewerResult?: ReviewerResult,
  cachedVerifyResults?: VerifyResult[], // F3 (②b): reuse prior verify results on re-eval (reviewer orchestration) so verify commands don't run twice
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

  // verified: run the enum verify commands (or reuse cached results on re-eval — F3, no double-verify)
  let verifyResults: VerifyResult[] | undefined;
  if (a.level === "verified" && a.verify.length > 0) {
    if (cachedVerifyResults) {
      verifyResults = cachedVerifyResults;
      const allPassed = cachedVerifyResults.every((r) => r.status === "passed" || a.verify.find((s) => s.id === r.id)?.allowFailure === true);
      if (achieved === "checked" && allPassed) achieved = "verified";
    } else {
      const vr = await runVerifyAll(a.verify, cwd, signal);
      verifyResults = vr.results;
      if (achieved === "checked" && vr.allPassed) achieved = "verified";
    }
  }

  const gatePassed = LEVEL_RANK[achieved] >= LEVEL_RANK[a.level];
  let provenance: Provenance = gatePassed ? achieved : "rejected";
  let failStep = !gatePassed && !a.inferred;

  // ② review dimension. Evidence must pass first; then review gates the terminal provenance.
  if (a.review?.required && provenance !== "rejected") {
    if (reviewerResult) {
      if (reviewerResult.blockers.length > 0) {
        provenance = "rejected";
        failStep = !a.inferred; // explicit review that found blockers ⇒ fail; auto-inferred stays advisory
      } else {
        provenance = "reviewed";
      }
    } else {
      provenance = "review-required"; // non-terminal badge (Q2.2)
    }
  }

  return {
    level: a.level,
    provenance,
    inferred: a.inferred,
    failStep,
    ...(a.review ? { review: a.review } : {}),
    ...(verifyResults ? { verifyResults } : {}),
    ...(parsed.error ? { parseError: parsed.error } : {}),
  };
}

// Library module (imported by chain-runner.ts), not a standalone extension. The empty default
// factory satisfies pi's extension loader, which scans extensions/*.ts for a default export
// (same pattern as chain-runner.ts).
export default function (_pi: ExtensionAPI) {}
