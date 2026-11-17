// mini-damage-control — HARDENED (Decision 0002: fail-closed B + global fallback A + bootstrap D)
// Changes from Lesson 0003 original: null=deny-bash (not empty=allow-all); global+project merge; deny-additive.
// 0.80.3 re-verify fix (LR-0017 pending → verified): ctx.ui.confirm does NOT render during
// tool_call preflight on 0.80.3 (silent abort). Switched ASK branch to ctx.ui.select (matches
// canonical permission-gate.ts) + try/catch notify so failures surface instead of silently aborting.
//
// GATE v1.2 LEG 1 (2026-11-17 — approved plan, Oracle-reviewed; design law = v1.1-design.md):
//   WP0  repo-slug resolver (pool base mapping; non-pool = full git-root path hash, never a bare
//        basename) + decision-trail store interface (append-only, lock-serialized, R5 schema) under
//        ~/.pi/agent/mini-dc/<repo-slug>/ — runtime state OUTSIDE any working tree (F1/F2).
//   WP1  authoritative read-only classifier: allowlist of read-only command forms; unknown /
//        composed / redirected / substituted / wrapped commands fail closed to G; npm test = G
//        explicitly; D-form detection (push/merge/publish/credentials); rules may pin class: D.
//   WP2  decision-context header WHAT/WHERE/WHO/PURPOSE(asker)/RISK/PRIOR. Degradation law: ONLY
//        the PURPOSE line may vanish on relaunch/stale mapping; an unknown or stale task binding
//        DISABLES task-dependent features (task-keyed answering, PRIOR-by-task) rather than
//        guessing; WHO shows the pane-seat honestly; PRIOR = same task only, actor+age composed,
//        absent/corrupt trail = absent line.
//   WP3  dialog v2: seat-bound option rows (session/grant rows render only when the answering
//        seat is captain or firstmate-relay — never on a crewmate-drivable pane, C5), label-bound
//        hotkeys (never positions), expandable detail, deny-with-message composer with
//        deterministic lifecycle: countdown pauses in the composer, resumes at REMAINING time
//        (never reset), nested-Esc, repeated open/close, dispose, exactly-once outcomes.
//   WP4  grants store + protection: agent-home layout, /dc-grants list+revoke, pattern matching,
//        R-only class filter (never D), creator-seat derived ONLY from trusted invocation paths;
//        the store directory joins the protected/zero-access tiers — worker tool/file/shell
//        attempts on the store are denied (all three attack shapes).
//   WP5  authorization matrix + worker-G parking: class × asker-seat × answering-seat; D rejects
//        firstmate answers always; only enumerated steering-class G and class R proceed for
//        firstmate; non-enumerated G in worker panes parks with a supervisor-readable
//        keyed-blocked state; timeout parking emitted in abort AND continue modes; timeout stays
//        distinct from deny.
//   WP6  session scopes keyed to explicit PI_SESSION_ID (die on session replacement; never
//        guessed); R eligible in captain panes too, not worker-only.
//   Preserved contracts: deny-additive rules, path tiers, /dc-mode, y/n/Esc keys, 180s countdown,
//   headless ASK→deny no-abort, the custom overlay renderer family (0.80.3 lesson). No `as any`.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Local identity of pi 0.86.1 `isToolCallEventType` (`return event.toolName === toolName`; re-verified against the 0.86.1 binary).
// Kept in-tree so unit tests can import this module — `@earendil-works/pi-coding-agent`
// is injected at extension-load time and is not a worktree dependency.
function isToolCallEventType(toolName: string, event: { toolName: string }): boolean {
  return event.toolName === toolName;
}
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { minimatch } from "minimatch";
import { readFileSync, existsSync, appendFileSync, mkdirSync, rmSync, writeFileSync, realpathSync, readdirSync } from "node:fs";
import { join, relative, isAbsolute, sep, dirname, resolve as pathResolve } from "node:path";
import * as os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

// ═════════════════════════════════════════════════════════════════════════════
// Gate v1.2 shared types (WP0/WP4/WP5)
// ═════════════════════════════════════════════════════════════════════════════

/** Gate decision classes (v1.1 amended law). D = destructive/push/merge/publish/credentials;
 *  R = read-only mid-task (STRICTLY the read-only allowlist — a write-capable command never
 *  routes here); G = general gated fail-closed ask. */
export type DecisionClass = "D" | "R" | "G";

/** Pane seat, derived ONLY from trusted invocation paths (the process environment as
 *  provisioned at pane birth). captain = operator pane; firstmate = supervisor surface
 *  (leg 2); worker = firstmate crewmate pane. */
export type Seat = "captain" | "firstmate" | "worker";

/** One serialized gate decision (R5 schema: timestamp, actor-seat, asker pane+task, subject
 *  digest, class, decision, scope, message). Append-only JSONL, lock-serialized [C8]. */
export interface TrailEntry {
  v: 1;
  ts: string; // ISO timestamp
  actor: Seat | "gate"; // gate = timeout/auto outcomes [C8]
  pane: string | null; // asker pane (herdr pane id or "session:<id>" fallback)
  task: string | null; // asker task binding; null when unbound/stale — never guessed
  subject: string; // sha16 digest of the gated subject (the bash command)
  cls: DecisionClass;
  decision: "proceed" | "deny" | "park";
  scope: "once" | "session" | "grant" | "none";
  message?: string; // deny-with-message text
}

/** A stored grant (Q3: separate file, captain-only via dialog, firstmate R-class via the
 *  answer surface, workers never; never-D is structural — the filter type admits only R). */
export interface Grant {
  id: string;
  "created-at": string;
  "creator-seat": Seat;
  pattern: string; // exact pattern, gate-derived from the command (never asker text)
  "class-filter": "R";
}

interface Rule {
  pattern: string;
  reason: string;
  ask?: boolean;
  /** Additive v1.2 field: a rule may PIN class D (destructive/credential rules). Class R is
   *  NEVER rule-pinnable — R is defined strictly by the read-only engine (v1.1 C1). */
  class?: "D";
}
interface Rules {
  bashToolPatterns: Rule[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
}

const GLOBAL_RULES_PATH = join(
  os.homedir(),
  ".pi",
  "agent",
  "mini-dc-rules.yaml",
);

// AF1 round (2026-11-17): test seam — the harness points the RULES-LOADING global path at a
// scratch fixture so no test outcome depends on the desk's real global rules file (same
// discipline as setStoreRootForTesting). Only the session_start load consults this override;
// the Tier-0 store/rules PROTECTION forms keep the production constant, so the N1/V10 pin
// (literal production path denied) holds regardless of what the harness loads.
let globalRulesPathOverride: string | null = null;
export function setGlobalRulesPathForTesting(path: string | null): void {
  globalRulesPathOverride = path;
}

function loadRulesLayer(filepath: string): Rules | null {
  if (!existsSync(filepath)) return null;
  try {
    const raw = yamlParse(
      readFileSync(filepath, "utf8"),
    ) as Partial<Rules> | null;
    if (!raw) return null;
    const patterns: Rule[] = (raw.bashToolPatterns ?? []).map((r) => ({
      pattern: r.pattern,
      reason: r.reason,
      ...(r.ask ? { ask: true } : {}),
      ...((r as { class?: string }).class === "D" ? { class: "D" as const } : {}),
    }));
    return {
      bashToolPatterns: patterns,
      zeroAccessPaths: raw.zeroAccessPaths ?? [],
      readOnlyPaths: raw.readOnlyPaths ?? [],
    };
  } catch {
    return null; // parse error → treat as absent (fail-closed for that layer)
  }
}

function mergeRules(global: Rules | null, project: Rules | null): Rules | null {
  if (!global && !project) return null; // neither found → fail-closed
  const g = global ?? { bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [] };
  const p = project ?? { bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [] };
  // Deny-additive: concatenate. Project can ADD deny rules but cannot REMOVE global ones.
  // Project can downgrade block→ask via ask:true on a matching pattern, but cannot allow a global deny.
  return {
    bashToolPatterns: [...g.bashToolPatterns, ...p.bashToolPatterns],
    zeroAccessPaths: [...g.zeroAccessPaths, ...p.zeroAccessPaths],
    readOnlyPaths: [...g.readOnlyPaths, ...p.readOnlyPaths],
  };
}

// ── Glob matcher for path rules (zeroAccess, readOnly, noDelete) ────────────
// Uses minimatch (verified available in the Pi extension runtime). Supports
// * / ? / ** / ~ expansion, with dotfiles enabled so .env/.ssh match.
function expandTilde(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(os.homedir(), path.slice(1));
  }
  return path;
}

function pathMatchesGlob(path: string, pattern: string): boolean {
  const expandedPattern = expandTilde(pattern);
  return minimatch(path, expandedPattern, { dot: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// WP0 — injectable store root + env source (runtime state lives OUTSIDE the repo)
// ═════════════════════════════════════════════════════════════════════════════
// Production default: ~/.pi/agent/mini-dc/<repo-slug>/ (agent home — survives pooled-worktree
// teardown, desk-local, never in a shared tree [F1/F2]). Tests point the root at a scratch dir;
// the override is a module seam (not env-readable in production), so a worker cannot redirect
// the store to a directory it controls.

let storeRootOverride: string | null = null;
export function setStoreRootForTesting(dir: string | null): void {
  storeRootOverride = dir;
}
function storeRoot(): string {
  return storeRootOverride ?? join(os.homedir(), ".pi", "agent", "mini-dc");
}
function storeDirFor(slug: string): string {
  return join(storeRoot(), slug);
}

// Seat/task derivation reads the environment through this seam so units stay hermetic without
// mutating process.env. Production identity source: the env provisioned at pane birth.
let envSourceOverride: Record<string, string | undefined> | null = null;
export function setEnvSourceForTesting(
  env: Record<string, string | undefined> | null,
): void {
  envSourceOverride = env;
}
function envSource(): Record<string, string | undefined> {
  return envSourceOverride ?? (process.env as Record<string, string | undefined>);
}

// ── WP0: repo-slug resolution ────────────────────────────────────────────────
// Pool paths resolve via the pool base (~/.treehouse): the first segment under the pool base is
// the pool project dir `<repo>-<instance-id>`; the instance id (hex suffix) is stripped so the
// slug survives slot teardown/reprovision and is shared by every worktree of that repo (F1).
// Non-pool repos use a COLLISION-PROOF identity — the full git-root path hash — never a bare
// basename (same-basename/different-repo pins different slugs).
export function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function defaultPoolBase(): string {
  return join(os.homedir(), ".treehouse");
}

export function resolveRepoSlug(
  gitRoot: string,
  opts?: { poolBase?: string },
): string {
  const root = gitRoot.endsWith("/") && gitRoot !== "/" ? gitRoot.slice(0, -1) : gitRoot;
  const poolBase = opts?.poolBase ?? defaultPoolBase();
  const rel = relative(poolBase, root);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) {
    const seg1 = rel.split(sep)[0] ?? rel;
    const stripped = seg1.replace(/-[0-9a-f]{5,}$/i, "");
    return stripped || seg1;
  }
  return `r-${sha16(root)}`;
}

// ── WP0: decision trail — append-only, lock-serialized JSONL [C8] ────────────
function trailPathFor(slug: string): string {
  return join(storeDirFor(slug), "trail.jsonl");
}
function grantsFileFor(slug: string): string {
  return join(storeDirFor(slug), "grants.yaml");
}

function sleepSync(ms: number): void {
  // Synchronous sleep (Node allows Atomics.wait on the main thread) for lock retry.
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

const LOCK_TIMEOUT_MS = 5000;
/** Multiprocess-safe serialization: exclusive mkdir-lock with stale-lock break at the deadline. */
function withDirLock<T>(dir: string, name: string, fn: () => T): T {
  const lockPath = join(dir, `${name}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      if (Date.now() > deadline) {
        // Stale lock (crashed holder) — break it and race again.
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          /* another waiter broke it first */
        }
        continue;
      }
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      /* best-effort release */
    }
  }
}

/** Append one trail entry. Best-effort evidence [C8]: failures never block the gate. */
export function appendTrail(slug: string, entry: TrailEntry): boolean {
  try {
    const dir = storeDirFor(slug);
    mkdirSync(dir, { recursive: true });
    return withDirLock(dir, "trail", () => {
      appendFileSync(trailPathFor(slug), `${JSON.stringify(entry)}\n`, "utf8");
      return true;
    });
  } catch {
    return false;
  }
}

/** Read the trail. Returns null on corruption — PRIOR composes as ABSENT (degradation law:
 *  absent/corrupt trail = absent line), never a guessed partial history. */
export function readTrail(slug: string): TrailEntry[] | null {
  try {
    const raw = readFileSync(trailPathFor(slug), "utf8");
    const out: TrailEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line) as TrailEntry);
    }
    return out;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return [];
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WP1 — authoritative read-only command engine (+ D-form detection)
// ═════════════════════════════════════════════════════════════════════════════
// Pure function. ALLOWLIST of read-only command forms; anything unknown, composed (;|&), 
// redirected (>/<), substituted ($(``)), or wrapped (sudo/sh/node/awk/…) fails closed to G.
// `npm test` (workspace-write) routes G, explicitly (v1.1 C1). Write-capable commands NEVER
// route R (unit-pinned).

const COMPOSITION_CHARS = /[;|&<>`$\n]/;

const D_FORMS: RegExp[] = [
  /\bgit\s+push\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgh\s+pr\s+merge\b/,
  /\bgh\s+release\s+(create|upload|delete)\b/,
  /\bgh\s+repo\s+delete\b/,
  /\b(npm|yarn|pnpm|bun|cargo)\s+publish\b/,
  /\bdocker\s+push\b/,
  /\bhelm\s+push\b/,
  /\b(scp|rsync)\s+\S/,
  /\bssh-add\b/,
  /\bgh\s+auth\s+(token|refresh)\b/,
  /\bgit\s+credential\b/,
];

// Interpreter/wrapper binaries — anything they invoke is out of the engine's sight → G.
// (`find` is NOT here: it is allowlisted with its own mutation-flag forbid-walk. `dd` and
// other writers are simply absent from every read set → G.)
const WRAPPER_BINS = new Set([
  "sudo", "doas", "nohup", "timeout", "watch", "xargs", "env", "stdbuf", "strace",
  "ltrace", "script", "sh", "bash", "dash", "zsh", "fish", "node", "deno", "bun",
  "python", "python3", "perl", "ruby", "php", "awk", "gawk", "mawk", "sed", "tee",
  "eval", "exec", "time", "nice", "ionice", "flock", "parallel", "make", "npx",
  "bunx", "pip", "pip3", "uv", "tar",
]);

const SIMPLE_READ_BINS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "which",
  "whereis", "whoami", "id", "hostname", "uname", "date", "echo", "realpath",
  "readlink", "basename", "dirname", "sha256sum", "md5sum", "diff", "cmp", "sort",
  "uniq", "cut", "comm", "jq", "tree", "column", "fold", "nl", "tac", "bc", "less",
  "more", "gitdir",
]);

const GREP_BINS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack"]);

const GH_READ_SUBS: Record<string, Set<string>> = {
  pr: new Set(["view", "list", "checks", "diff", "status"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["list", "view"]),
  release: new Set(["list", "view"]),
  repo: new Set(["view"]),
  gist: new Set(["list", "view"]),
  label: new Set(["list"]),
};

const BD_READ_SUBS = new Set([
  "list", "show", "search", "memories", "stats", "ready", "blocked", "dep",
  "doctor", "stale", "orphans", "lint", "preflight", "prime",
]);

const NPM_READ_SUBS = new Set(["view", "ls", "outdated", "explain", "search"]);

/** All tokens must be allowlisted flags (values consumed); ANY bare positional → not verified
 *  read-only (e.g. `git branch <name>` creates). Flag values are consumed unchecked. */
function allTokensAllowed(
  tokens: string[],
  flags: Set<string>,
  valueFlags: Set<string>,
): boolean {
  let expectValue = false;
  for (const t of tokens) {
    if (expectValue) {
      expectValue = false;
      continue;
    }
    if (t === "--") return false; // separator → unverified positionals follow
    if (t.startsWith("-")) {
      if (!flags.has(t)) return false;
      if (valueFlags.has(t)) expectValue = true;
    } else {
      return false;
    }
  }
  return true;
}

function gitArgsOk(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  if (tokens[0].startsWith("-")) return tokens[0] === "--version" || tokens[0] === "-v";
  const sub = tokens[0];
  const rest = tokens.slice(1);
  // Always-read subcommands (any args — reads only; redirects were already rejected).
  // reflog and fsck are NOT here (F3): both carry write-capable forms (expire/delete;
  // --lost-found writes .git/lost-found) — see the guarded cases below.
  const always = new Set([
    "status", "log", "show", "diff", "rev-parse", "describe", "ls-files",
    "ls-remote", "cat-file", "grep", "blame", "shortlog",
    "count-objects", "merge-base", "diff-tree", "version", "var",
  ]);
  if (always.has(sub)) return true;
  switch (sub) {
    case "reflog":
      // F3: bare reflog / reflog show / reflog list are reads; expire|delete|write|exists
      // mutate or probe the recovery data and route G.
      return rest.length === 0 || rest[0] === "show" || rest[0] === "list";
    case "fsck":
      // F3: --lost-found writes .git/lost-found/* — everything else reads.
      return !rest.some((t) => t === "--lost-found");
    case "symbolic-ref":
      return rest.length <= 1; // read HEAD; the two-arg form WRITES a ref
    case "branch": {
      const flags = new Set([
        "-a", "-r", "-v", "-vv", "-q", "--list", "--show-current", "--show-commit",
        "--sort", "--format", "--contains", "--merged", "--no-merged", "--points-at",
        "--all", "--remotes", "--no-column", "--column", "-i", "--ignore-case",
        "--color", "--no-color", "--no-abbrev", "--track", "--no-track",
      ]);
      const valueFlags = new Set([
        "--sort", "--format", "--contains", "--merged", "--no-merged",
        "--points-at", "--column", "--color",
      ]);
      return allTokensAllowed(rest, flags, valueFlags);
    }
    case "tag": {
      const flags = new Set([
        "-l", "--list", "-n", "--contains", "--merged", "--no-merged", "--points-at",
        "--sort", "--format", "-i", "--ignore-case", "--color", "--no-color",
        "--merged", "--no-merged", "-v", "--verify",
      ]);
      const valueFlags = new Set([
        "--contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--color", "-n",
      ]);
      return allTokensAllowed(rest, flags, valueFlags);
    }
    case "remote":
      return (
        rest.length === 0 ||
        rest.every((t) => t === "-v" || t === "--verbose") ||
        (rest[0] === "get-url" && rest.length === 2)
      );
    case "config": {
      const verb = rest[0] ?? "";
      if (!["--get", "--get-all", "--get-regexp", "--list"].includes(verb)) return false;
      const forbid = new Set([
        "--add", "--set", "--unset", "--unset-all", "--replace-all",
        "--rename-section", "--remove-section", "-e", "--edit",
      ]);
      return !rest.some((t) => forbid.has(t));
    }
    case "stash":
      return (
        rest.length >= 1 &&
        (rest[0] === "list" || rest[0] === "show") &&
        rest.slice(1).every((t) => t.startsWith("-"))
      );
    case "worktree":
      return rest.length === 0 || (rest[0] === "list" && rest.slice(1).every((t) => t.startsWith("-")));
    default:
      return false;
  }
}

function ghArgsOk(tokens: string[]): boolean {
  if (tokens.length < 2) return false;
  const subs = GH_READ_SUBS[tokens[0]];
  return subs ? subs.has(tokens[1]) : false;
}

function findArgsOk(tokens: string[]): boolean {
  return !tokens.some(
    (t) =>
      t === "-delete" ||
      t === "-exec" ||
      t === "-execdir" ||
      t === "-ok" ||
      t === "-okdir" ||
      t === "-fls" || // F3: -fls writes/truncates the named file
      t.startsWith("-fprint"),
  );
}

/** The strict read-only allowlist. Exported for tests and the steering enumeration. */
export function isReadOnlyAllowlisted(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (COMPOSITION_CHARS.test(trimmed)) return false; // composed / redirected / substituted
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) return false; // env-assignment prefix (wrapped)
  const tokens = trimmed.split(/\s+/);
  const bin = tokens[0];
  if (WRAPPER_BINS.has(bin)) return false;
  if (bin === "git") return gitArgsOk(tokens.slice(1));
  if (bin === "gh") return ghArgsOk(tokens.slice(1));
  if (bin === "bd") return tokens.length >= 2 && BD_READ_SUBS.has(tokens[1]);
  if (bin === "npm") return tokens.length >= 2 && NPM_READ_SUBS.has(tokens[1]);
  if (bin === "find") return findArgsOk(tokens.slice(1));
  if (GREP_BINS.has(bin) || SIMPLE_READ_BINS.has(bin)) return true;
  return false; // unknown → fail closed to G
}

// F2 (2026-11-17 review): argv-order/quoting D detection — bash parsing makes `git -C d push`,
// `git 'push'`, `git pu\sh`, and `gh pr -R o/r merge` all execute push/merge regardless of
// word adjacency. Token-level pass: quote/backslash-normalize, then route D on the destructive
// token appearing anywhere after a git/gh head. Exact-token equality (not substring) keeps
// benign args (--grep=merge, paths like grep-merge.txt) out of the net.
function normalizeShellToken(t: string): string {
  return t.replace(/['"]/g, "").replace(/\\(.)/g, "$1").toLowerCase();
}

function tokenBasedDForm(command: string): string | null {
  const raw = command.trim();
  if (!raw || /\n/.test(raw)) return null;
  const rawTokens = raw.split(/\s+/).filter(Boolean);
  const tokens = rawTokens.map(normalizeShellToken).filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens[0];
  const rest = tokens.slice(1);
  if (head === "git") {
    // O1 fold (recheck): env-assembled destructive tokens ("git pu\"$X\"sh") — also try the
    // $VAR-segment-removed variant, de-env'd on the RAW token BEFORE quote-stripping (quote
    // boundaries end var names: stripping quotes first would merge pu"$X"sh into pu$xsh).
    // Whole-token vars with unknowable values (git $ACTION) stay a documented residual:
    // removal cannot synthesize a token that isn't there.
    const restDeEnv = rawTokens
      .slice(1)
      .map((t) => t.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, ""))
      .map(normalizeShellToken)
      .filter(Boolean);
    const variants = [rest, restDeEnv];
    if (variants.some((toks) => toks.some((t) => t === "push" || t === "merge" || t === "rebase"))) {
      return "destructive git form (push/merge/rebase token, quote/order-normalized)";
    }
    if (variants.some((toks) => toks.includes("reset") && toks.includes("--hard"))) {
      return "destructive git form (reset --hard, quote/order-normalized)";
    }
  }
  if (head === "gh" && rest.includes("merge")) {
    return "destructive gh merge form (token-normalized)";
  }
  return null;
}

export interface BashClassification {
  cls: DecisionClass;
  why: string;
}

/** Classify a gated bash ask. `ruleClass` may pin D (never R — R is engine-only law);
 *  `zeroAccessPaths` (the merged rules' secret tier) demote secret-path reads to G so a
 *  credential peek can never ride the supervisor-approvable R lane. */
export function classifyBashCommand(
  command: string,
  opts?: { ruleClass?: "D"; zeroAccessPaths?: string[] },
): BashClassification {
  if (opts?.ruleClass === "D") return { cls: "D", why: "rule-pinned class D" };
  // Token-level net FIRST (F2), raw word-adjacent regexes as the second net.
  const tokenD = tokenBasedDForm(command);
  if (tokenD) return { cls: "D", why: tokenD };
  if (D_FORMS.some((re) => re.test(command))) {
    return { cls: "D", why: "destructive/push/merge/publish/credentials form" };
  }
  if (opts?.zeroAccessPaths) {
    for (const token of command.split(/\s+/).map((t) => expandTilde(t.replace(/["']/g, "")))) {
      for (const zap of opts.zeroAccessPaths) {
        if (token && pathMatchesGlob(token, zap)) {
          return { cls: "G", why: `references zero-access path (${zap}) — never R` };
        }
      }
    }
  }
  if (isReadOnlyAllowlisted(command)) return { cls: "R", why: "read-only allowlist" };
  return { cls: "G", why: "not on the read-only allowlist (unknown/composed/wrapped fail closed)" };
}

// ── WP5/C3: enumerated steering-class G (the ONLY firstmate discretion zone) ──
// dialog-visible reads (composed read-only queries), scratch writes into the firstmate
// task-data tree, non-mutating git queries. Everything else parks.
const DEFAULT_SCRATCH_ROOT = "/home/vladi/firstmate/data";

function expandTildePath(p: string): string {
  return expandTilde(p.replace(/["']/g, ""));
}

function underRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root + "/");
}

export function isEnumeratedSteeringG(
  command: string,
  opts?: { scratchRoot?: string },
): boolean {
  const root = opts?.scratchRoot ?? DEFAULT_SCRATCH_ROOT;
  const cmd = command.trim();
  if (!cmd || /\n/.test(cmd) || /[;&`$]/.test(cmd)) return false;
  // (a) composed read-only queries — every pipe stage must be read-only-allowlisted;
  // quoting together with pipes fails closed.
  if (cmd.includes("|")) {
    if (cmd.includes('"') || cmd.includes("'")) return false;
    const stages = cmd.split("|").map((s) => s.trim());
    if (stages.length > 1 && stages.every((s) => isReadOnlyAllowlisted(s))) return true;
    return false;
  }
  // (b) scratch writes into the task-data tree — enumerated target forms only.
  const redirect = /^(.*?)(>>|>)\s*(\S+)\s*$/.exec(cmd);
  if (redirect) {
    const target = expandTildePath(redirect[3]);
    const lhs = redirect[1].trim();
    if (underRoot(target, root) && /^(echo|printf|cat|tee)\b/.test(lhs)) return true;
  }
  const tok = cmd.split(/\s+/).map((t) => t.replace(/["']/g, ""));
  if (tok[0] === "mkdir" && tok.includes("-p")) {
    const targets = tok.slice(1).filter((t) => t !== "-p" && !t.startsWith("-"));
    return targets.length > 0 && targets.every((t) => underRoot(expandTildePath(t), root));
  }
  if (tok[0] === "touch") {
    const targets = tok.slice(1).filter((t) => !t.startsWith("-"));
    return targets.length > 0 && targets.every((t) => underRoot(expandTildePath(t), root));
  }
  if ((tok[0] === "cp" || tok[0] === "mv") && tok.length >= 3) {
    const dst = expandTildePath(tok[tok.length - 1]);
    if (underRoot(dst, root)) return true;
  }
  if (tok[0] === "tee" && tok.length === 2 && underRoot(expandTildePath(tok[1]), root)) return true;
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// WP2 — decision-context header, degradation law, PRIOR composition
// ═════════════════════════════════════════════════════════════════════════════

const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Sanitize asker-supplied claim text (C4): strip ANSI/control chars, flatten newlines, cap.
 *  Applied to EVERY header value defensively; WHAT/RISK/class are gate-computed and can never
 *  derive from asker input (unit-pinned via multiline/ANSI injection). */
export function sanitizeAskerText(
  raw: string | undefined | null,
  maxLen = 160,
): string | undefined {
  if (!raw) return undefined;
  const flat = raw
    .replace(ANSI_ESCAPE_RE, "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return undefined;
  return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}…` : flat;
}

export function resolveSeat(env: Record<string, string | undefined>): Seat {
  // Trusted invocation paths ONLY: the environment as provisioned at pane birth by the
  // spawner (firstmate/herdr/pi). Never files, CLI args, or prompt content (worker-writable
  // channels).
  // F5 residual (2026-11-17 review — NAMED, understated before): the dialog is itself an
  // interactive-answer surface, and a pane-controlled keystroke stream (tmux/herdr
  // send-keys class of vector) can drive it. A clean-env child pi in a pane the worker
  // controls therefore resolves seat=captain end-to-end: D asks, grant rows, /dc-grants.
  // Bound in the meantime by: the F1 matrix at the answer seam (worker/refused-seat keys
  // park or deny — never proceed) and the F4 store hardening. Leg 2's cross-pane
  // verification must be scoped against exactly this send-keys vector: verify the
  // ANSWERING pane's identity through the herdr socket (pane ↔ session binding), not env
  // alone, before a captain/firstmate answer or grant creation is honored.
  const taskId = (env.FM_TASK_ID ?? "").trim();
  if (taskId) return "worker";
  if ((env.FM_SUPERVISOR ?? "").trim() === "1") return "firstmate";
  return "captain";
}

export interface TaskBinding {
  state: "ok" | "stale" | "unknown";
  taskId: string | null;
}

/** Task binding with degradation: absent FM_TASK_ID → unknown; a pane whose trail shows an
 *  earlier DIFFERENT task → stale (honest pane-historical signal). Unknown/stale DISABLES
 *  task-dependent features (task-keyed answering, PRIOR-by-task) — never guesses. */
export function resolveTaskBinding(
  env: Record<string, string | undefined>,
  trail: TrailEntry[] | null,
): TaskBinding {
  const taskId = (env.FM_TASK_ID ?? "").trim() || null;
  if (!taskId) return { state: "unknown", taskId: null };
  const pane = (env.HERDR_PANE_ID ?? "").trim();
  if (pane && trail) {
    for (let i = trail.length - 1; i >= 0; i--) {
      const e = trail[i];
      if (e.pane === pane && e.task && e.task !== taskId) {
        return { state: "stale", taskId };
      }
    }
  }
  return { state: "ok", taskId };
}

function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

/** PRIOR = same-task gate-decision history only [C2/History-C], actor+age composed; absent or
 *  corrupt trail → undefined (line absent). Disabled when the task binding is not ok. */
export function composePriorLine(
  trail: TrailEntry[] | null,
  taskId: string | null,
  nowMs: number,
  currentSeat: Seat,
): string | undefined {
  if (!trail || !taskId) return undefined;
  const mine = trail.filter((e) => e.task === taskId);
  if (mine.length === 0) return undefined;
  const answeredBy = new Map<string, number>();
  const deniedBy = new Map<string, number>();
  const deniedMessages = new Map<string, number>();
  let parked = 0;
  for (const e of mine) {
    if (e.decision === "proceed") answeredBy.set(e.actor, (answeredBy.get(e.actor) ?? 0) + 1);
    else if (e.decision === "deny") {
      deniedBy.set(e.actor, (deniedBy.get(e.actor) ?? 0) + 1);
      if (e.message) deniedMessages.set(e.actor, (deniedMessages.get(e.actor) ?? 0) + 1);
    } else parked += 1;
  }
  const parts: string[] = [];
  for (const [actor, n] of answeredBy) {
    parts.push(`${n} answered by ${actor === currentSeat ? "you" : actor}`);
  }
  for (const [actor, n] of deniedBy) {
    const withMsg = deniedMessages.get(actor) ?? 0;
    const name = actor === currentSeat ? "you" : actor;
    // Mockup-faithful: a message denial surfaces the message ("1 denied with message");
    // a bare denial surfaces the decider ("denied by you", captain mockup).
    parts.push(withMsg === n ? `${n} denied with message` : `${n} denied by ${name}`);
  }
  if (parked > 0) parts.push(`${parked} parked`);
  const last = mine[mine.length - 1];
  const age = formatAge(nowMs - Date.parse(last.ts));
  const noun = mine.length === 1 ? "ask" : "asks";
  return `(this task): ${mine.length} ${noun} - ${parts.join(", ")} - last ${age} ago`;
}

export function riskLine(cls: DecisionClass): string {
  switch (cls) {
    case "D":
      return "push/merge/publish/credentials - captain-word class";
    case "R":
      return "read-only tier - supervisor-approvable";
    case "G":
      return "gated ask - fail-closed";
  }
}

export function whoLine(seat: Seat, binding: TaskBinding, paneId?: string): string {
  const pane = paneId ? ` (${paneId})` : "";
  if (seat === "captain") return `captain pane${pane} (this session)`;
  if (seat === "firstmate") return `firstmate relay${pane}`;
  if (binding.state === "ok" && binding.taskId) return `worker${pane} - task ${binding.taskId}`;
  if (binding.state === "stale" && binding.taskId) {
    return `worker${pane} - task ${binding.taskId} (stale binding)`;
  }
  return `worker${pane} - task unbound`;
}

/** The decision-context header. Class D omits PURPOSE (mockup-faithful); every other line
 *  renders whenever the gate fires — only PURPOSE may ever vanish (degradation law). */
export function buildDecisionHeader(input: {
  cls: DecisionClass;
  what: string;
  where: string;
  who: string;
  risk: string;
  purpose?: string;
  prior?: string;
}): string[] {
  const lines = [
    `| WHAT  ${input.what}`,
    `| WHERE ${input.where}`,
    `| WHO   ${input.who}`,
  ];
  if (input.cls !== "D" && input.purpose) {
    lines.push(`| PURPOSE (asker): ${input.purpose}`);
  }
  lines.push(`| RISK  ${input.risk}`);
  if (input.prior) lines.push(`| PRIOR ${input.prior}`);
  return lines;
}

// ═════════════════════════════════════════════════════════════════════════════
// WP4 — grants store (agent-home, R-only, seat-gated) + matching
// ═════════════════════════════════════════════════════════════════════════════

export function loadGrants(slug: string): Grant[] {
  try {
    const raw = yamlParse(readFileSync(grantsFileFor(slug), "utf8")) as
      | { grants?: Grant[] }
      | null;
    const list = raw?.grants;
    if (!Array.isArray(list)) return [];
    // Structural never-D: only R-filtered, well-formed grants are honored.
    return list.filter(
      (g) =>
        !!g &&
        typeof g.id === "string" &&
        typeof g.pattern === "string" &&
        g["class-filter"] === "R",
    );
  } catch {
    return []; // corrupt/absent file → no grants honored (fail-closed)
  }
}

function saveGrants(slug: string, grants: Grant[]): boolean {
  const dir = storeDirFor(slug);
  mkdirSync(dir, { recursive: true });
  return withDirLock(dir, "grants", () => {
    writeFileSync(grantsFileFor(slug), yamlStringify({ grants }), "utf8");
    return true;
  });
}

export function createGrant(input: {
  slug: string;
  seat: Seat;
  pattern: string;
  via: "dialog" | "surface";
  now?: Date;
}): Grant | { error: string } {
  const { slug, seat, pattern } = input;
  if (!pattern || !pattern.trim()) return { error: "empty pattern" };
  if (seat === "worker") return { error: "workers never create grants (Q3)" };
  if (seat === "firstmate" && input.via !== "surface") {
    return { error: "firstmate creates R-class grants via the answer surface only (Q3)" };
  }
  const grants = loadGrants(slug);
  const now = input.now ?? new Date();
  const grant: Grant = {
    id: `g-${now.getTime().toString(36)}-${randomBytes(3).toString("hex")}`,
    "created-at": now.toISOString(),
    "creator-seat": seat,
    pattern: pattern.trim(),
    "class-filter": "R",
  };
  grants.push(grant);
  if (!saveGrants(slug, grants)) return { error: "store write failed" };
  return grant;
}

export function revokeGrant(slug: string, id: string): boolean {
  const grants = loadGrants(slug);
  const next = grants.filter((g) => g.id !== id);
  if (next.length === grants.length) return false;
  return saveGrants(slug, next);
}

/** Grant patterns are PREFIX globs (`<head> *`, gate-derived); minimatch honored for
 *  hand-authored richer globs. Only R asks can ever match — never-D is structural. */
export function matchGrant(
  slug: string,
  command: string,
  cls: DecisionClass,
): Grant | null {
  if (cls !== "R") return null;
  for (const g of loadGrants(slug)) {
    const prefix = g.pattern.replace(/ \*$/, "");
    if (command === prefix || command.startsWith(`${prefix} `)) return g;
    try {
      if (minimatch(command, g.pattern, { dot: true })) return g;
    } catch {
      /* malformed hand-authored pattern → skip */
    }
  }
  return null;
}

/** Gate-derived grant pattern from the ACTUAL command (never asker text): git →
 *  `git <sub> *`, otherwise `<bin> *`. */
export function deriveGrantPattern(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const head = tokens[0] ?? command;
  if (head === "git" && tokens.length > 1) return `git ${tokens[1]} *`;
  return `${head} *`;
}

// ═════════════════════════════════════════════════════════════════════════════
// WP5 — authorization matrix (class × asker-seat × answering-seat)
// ═════════════════════════════════════════════════════════════════════════════

export interface MatrixQuery {
  cls: DecisionClass;
  answerSeat: Seat;
  enumeratedSteering: boolean;
  answer: "proceed" | "session" | "grant" | "deny";
}

export interface MatrixVerdict {
  allowed: boolean;
  effect: "proceed" | "deny" | "park";
  why: string;
}

export function resolveDecisionMatrix(q: MatrixQuery): MatrixVerdict {
  // Class D: a fresh explicit captain yes — no session scope, no grants, no firstmate
  // answers, no scope rows ever (v1.1 amended law). Non-captain answers are REFUSED.
  if (q.cls === "D") {
    if (q.answerSeat !== "captain") {
      return { allowed: false, effect: "deny", why: "class D rejects non-captain answers always" };
    }
    if (q.answer === "session" || q.answer === "grant") {
      return { allowed: false, effect: "deny", why: "class D never takes session scope or grants" };
    }
    return {
      allowed: true,
      effect: q.answer === "deny" ? "deny" : "proceed",
      why: "captain explicit decision",
    };
  }
  if (q.answerSeat === "captain") {
    if (q.answer === "grant" && q.cls !== "R") {
      return { allowed: false, effect: "deny", why: "grants are R-only (never-D; G has no grant discretion)" };
    }
    // Session: R anywhere the design allows (captain panes too, WP6); G captain-panes-only [C6]
    // — a captain answering in a captain pane is exactly that case.
    return {
      allowed: true,
      effect: q.answer === "deny" ? "deny" : "proceed",
      why: "captain decision",
    };
  }
  if (q.answerSeat === "firstmate") {
    if (q.cls === "R") {
      return {
        allowed: true,
        effect: q.answer === "deny" ? "deny" : "proceed",
        why: "class R is supervisor-approvable",
      };
    }
    if (q.enumeratedSteering) {
      if (q.answer === "session" || q.answer === "grant") {
        return { allowed: false, effect: "park", why: "enumerated steering-G carries no scope discretion" };
      }
      return {
        allowed: true,
        effect: q.answer === "deny" ? "deny" : "proceed",
        why: "enumerated steering-class G (C3)",
      };
    }
    return { allowed: false, effect: "park", why: "non-enumerated G parks to the captain" };
  }
  // Worker answering its own pane: preserved pane-key contract — proceed/deny this once for
  // class R and enumerated steering-G; scope rows never render on a crewmate-drivable pane
  // (C5); and a non-enumerated G NEVER proceeds on a pane key — it parks (F1 probe row).
  if (q.answer === "session" || q.answer === "grant") {
    return { allowed: false, effect: "deny", why: "crewmate-drivable panes never render scope rows (C5)" };
  }
  if (q.cls === "G" && !q.enumeratedSteering) {
    if (q.answer === "proceed") {
      return { allowed: false, effect: "park", why: "non-enumerated G parks to the supervisor (never pane-proceeds)" };
    }
    return { allowed: true, effect: "deny", why: "pane deny is always safe" };
  }
  return {
    allowed: true,
    effect: q.answer === "deny" ? "deny" : "proceed",
    why: "pane-keyed answer (actor=pane-seat, honest fallback per F3)",
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// WP6 — session scopes (explicit session identity; die on session replacement)
// ═════════════════════════════════════════════════════════════════════════════

interface SessionScope {
  sessionId: string;
  rulePattern: string;
  cls: DecisionClass;
  createdAt: string;
}

let sessionScopes: SessionScope[] = [];

export function recordSessionScope(
  sessionId: string | null | undefined,
  rulePattern: string,
  cls: DecisionClass,
  now?: Date,
): boolean {
  if (!sessionId) return false; // explicit session identity required — never guessed
  const exists = sessionScopes.some(
    (s) => s.sessionId === sessionId && s.rulePattern === rulePattern && s.cls === cls,
  );
  if (!exists) {
    sessionScopes.push({
      sessionId,
      rulePattern,
      cls,
      createdAt: (now ?? new Date()).toISOString(),
    });
  }
  return true;
}

export function activeSessionScope(
  sessionId: string | null | undefined,
  rulePattern: string,
  cls: DecisionClass,
): SessionScope | null {
  if (!sessionId) return null;
  return (
    sessionScopes.find(
      (s) => s.sessionId === sessionId && s.rulePattern === rulePattern && s.cls === cls,
    ) ?? null
  );
}

/** session_start lifecycle: scopes keyed to another session DIE on session replacement. */
export function pruneScopesToSession(sessionId: string | undefined): number {
  const before = sessionScopes.length;
  if (!sessionId) {
    sessionScopes = [];
    return before;
  }
  sessionScopes = sessionScopes.filter((s) => s.sessionId === sessionId);
  return before - sessionScopes.length;
}

export function sessionScopeCount(): number {
  return sessionScopes.length;
}

// ═════════════════════════════════════════════════════════════════════════════
// WP3 — dialog v2: injectable-clock countdown + seat-bound decision dialog
// ═════════════════════════════════════════════════════════════════════════════

export interface Clock {
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval> | undefined): void;
}

const realClock: Clock = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => {
    if (id) clearInterval(id);
  },
};

// Dialog countdown clock seam: production uses the real 1s interval; fake-clock tests inject
// a manual clock so parking/expiry lifecycles are deterministic. Module seam (not env), so a
// worker cannot slow or stop its own countdown.
let dialogClockOverride: Clock | null = null;
export function setDialogClockForTesting(clock: Clock | null): void {
  dialogClockOverride = clock;
}

/** Countdown core with an injectable clock (fake-clock tests). Pause preserves the REMAINING
 *  time; resume continues at remaining — never reset. Expiry fires exactly once. */
export class Countdown {
  private remainingMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private expired = false;
  private readonly onTick: () => void;
  private readonly onExpire: () => void;
  private readonly clock: Clock;

  constructor(opts: {
    timeoutMs: number;
    onTick: () => void;
    onExpire: () => void;
    clock?: Clock;
  }) {
    this.remainingMs = Math.max(1000, opts.timeoutMs);
    this.onTick = opts.onTick;
    this.onExpire = opts.onExpire;
    this.clock = opts.clock ?? realClock;
  }

  start(): void {
    if (this.running || this.expired) return;
    this.running = true;
    this.timer = this.clock.setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    this.remainingMs -= 1000;
    this.onTick();
    if (this.remainingMs <= 0) {
      this.expired = true;
      this.stopTimer();
      this.onExpire();
    }
  }

  pause(): void {
    if (this.running) {
      this.stopTimer();
      this.running = false;
    }
  }

  resume(): void {
    if (!this.running && !this.expired) {
      this.running = true;
      this.timer = this.clock.setInterval(() => this.tick(), 1000);
    }
  }

  remainingSec(): number {
    return Math.max(0, Math.ceil(this.remainingMs / 1000));
  }

  isExpired(): boolean {
    return this.expired;
  }

  dispose(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      this.clock.clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// ── SafetyConfirmDialog (Path B, 2026-07-10) — v1.2: DecisionDialog ──────────
// Loud, theme-independent overlay confirm (the 0.80.3 lesson: ctx.ui.custom + overlay +
// hard-coded ANSI so it pops on ANY theme; safe default = No; timeout/Esc/Ctrl-C → block).
// v1.2 additions: decision-context header lines, seat-bound option rows, label-bound hotkeys,
// expandable detail (d), deny-with-message composer (a) with countdown pause/resume.
export type DialogOutcome =
  | { kind: "proceed"; sessionScope?: boolean; grant?: { pattern: string; classFilter: DecisionClass } }
  | { kind: "block"; message?: string }
  | { kind: "park" };

export interface DialogOption {
  id: "block" | "proceed" | "session" | "grant" | "compose";
  key: string; // label-bound hotkey (single char)
  label: string;
  grant?: { pattern: string; classFilter: DecisionClass };
}

/** Seat-bound option rows [C5]: session/grant rows render ONLY when the answering seat is
 *  captain or firstmate-relay — never on a crewmate-drivable pane. Class D gets no scope
 *  rows ever. G session rows are captain-only [C6]; grants are R-only (never-D). */
export function buildDialogOptions(
  cls: DecisionClass,
  answerSeat: Seat,
  grantPattern: string | null,
  enumeratedSteering = false,
): DialogOption[] {
  // F1 (2026-11-17 review): never render an answer the authorization matrix would refuse —
  // class D at a non-captain seat and non-enumerated G at the firstmate relay get
  // [block, compose] only. The matrix remains the answer-seam backstop regardless.
  const answerRefused =
    (cls === "D" && answerSeat !== "captain") ||
    (cls === "G" && answerSeat === "firstmate" && !enumeratedSteering);
  const rows: DialogOption[] = [
    { id: "block", key: "n", label: "🛑  No, block" },
  ];
  const compose: DialogOption = {
    id: "compose",
    key: "a",
    label: "✎  No, and tell the agent why…",
  };
  const canScope = !answerRefused && (answerSeat === "captain" || answerSeat === "firstmate");
  if (!answerRefused) {
    rows.push({ id: "proceed", key: "y", label: "🟢  Yes, proceed this once" });
  }
  if (cls === "D") return [...rows, compose]; // no scope rows ever
  if (canScope && cls === "R") {
    rows.push({
      id: "session",
      key: "s",
      label: answerSeat === "firstmate" ? "🟡  Yes, worker session" : "🟡  Yes, this session",
    });
    if (grantPattern) {
      rows.push({
        id: "grant",
        key: "g",
        label: `🔑  Grant for ${grantPattern} in this repo`,
        grant: { pattern: grantPattern, classFilter: "R" },
      });
    }
  } else if (canScope && cls === "G" && answerSeat === "captain") {
    rows.push({ id: "session", key: "s", label: "🟡  Yes, this session" });
  }
  rows.push(compose);
  return rows;
}

const DIALOG_ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  black: "\x1b[30m",
  barBg: "\x1b[47m",
} as const;

const COMPOSE_MAX = 500;

export class DecisionDialog implements Component {
  private readonly cls: DecisionClass;
  private readonly headerLines: string[];
  private readonly detailLines: string[];
  private readonly options: DialogOption[];
  private readonly tui: TUI;
  private readonly onResult: (o: DialogOutcome) => void;
  private readonly countdown: Countdown;
  private selected: number;
  private mode: "options" | "compose" = "options";
  private composeBuffer = "";
  private detailOpen = false;
  private finished = false;

  constructor(opts: {
    cls: DecisionClass;
    headerLines: string[];
    detailLines: string[];
    options: DialogOption[];
    timeoutMs: number;
    tui: TUI;
    onResult: (o: DialogOutcome) => void;
    clock?: Clock;
  }) {
    this.cls = opts.cls;
    this.headerLines = opts.headerLines;
    this.detailLines = opts.detailLines;
    this.options = opts.options;
    this.tui = opts.tui;
    this.onResult = opts.onResult;
    const blockIdx = this.options.findIndex((o) => o.id === "block");
    this.selected = blockIdx >= 0 ? blockIdx : 0; // safe default = the block row
    this.countdown = new Countdown({
      timeoutMs: opts.timeoutMs,
      clock: opts.clock,
      onTick: () => this.tui.requestRender(),
      onExpire: () => this.finish({ kind: "park" }), // unanswered window → park (distinct from deny)
    });
    this.countdown.start();
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.mode === "compose") {
      if (matchesKey(data, Key.escape)) {
        // nested-Esc layer 1: leave the composer, resume the countdown at remaining time
        this.mode = "options";
        this.countdown.resume();
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const msg = this.composeBuffer.trim();
        this.finish(msg ? { kind: "block", message: msg } : { kind: "block" });
        return;
      }
      if (data === "\x7f" || data === "\b") {
        this.composeBuffer = this.composeBuffer.slice(0, -1);
        this.tui.requestRender();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32 && this.composeBuffer.length < COMPOSE_MAX) {
        this.composeBuffer += data;
        this.tui.requestRender();
      }
      return;
    }
    // options mode
    if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.selected = Math.min(this.options.length - 1, this.selected + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.activate(this.options[this.selected]);
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.finish({ kind: "block" }); // Esc / Ctrl-C = block (preserved contract)
      return;
    }
    if (data.length === 1 && data.toLowerCase() === "d") {
      this.detailOpen = !this.detailOpen;
      this.tui.requestRender();
      return;
    }
    // Hotkeys bind to option identity (label-bound keys), never row positions: reordering
    // rows cannot change what y/n/s/g/a do.
    const key = data.length === 1 ? data.toLowerCase() : "";
    if (key) {
      const byKey = this.options.find((o) => o.key === key);
      if (byKey) this.activate(byKey);
    }
  }

  private activate(o: DialogOption | undefined): void {
    if (!o || this.finished) return;
    switch (o.id) {
      case "block":
        this.finish({ kind: "block" });
        return;
      case "proceed":
        this.finish({ kind: "proceed" });
        return;
      case "session":
        this.finish({ kind: "proceed", sessionScope: true });
        return;
      case "grant":
        this.finish({ kind: "proceed", grant: o.grant });
        return;
      case "compose":
        this.mode = "compose";
        this.composeBuffer = "";
        this.countdown.pause(); // countdown pauses inside the composer
        this.tui.requestRender();
        return;
    }
  }

  render(width: number): string[] {
    const w = Math.max(44, width);
    const A = DIALOG_ANSI;
    const fit = (s: string): string => {
      const t = truncateToWidth(s, w);
      return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
    };
    const lines: string[] = [];

    // Title bar — solid white bg, black bold text.
    lines.push(
      fit(
        `${A.barBg}${A.black}${A.bold} 🛡️  ${this.cls} GATE  ⏱ auto-block ${this.countdown.remainingSec()}s`,
      ),
    );
    lines.push(fit(""));

    // Decision-context header (WHAT/WHERE/WHO/PURPOSE/RISK/PRIOR) — word-wrapped, bright labels dim.
    const inner = Math.max(20, w - 2);
    for (const hl of this.headerLines) {
      for (const ln of wrapTextWithAnsi(`${A.bold}${hl}${A.reset}`, inner)) {
        lines.push(fit(` ${ln}`));
      }
    }
    lines.push(fit(""));

    // Expandable detail (d) — full gate-computed context.
    if (this.detailOpen) {
      for (const dl of this.detailLines) {
        for (const ln of wrapTextWithAnsi(`${A.dim}${dl}${A.reset}`, inner)) {
          lines.push(fit(` ${ln}`));
        }
      }
      lines.push(fit(""));
    }

    if (this.mode === "compose") {
      lines.push(
        fit(
          `${A.yellow}${A.bold} ✎ tell the agent why (Enter send · Esc back — countdown paused):${A.reset}`,
        ),
      );
      lines.push(fit(` > ${this.composeBuffer}▌`));
      lines.push(fit(""));
    } else {
      // Options — selected row is a solid white bar; keys shown label-bound.
      for (let i = 0; i < this.options.length; i++) {
        const o = this.options[i];
        const isSel = i === this.selected;
        const body = isSel ? ` ❯ [${o.key}] ${o.label}` : `   [${o.key}] ${o.label}`;
        lines.push(fit(isSel ? `${A.barBg}${A.black}${A.bold}${body}` : `${A.dim}${body}`));
      }
      lines.push(fit(""));
    }

    lines.push(
      fit(
        `${A.dim} ↑/↓ move · Enter confirm · n/y + row keys · d detail · Esc = block`,
      ),
    );
    return lines;
  }

  invalidate(): void {
    /* render is pure — nothing cached */
  }

  dispose(): void {
    // F6 (2026-11-17 review, leg-2 live round): dispose-without-finish leaves the awaited
    // ctx.ui.custom promise UNRESOLVED — if the TUI ever pops the overlay without a result,
    // the tool_call hangs. No failing test exists yet; per the fix-round ruling, no behavior
    // change without one. Pin this in the leg-2 live validation (dispose the live overlay
    // via /reload-class races and assert the await settles).
    this.countdown.dispose();
  }

  private finish(outcome: DialogOutcome): void {
    if (this.finished) return; // exactly-once outcomes
    this.finished = true;
    this.countdown.dispose();
    this.onResult(outcome);
  }
}

// --- R2 (2026-09-17, design-v0.2 + sis-verdict-v0.1 C1/C2): headless denials settle IN-BAND ---
// In non-tui modes (json/print/rpc — dispatch sub-agents, ACP), dialogs are unanswerable:
// ctx.ui.custom is a no-op resolve there (pi 0.86.1 rpc docs: `custom()` returns `undefined`; re-verified ~rpc.md:1196), and
// ctx.abort() poisons the parent's fallback walk (abort → stopReason=error → inbandError
// → downshift). Headless denials therefore return {block:true, reason} WITHOUT abort —
// the model finishes its turn, output is non-empty, and the walk structurally cannot fire.
function isHeadless(mode: string | undefined): boolean {
  return mode !== "tui";
}

function headlessReason(violation: string, askClass: boolean): string {
  if (askClass) {
    return (
      `🛑 BLOCKED by mini-dc (headless ASK→deny): ${violation}. ` +
      `This rule requires operator confirmation in interactive sessions; headless sessions cannot confirm. ` +
      `Restructure the command (file-wrapped script, non-ASK phrasing) or route the action via the Operator.`
    );
  }
  return `🛑 BLOCKED by mini-dc (headless): ${violation}. DO NOT work around this — surface to the Operator.`;
}

// ── repo context helpers (WHERE line) ────────────────────────────────────────
function gitOut(args: string, cwd: string): string | null {
  try {
    const out = execSync(`git -C ${JSON.stringify(cwd)} ${args}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const t = out.trim();
    return t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

// ── F4 (2026-11-17 review): store protection beyond lexical matching ──────────
// Lexical prefix checks are defeated by `..`-traversal, quoting, and globs. Helpers:

const GLOB_CHARS = /[*?\[]/;

function underStorePrefix(p: string, storeReal: string): boolean {
  return p === storeReal || p.startsWith(storeReal + sep);
}

// N1 (2026-11-17 recheck): bash words like `$HOME/.pi/...` and `${TMPDIR}/...` carry env
// refs the OS expands at execution — expand the KNOWN location vars before analysis
// (arbitrary `$VAR` values are unknowable at gate time; that residual stays documented).
function expandShellEnvVars(s: string): string {
  const home = envSource().HOME || os.homedir();
  const tmp = envSource().TMPDIR || os.tmpdir();
  return s
    .replace(/\$\{HOME\}/g, home)
    .replace(/\$HOME\b/g, home)
    .replace(/\$\{TMPDIR\}/g, tmp)
    .replace(/\$TMPDIR\b/g, tmp);
}

/** Realpath of the nearest EXISTING ancestor, with the non-existing tail rebuilt on top
 *  (so write-targets inside the store that don't exist yet still resolve into it). */
function realpathNearest(p: string): string | null {
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      const real = realpathSync(cur);
      const tail = relative(cur, p);
      return tail ? pathResolve(real, tail) : real;
    } catch {
      /* not yet existing — climb */
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/** A token carrying glob chars: expand the FIRST glob segment against the fixed prefix's
 *  real directory entries, then test each expansion's realpath against the store. Best-effort
 *  by construction (later glob segments stay literal — realpathNearest still resolves the
 *  existing prefix part of the tail). */
function globTokenTouchesStore(token: string, storeReal: string, cwd: string): boolean {
  const segs = token.split("/");
  const idx = segs.findIndex((s) => GLOB_CHARS.test(s));
  if (idx <= 0) return false; // glob in the first segment or none — out of scope (best-effort)
  const fixedDir = pathResolve(cwd, segs.slice(0, idx).join("/"));
  let entries: string[];
  try {
    entries = readdirSync(fixedDir);
  } catch {
    return false;
  }
  for (const e of entries) {
    if (!minimatch(e, segs[idx], { dot: true })) continue;
    const candidate = [...segs.slice(0, idx), e, ...segs.slice(idx + 1)].join("/");
    const resolved = realpathNearest(pathResolve(cwd, candidate));
    if (resolved && underStorePrefix(resolved, storeReal)) return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  // Part B: null = unloaded = DENY BASH BY DEFAULT (fail-closed)
  let rules: Rules | null = null;
  let rulesSource: "none" | "global" | "project" | "merged" = "none";
  let mode: "abort" | "continue" = "abort";
  // v1.2 state
  let grantsCount = 0;
  let slugCache: { cwd: string; slug: string } | null = null;

  const currentSlug = (cwd: string): string | null => {
    if (slugCache && slugCache.cwd === cwd) return slugCache.slug;
    const root = gitOut("rev-parse --show-toplevel", cwd);
    if (!root) return null;
    const slug = resolveRepoSlug(root);
    slugCache = { cwd, slug };
    return slug;
  };

  const sessionIdentity = (): string | undefined => {
    const sid = (envSource().PI_SESSION_ID ?? "").trim();
    return sid || undefined;
  };

  const paneIdentity = (): string | null => {
    const pane = (envSource().HERDR_PANE_ID ?? "").trim();
    if (pane) return pane;
    const sid = (envSource().PI_SESSION_ID ?? "").trim();
    return sid ? `session:${sid.slice(0, 8)}` : null;
  };

  const refreshGrantsCount = (slug: string | null): void => {
    grantsCount = slug ? loadGrants(slug).length : 0;
  };

  const statusText = (): string => {
    const count = rules
      ? rules.bashToolPatterns.length +
        rules.zeroAccessPaths.length +
        rules.readOnlyPaths.length
      : 0;
    const base = rules
      ? `🛡️ mini-dc: ${count} rules (${rulesSource}, ${mode})`
      : `🛡️ mini-dc: DENY-BASH (no rules, ${mode})`;
    return `${base} · ${grantsCount} grants · ${sessionScopeCount()} scopes`;
  };

  pi.on("session_start", async (_event, ctx) => {
    // Part A: load global floor + project override, merge deny-additive
    const globalRules = loadRulesLayer(globalRulesPathOverride ?? GLOBAL_RULES_PATH);
    const projectPath = join(ctx.cwd, ".pi", "mini-dc-rules.yaml");
    const projectRules = loadRulesLayer(projectPath);

    rules = mergeRules(globalRules, projectRules);

    if (!rules) {
      rulesSource = "none";
    } else if (globalRules && projectRules) {
      rulesSource = "merged";
    } else if (globalRules) {
      rulesSource = "global";
    } else {
      rulesSource = "project";
    }

    // WP6: session scopes die on session replacement (scoped to the explicit session id).
    pruneScopesToSession(sessionIdentity());

    const slug = currentSlug(ctx.cwd);
    refreshGrantsCount(slug);

    const count = rules
      ? rules.bashToolPatterns.length +
        rules.zeroAccessPaths.length +
        rules.readOnlyPaths.length
      : 0;
    if (rules) {
      ctx.ui.notify(`🛡️ mini-dc: ${count} rules (${rulesSource})`, "info");
    } else {
      ctx.ui.notify(
        `🛡️ mini-dc: NO RULES LOADED — bash will be DENIED. Add ~/.pi/agent/mini-dc-rules.yaml (global) or .pi/mini-dc-rules.yaml (project).`,
        "warning",
      );
    }
    ctx.ui.setStatus("mini-dc", statusText());
  });

  pi.registerCommand("dc-mode", {
    description: "Toggle mini-dc mode: /dc-mode abort|continue",
    handler: async (args, ctx) => {
      const m = args.trim();
      if (m === "abort" || m === "continue") {
        mode = m;
        ctx.ui.setStatus("mini-dc", statusText());
        ctx.ui.notify(`mode → ${mode}`, "info");
      } else {
        ctx.ui.notify("Usage: /dc-mode abort|continue", "warning");
      }
    },
  });

  // WP4: /dc-grants — captain-managed store surface (list + revoke). Workers/firstmate
  // panes are refused here; the store itself is additionally zero-access for them at the
  // tool/shell tier below (defense in depth).
  pi.registerCommand("dc-grants", {
    description: "Gate grants: /dc-grants [list | revoke <id>] (captain-managed)",
    handler: async (args, ctx) => {
      const seat = resolveSeat(envSource());
      if (seat !== "captain") {
        ctx.ui.notify(
          "🛡️ mini-dc: grants are captain-managed — this pane seat cannot list or revoke.",
          "warning",
        );
        return;
      }
      const slug = currentSlug(ctx.cwd);
      if (!slug) {
        ctx.ui.notify("🛡️ mini-dc: not inside a git repository — no grant store.", "warning");
        return;
      }
      const revoke = /^revoke\s+(\S+)$/.exec(args.trim());
      if (revoke) {
        const ok = revokeGrant(slug, revoke[1]);
        refreshGrantsCount(slug);
        ctx.ui.setStatus("mini-dc", statusText());
        ctx.ui.notify(
          ok ? `🔑 grant ${revoke[1]} revoked` : `🔑 no such grant: ${revoke[1]}`,
          ok ? "info" : "warning",
        );
        return;
      }
      const arg = args.trim();
      if (arg !== "" && arg !== "list") {
        ctx.ui.notify("Usage: /dc-grants [list | revoke <id>]", "warning");
        return;
      }
      const grants = loadGrants(slug);
      if (grants.length === 0) {
        ctx.ui.notify("🔑 no grants stored for this repo", "info");
        return;
      }
      for (const g of grants) {
        ctx.ui.notify(
          `🔑 ${g.id}  ${g["creator-seat"]}  ${g["class-filter"]}  ${g.pattern}  (${g["created-at"]})`,
          "info",
        );
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    // ── Tier 0 (v1.2 WP4): protected mini-dc store — non-captain seats are denied ──
    // Worker tool/file/shell attempts to create/revoke grants or rewrite the trail are
    // denied before any other tier. F4 + N1 (2026-11-17 review + recheck): realpath of the
    // nearest existing ancestor, quote/token-aware (incl. shell-escaped quotes), tilde AND
    // env-expanded ($HOME/${HOME}/$TMPDIR), `..`-normalized, first-glob-segment aware, with
    // the global rules file as a protected target in its own right — beyond lexical only,
    // still BEST-EFFORT (documented honestly in README; shell-string analysis cannot be total).
    const seat = resolveSeat(envSource());
    if (seat !== "captain") {
      // N1: protect BOTH the active store root (test seam or production) AND the production
      // default — the production store and the global rules file stay protected regardless
      // of any module-level root override.
      const activeRoot = storeRoot();
      const prodDefault = join(os.homedir(), ".pi", "agent", "mini-dc");
      const roots = activeRoot === prodDefault ? [activeRoot] : [activeRoot, prodDefault];
      const rootReal = roots.map((r) => {
        try { return realpathSync(r); } catch { return r; }
      });
      const rulesReal = pathResolve(GLOBAL_RULES_PATH);
      const rulesForms = [
        rulesReal,
        GLOBAL_RULES_PATH,
        "~/.pi/agent/mini-dc-rules.yaml",
        "$HOME/.pi/agent/mini-dc-rules.yaml",
        "${HOME}/.pi/agent/mini-dc-rules.yaml",
      ];
      const storeRefForms = [
        ...roots,
        ...rootReal,
        "~/.pi/agent/mini-dc",
        "$HOME/.pi/agent/mini-dc",
        "${HOME}/.pi/agent/mini-dc",
        "$HOME/.pi/agent/mini-dc-rules.yaml",
        "${HOME}/.pi/agent/mini-dc-rules.yaml",
        ".pi/agent/mini-dc",
      ];
      let violationWhat: string | null = null;
      if (
        isToolCallEventType("read", event) ||
        isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event)
      ) {
        const p = String(event.input?.path ?? "");
        const candidates = [p, expandTilde(p), join(ctx.cwd, p)];
        // Lexical net + realpath-of-nearest-existing-ancestor net per protected root, plus
        // the global rules file as a protected target in its own right (N1).
        const lexical = candidates.some((c) => roots.some((r) => c.startsWith(r)) || c === rulesReal);
        const viaReal = candidates.some((c) => {
          const resolved = realpathNearest(c);
          if (!resolved) return false;
          return rootReal.some((rr) => underStorePrefix(resolved, rr)) || resolved === rulesReal;
        });
        if (lexical || viaReal) {
          violationWhat = `privileged mini-dc store/rules path: ${p}`;
        }
      } else if (isToolCallEventType("bash", event)) {
        const cmd = String(event.input?.command ?? "");
        const lexical = storeRefForms.some((form) => cmd.includes(form));
        let tokenLevel = false;
        if (!lexical) {
          // F4/N1 token net: per token, try the shell-dequote variants (raw, '\'':escaped
          // quotes resolved, quotes/backslash-escapes stripped), expand tilde AND the known
          // env forms, normalize `..` via resolve, realpath the nearest existing ancestor,
          // prefix-check against every protected root, equality against the global rules
          // file; glob tokens expand their first glob segment.
          const tokens = cmd.split(/\s+/).map((t) => t.replace(/^['"]/g, "")).filter(Boolean);
          tokenLevel = tokens.some((rawTok) => {
            const variants = [rawTok];
            const unescaped = rawTok.replace(/'\\''/g, "'");
            if (unescaped !== rawTok) variants.push(unescaped);
            const stripped = rawTok.replace(/['"]/g, "").replace(/\\(.)/g, "$1");
            if (stripped !== rawTok && stripped !== unescaped) variants.push(stripped);
            return variants.some((rawVariant) => {
              const tok = expandShellEnvVars(expandTilde(rawVariant));
              const norm = pathResolve(isAbsolute(tok) ? tok : join(ctx.cwd, tok));
              if (rootReal.some((rr) => underStorePrefix(norm, rr)) || roots.some((r) => norm.startsWith(r + sep) || norm === r)) return true;
              if (norm === rulesReal) return true;
              const resolved = realpathNearest(norm);
              if (resolved && (rootReal.some((rr) => underStorePrefix(resolved, rr)) || resolved === rulesReal)) return true;
              if (GLOB_CHARS.test(tok)) {
                return rootReal.some((rr) => globTokenTouchesStore(tok, rr, ctx.cwd));
              }
              return false;
            });
          });
          // N2 (recheck round 3): unset/empty-var mid-name elision (mini-d${E}c with E unset)
          // reconstructs protected paths at execution. Expand KNOWN vars first, then elide
          // any remaining $VAR/`${VAR}` segments, then strip quotes (quote boundaries end
          // var names — elision on the raw token, mirroring the O1-fold discipline). This
          // intentionally over-blocks set-nonempty elisions: fail-closed, same trade as O1.
          if (!tokenLevel) {
            for (const rawTok of tokens) {
              const elided = expandTilde(
                expandShellEnvVars(rawTok).replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, "").replace(/['"]/g, ""),
              );
              if (elided === rawTok || !elided.includes("/")) continue;
              const tok = expandShellEnvVars(expandTilde(elided)); // idempotent second pass
              const norm = pathResolve(isAbsolute(tok) ? tok : join(ctx.cwd, tok));
              if (rootReal.some((rr) => underStorePrefix(norm, rr)) || roots.some((r) => norm.startsWith(r + sep) || norm === r)) { tokenLevel = true; break; }
              if (norm === rulesReal) { tokenLevel = true; break; }
              const resolved = realpathNearest(norm);
              if (resolved && (rootReal.some((rr) => underStorePrefix(resolved, rr)) || resolved === rulesReal)) { tokenLevel = true; break; }
            }
          }
        }
        let squashed = false;
        if (!lexical && !tokenLevel) {
          // Space-quote split net: a protected path torn apart by quoted whitespace still
          // lands in the quote-stripped, whitespace-free command (N1: env + tilde forms of
          // the store AND the rules file included; N2: $VAR-segment-elided flat form too —
          // greedy, backstop-only, the token net above is the precise fix).
          const flat = cmd.replace(/['"\\]/g, "").replace(/\s+/g, "");
          const flatDeEnv = flat.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, "");
          const forms = storeRefForms.concat(rulesForms).map((form) => form.replace(/['"\\]/g, "").replace(/\s+/g, ""));
          squashed = forms.some((form) => flat.includes(form) || (flatDeEnv !== flat && flatDeEnv.includes(form)));
        }
        if (lexical || tokenLevel || squashed) {
          violationWhat = "shell command references the privileged mini-dc store/rules";
        }
      }
      if (violationWhat) {
        const body =
          `${violationWhat}. The grants/trail store and the global rules file are captain-managed; ` +
          `worker and supervisor panes are denied (best-effort adversarial resistance: realpath, env/quote/traversal/glob aware) — ` +
          `grant/revoke/trail writes go through ` +
          `the captain dialog or /dc-grants only.`;
        const reason = isHeadless(ctx.mode)
          ? `🛑 BLOCKED by mini-dc (headless): ${body} DO NOT work around this — surface to the Operator.`
          : `🛑 BLOCKED by mini-dc: ${body} DO NOT work around this — tell the user.`;
        pi.appendEntry("mini-dc-log", {
          tool: event.toolName,
          input: event.input,
          rule: "protected store (worker/supervisor denied, best-effort)",
          mode,
          seat,
          ...(isHeadless(ctx.mode) ? { headlessDeny: true, askClass: false } : {}),
        });
        ctx.ui.notify("🛑 mini-dc: privileged mini-dc store is protected for this seat", "error");
        if (isHeadless(ctx.mode)) return { block: true, reason };
        if (mode === "abort") ctx.abort();
        return { block: true, reason };
      }
    }

    // Part B: FAIL-CLOSED — if rules are null (unloaded), DENY bash; allow read/write/edit (non-destructive)
    if (isToolCallEventType("bash", event) && rules === null) {
      const body =
        `no rules loaded (no global ~/.pi/agent/mini-dc-rules.yaml, ` +
        `no project .pi/mini-dc-rules.yaml). bash is DENIED until rules are configured.`;
      // F2 (sis R2-review): fail-closed headless denial gets the (headless) infix + Operator-routing
      // guidance, matching the other headless reason classes.
      const reason = isHeadless(ctx.mode)
        ? `🛑 BLOCKED by mini-dc (headless): ${body} Headless session — surface this to the Operator (add a rules file or run with --no-extensions to bypass).`
        : `🛑 BLOCKED by mini-dc: ${body} Add a rules file or run with --no-extensions to bypass.`;
      pi.appendEntry("mini-dc-log", {
        tool: event.toolName,
        input: event.input,
        rule: "fail-closed (no rules)",
        mode,
        ...(isHeadless(ctx.mode) ? { headlessDeny: true, askClass: false } : {}),
      });
      ctx.ui.notify("🛑 mini-dc: bash DENIED — no rules loaded", "error");
      // R2 C2: headless fail-closed settles in-band — no abort (abort poisons the walk).
      if (isHeadless(ctx.mode)) return { block: true, reason };
      if (mode === "abort") ctx.abort();
      return { block: true, reason };
    }

    // W2: rules === null (no global + no project rules loaded) — bash is DENIED above. For
    // read/write/edit, no patterns can be enforced, so policy = ALLOW (read/write/edit are
    // non-destructive; bash is the catastrophic surface). Explicit return prevents the uncaught
    // throw that `const r = rules!` would cause on a null rules object (emitToolCall has no
    // try/catch — see audit W1/W2). Tighten to fail-closed here if secret-integrity-on-no-rules
    // is later desired (note: with no rules, zeroAccessPaths can't protect .env/creds).
    if (rules === null) return { block: false };

    let violation: string | null = null;
    let ask = false;
    let matchedRule: Rule | null = null;
    const r = rules; // non-null after the guard above

    // Tier 1: zero-access paths on read/write/edit (blocks read AND write)
    if (
      isToolCallEventType("read", event) ||
      isToolCallEventType("write", event) ||
      isToolCallEventType("edit", event)
    ) {
      for (const zap of r.zeroAccessPaths) {
        if (pathMatchesGlob(event.input.path, zap)) {
          violation = `zero-access path: ${zap}`;
          break;
        }
      }
    }

    // Tier 1b: read-only paths on write/edit only (reads allowed; edits/writes blocked)
    if (
      !violation &&
      (isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event))
    ) {
      for (const rop of r.readOnlyPaths) {
        if (pathMatchesGlob(event.input.path, rop)) {
          violation = `read-only path: ${rop}`;
          break;
        }
      }
    }

    // Tier 2: bash regex patterns
    if (!violation && isToolCallEventType("bash", event)) {
      for (const rule of r.bashToolPatterns) {
        if (new RegExp(rule.pattern).test(event.input.command)) {
          violation = rule.reason;
          ask = !!rule.ask;
          matchedRule = rule;
          break;
        }
      }
    }

    // AF1 (2026-11-17 both-desk smoke-alignment finding): `git -C <dir> push` passed UNGATED —
    // the plain-push rule regex misses the -C form and the token-level D-net only ran AFTER a
    // rule match. Evaluate the token D-net BEFORE the rules ask/block decision: any D-shaped
    // bash command gets the D ask (captain seat) / park-or-refuse (other seats) even when NO
    // rule matches. Rule matches keep their precedence: a BLOCK rule still hard-blocks without
    // dialog (block wins over ask — the seam above stays skipped), and an ask-rule still asks
    // ONCE with its rule text (no double dialog — this seam stays skipped when a rule matched).
    // The R/G classifier stays behind the rules engine exactly as before.
    if (!violation && isToolCallEventType("bash", event)) {
      const tokenD = tokenBasedDForm(String(event.input?.command ?? ""));
      if (tokenD) {
        violation = tokenD;
        ask = true;
        // matchedRule stays null — the bare D-net ask carries no rule pattern; the dialog's
        // `matched rule` line renders the net's D why instead.
      }
    }

    if (!violation) return { block: false };

    // ── v1.2 WP1/WP5: classification + pre-dialog authorization (grants, session scopes) ──
    const command = isToolCallEventType("bash", event)
      ? String(event.input?.command ?? "")
      : String(event.input?.path ?? "");
    const slug = currentSlug(ctx.cwd);
    const sessionId = sessionIdentity();
    const paneId = paneIdentity();
    let clsInfo: BashClassification | null = null;
    let steering = false;
    if (ask && isToolCallEventType("bash", event)) {
      clsInfo = classifyBashCommand(command, {
        ruleClass: matchedRule?.class,
        zeroAccessPaths: r.zeroAccessPaths,
      });
      steering = clsInfo.cls === "G" ? isEnumeratedSteeringG(command) : false;

      // Grants + session scopes auto-proceed — NEVER for class D (D-never-scope, structural).
      if (clsInfo.cls !== "D" && slug) {
        const scope = activeSessionScope(sessionId, matchedRule?.pattern ?? "", clsInfo.cls);
        if (scope) {
          if (slug) {
            appendTrail(slug, {
              v: 1,
              ts: new Date().toISOString(),
              actor: "gate",
              pane: paneId,
              task: (envSource().FM_TASK_ID ?? "").trim() || null,
              subject: sha16(command),
              cls: clsInfo.cls,
              decision: "proceed",
              scope: "session",
            });
          }
          pi.appendEntry("mini-dc-log", {
            tool: event.toolName,
            input: event.input,
            rule: violation,
            mode,
            cls: clsInfo.cls,
            outcome: "proceed",
            scope: "session",
          });
          return { block: false };
        }
        const grant = matchGrant(slug, command, clsInfo.cls);
        if (grant) {
          appendTrail(slug, {
            v: 1,
            ts: new Date().toISOString(),
            actor: "gate",
            pane: paneId,
            task: (envSource().FM_TASK_ID ?? "").trim() || null,
            subject: sha16(command),
            cls: clsInfo.cls,
            decision: "proceed",
            scope: "grant",
            message: grant.id,
          });
          pi.appendEntry("mini-dc-log", {
            tool: event.toolName,
            input: event.input,
            rule: violation,
            mode,
            cls: clsInfo.cls,
            outcome: "proceed",
            scope: "grant",
            grantId: grant.id,
          });
          return { block: false };
        }
      }
    }

    let dialogTimedOut = false; // unanswered 180s window ≠ explicit deny (parked-resume wording below)
    let denyMessage: string | undefined;
    let dialogOutcome: DialogOutcome | null = null;
    let dialogId = ""; // park-key half; stable per ask for the leg-2 answer path
    if (ask && !isHeadless(ctx.mode)) {
      // v1.2 dialog (WP2/WP3): decision-context header + seat-bound rows. Preflight render
      // precedent: ctx.ui.* dialogs render during tool_call preflight (0.80.3-verified);
      // try/catch → block on any error (safe-fallback posture).
      const cls: DecisionClass = clsInfo ? clsInfo.cls : "G";
      const trail = slug ? readTrail(slug) : null;
      const binding = resolveTaskBinding(envSource(), trail);
      dialogId = `dlg-${process.pid}-${randomBytes(2).toString("hex")}-${Date.now().toString(36)}`;
      const headerLines = buildDecisionHeader({
        cls,
        what: sanitizeAskerText(
          isToolCallEventType("bash", event)
            ? `bash: ${command}`
            : `${event.toolName}: ${command}`,
        ) ?? `${event.toolName}: (unprintable)`,
        where:
          slug
            ? `${slug} - branch ${gitOut("branch --show-current", ctx.cwd) ?? "?"}`
            : "(outside a git repository)",
        who: whoLine(seat, binding, paneId ?? undefined),
        risk: riskLine(cls),
        purpose: sanitizeAskerText(envSource().PI_PURPOSE),
        prior: composePriorLine(trail, binding.state === "ok" ? binding.taskId : null, Date.now(), seat),
      });
      const detailLines = [
        `dialog: ${dialogId}`,
        `class: ${cls}${clsInfo ? ` (${clsInfo.why})` : ""}`,
        ...(steering ? ["steering: enumerated steering-class G (C3)"] : []),
        `matched rule: ${matchedRule?.pattern ?? violation}`,
        `seat: ${seat} · binding: ${binding.state}${binding.taskId ? ` (${binding.taskId})` : ""}`,
        `store: ${slug ? storeDirFor(slug) : "(none)"}`,
      ];
      const grantPattern = cls === "R" && slug ? deriveGrantPattern(command) : null;
      try {
        const outcome = await ctx.ui.custom<DialogOutcome>(
          (tui, _theme, _kb, done) =>
            new DecisionDialog({
              cls,
              headerLines,
              detailLines,
              options: buildDialogOptions(cls, seat, grantPattern, steering),
              timeoutMs: 180000,
              tui,
              onResult: done,
              ...(dialogClockOverride ? { clock: dialogClockOverride } : {}),
            }),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "60%",
              minWidth: 52,
              margin: 2,
            },
          },
        );
        dialogOutcome = outcome ?? { kind: "block" }; // stale-dialog no-op resolves undefined → safe No
      } catch (e) {
        ctx.ui.notify(`🛡️ mini-dc dialog error: ${String(e)}`, "error");
      }
    }

    // ── v1.2 WP3/WP4/WP5: map the dialog outcome THROUGH THE AUTHORIZATION MATRIX ──
    // F1 (2026-11-17 review): the matrix is load-bearing at the answer seam, not dead code —
    // a pane-keyed y (including a keystroke-injected one) is honored ONLY when the class ×
    // answering-seat × enumeration law allows it; refusals deny or park, never proceed.
    let matrixParkWhy: string | null = null;
    let refusedNote: string | null = null;
    if (dialogOutcome) {
      const cls: DecisionClass = clsInfo ? clsInfo.cls : "G";
      const trailTask = (() => {
        const trail = slug ? readTrail(slug) : null;
        const binding = resolveTaskBinding(envSource(), trail);
        return binding.state === "ok" ? binding.taskId : null;
      })();
      const trailAppend = (decision: TrailEntry["decision"], scope: TrailEntry["scope"], message?: string, actorOverride?: Seat | "gate"): void => {
        if (!slug) return;
        appendTrail(slug, {
          v: 1,
          ts: new Date().toISOString(),
          // Pane-keyed answers log actor=<pane-seat> honestly (F3 fallback; replaced by the
          // leg-2 surface). Timeout/auto outcomes are the gate's own [C8].
          actor: actorOverride ?? seat,
          pane: paneId,
          task: trailTask,
          subject: sha16(command),
          cls,
          decision,
          scope,
          ...(message ? { message } : {}),
        });
      };

      const answer: "proceed" | "session" | "grant" | "deny" =
        dialogOutcome.kind === "proceed"
          ? dialogOutcome.grant ? "grant" : dialogOutcome.sessionScope ? "session" : "proceed"
          : "deny";
      const verdict = resolveDecisionMatrix({ cls, answerSeat: seat, enumeratedSteering: steering, answer });

      if (verdict.allowed && dialogOutcome.kind === "proceed") {
        if (dialogOutcome.grant) {
          // Grant rows only render for R asks with a captain/firstmate answer seat (C5);
          // this seat check is the load-bearing defense — workers NEVER create (Q3).
          const created = slug
            ? createGrant({ slug, seat, pattern: dialogOutcome.grant.pattern, via: "dialog" })
            : { error: "no repository — no grant store" };
          if (!("error" in created)) {
            refreshGrantsCount(slug);
            ctx.ui.setStatus("mini-dc", statusText());
            trailAppend("proceed", "grant", created.id);
            pi.appendEntry("mini-dc-log", {
              tool: event.toolName,
              input: event.input,
              rule: violation,
              mode,
              cls,
              outcome: "proceed",
              scope: "grant-created",
              grantId: created.id,
            });
            return { block: false };
          }
          // grant creation refused (seat law) → fall through to block (never silently proceed)
        } else if (dialogOutcome.sessionScope) {
          const recorded = recordSessionScope(sessionId, matchedRule?.pattern ?? "", cls);
          if (recorded) {
            ctx.ui.setStatus("mini-dc", statusText());
            trailAppend("proceed", "session");
            pi.appendEntry("mini-dc-log", {
              tool: event.toolName,
              input: event.input,
              rule: violation,
              mode,
              cls,
              outcome: "proceed",
              scope: "session",
            });
            return { block: false };
          }
        } else {
          trailAppend("proceed", "once");
          pi.appendEntry("mini-dc-log", {
            tool: event.toolName,
            input: event.input,
            rule: violation,
            mode,
            cls,
            outcome: "proceed",
            scope: "once",
          });
          return { block: false };
        }
      }

      if (dialogOutcome.kind === "park") {
        // Timeout park (unanswered 180s window) — the original WP5 parked state.
        dialogTimedOut = true;
        trailAppend("park", "none", undefined, "gate");
        const parkKey = `${slug ?? "noslug"}::${dialogId || sha16(command).slice(0, 10)}`;
        pi.appendEntry("mini-dc-park", {
          key: parkKey,
          cls,
          tool: event.toolName,
          command: isToolCallEventType("bash", event) ? command : undefined,
          rule: violation,
          seat,
          pane: paneId,
          task: trailTask,
          session: sessionId ?? null,
          mode, // abort and continue modes BOTH emit the parked state
          steering,
          at: new Date().toISOString(),
        });
      } else if (verdict.effect === "park") {
        // Matrix-refused answer (e.g. non-enumerated G answered at any non-captain seat):
        // the pane's answer is NOT honored — the ask parks for the supervisor, never proceeds.
        dialogTimedOut = true;
        matrixParkWhy = verdict.why;
        trailAppend("park", "none", verdict.why, "gate");
        const parkKey = `${slug ?? "noslug"}::${dialogId || sha16(command).slice(0, 10)}`;
        pi.appendEntry("mini-dc-park", {
          key: parkKey,
          cls,
          tool: event.toolName,
          command: isToolCallEventType("bash", event) ? command : undefined,
          rule: violation,
          seat,
          pane: paneId,
          task: trailTask,
          session: sessionId ?? null,
          mode, // abort and continue modes BOTH emit the parked state
          steering,
          refusal: verdict.why,
          at: new Date().toISOString(),
        });
      } else if (verdict.allowed) {
        // Honored deny — the pane's block answer lands as a decision.
        denyMessage = dialogOutcome.message;
        trailAppend("deny", "none", denyMessage);
      } else {
        // Refused answer with deny effect (class D answered at a non-captain seat, D scope
        // attempts, crewmate scope attempts): blocked with the matrix why; the DECISION is
        // the gate's, not the pane's — actor=gate.
        refusedNote = `Answer refused: ${verdict.why}.`;
        trailAppend("deny", "none", verdict.why, "gate");
      }
    } else if (ask && isHeadless(ctx.mode) && slug && clsInfo) {
      // Headless ASK→deny (preserved contract) still lands a trail entry (actor=gate, evidence).
      appendTrail(slug, {
        v: 1,
        ts: new Date().toISOString(),
        actor: "gate",
        pane: paneId,
        task: (envSource().FM_TASK_ID ?? "").trim() || null,
        subject: sha16(command),
        cls: clsInfo.cls,
        decision: "deny",
        scope: "none",
      });
    }

    pi.appendEntry("mini-dc-log", {
      tool: event.toolName,
      input: event.input,
      rule: violation,
      mode,
      ...(clsInfo ? { cls: clsInfo.cls, ...(steering ? { steering } : {}) } : {}),
      ...(dialogTimedOut ? { outcome: "park" } : {}),
      ...(isHeadless(ctx.mode) ? { headlessDeny: true, askClass: !!ask } : {}),
    });

    // R2 C1 (load-bearing): headless denials settle IN-BAND — skip ctx.abort() entirely.
    // The harness delivers `reason` as the blocked tool result; the model finishes its turn;
    // output non-empty + inbandError unset → the parent's fallback walk cannot fire.
    // The `BLOCKED by mini-dc` marker is the walker's SECONDARY defense (design-v0.2 C3).
    if (isHeadless(ctx.mode)) {
      return { block: true, reason: headlessReason(violation, !!ask) };
    }

    let reason: string;
    if (dialogTimedOut && matrixParkWhy) {
      reason =
        `🛑 BLOCKED by mini-dc (parked): ${violation}. ` +
        `The pane answer was refused by the authorization matrix (${matrixParkWhy}) — ` +
        `this is a park, not a denial: the ask waits for the supervisor. ` +
        `Re-attempt the same action to raise the confirm again.`;
    } else if (dialogTimedOut) {
      reason =
        `🛑 BLOCKED by mini-dc (parked): ${violation}. ` +
        `No answer within 180s — this is a park, not a denial: ` +
        `surface a reminder to the user, then re-attempt the same action to raise the confirm again.`;
    } else if (denyMessage) {
      reason =
        `🛑 BLOCKED by mini-dc: ${violation}. ` +
        `Operator note: ${denyMessage} DO NOT work around this — tell the user.`;
    } else {
      reason = `🛑 BLOCKED by mini-dc: ${violation}. DO NOT work around this — tell the user.`;
    }
    if (refusedNote) reason += ` ${refusedNote}`;
    if (mode === "abort") {
      ctx.abort();
      return { block: true, reason };
    }
    return { block: true, reason };
  });
}

