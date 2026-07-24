# Decision 0002 — mini-damage-control hardening: fail-closed + global fallback + dispatch cwd

**Status:** IMPLEMENTED — Parts A/B/D landed 2026-07-06 (fail-closed default + global floor + bootstrap rules); Part C (`dispatch({cwd})`) landed 2026-07-07. `tsc --noEmit` clean (only a pre-existing unrelated `./tier-map.ts` import error remains). Behavioral verification: A/B/D + gated-bash BLOCK/ASK paths **verified on 0.80.3** (see `~/.sisyphus/evidence/0803-interactive-reverify-2026-07-07.md` + LR-0017 re-verify); Part C **verified 2026-07-07** — dispatched `scout` (category `quick`, `cwd=/tmp`) to read relative `cwd-marker.txt`; child returned the file's contents, proving it ran in `/tmp` (relative read resolved there, not the parent cwd). dispatch-log records `cwd=/tmp, cwdOverride=true`.
**Date:** 2026-07-06
**Blocks:** dispatch-heavy Layer-4 work (hardening must land first)
**Source finding:** LR-0018 (mini-damage-control fails open, project-scoped, cwd-inherited)
**Pi version:** 0.80.3

> **Re-verify (2026-07-16 · pi 0.80.8):** Part C (`dispatch({cwd})`) **RE-VERIFIED** — dispatched a `quick` agent with `cwd="/tmp"` to read a relative marker file; dispatch-log records `cwd="/tmp", cwdOverride=true`, proving the child ran in `/tmp` (relative read resolved there, not the parent cwd). mini-damage-control loads clean (144 merged rules reported at boot). **Still pending interactive TTY re-verify:** A/B/D behavioral paths + gated-bash BLOCK/ASK dialogs (originally verified on 0.80.3 via `~/.sisyphus/evidence/0803-interactive-reverify-2026-07-07.md`) — print mode cannot exercise `ctx.ui.select`/`ASK` rendering.

## The problem (summary of LR-0018)

Three flaws, one root cause — the safety boundary is cwd-coupled and fails open:

1. **Fails OPEN when rules file missing** — `rules` defaults to `EMPTY` (empty arrays); absent file → no rule matches → everything passes.
2. **Project-scoped only** — loads from `cwd/.pi/mini-dc-rules.yaml`; no global fallback. Every new project starts unprotected.
3. **Dispatch inherits parent cwd** — no `dispatch({cwd})` override; child's protection depends on the parent sitting in a configured project.

Net: accidental safety, not designed safety. A builder dispatched to an arbitrary target runs with zero protection by default.

## Design goals (in priority order)

1. **Fail closed** when no rules are available — a loaded safety gate that permits everything when misconfigured is worse than no gate (false confidence).
2. **Global floor + project override** — shared deny patterns (`rm -rf`, `git push --force`, `.env`) apply everywhere; projects can tighten or relax.
3. **Dispatch-aware cwd** — the orchestrator can point a child at a specific project's rules, or inherit the global floor if the target project is unconfigured.
4. **Backward-compatible for operators who relied on fail-open** — a migration flag or explicit "allow all" escape hatch, so the change doesn't silently break existing workflows.

## The spec

### Part A — Global rules fallback (mini-damage-control.ts)

Load from two locations, merge with project-overrides-global precedence:

```ts
// Resolution order (first-found wins per layer; merge global → project):
//   1. ~/.pi/agent/mini-dc-rules.yaml   (global floor — always loaded if present)
//   2. {cwd}/.pi/mini-dc-rules.yaml      (project override — merged on top)
const GLOBAL_RULES_PATH = join(os.homedir(), ".pi", "agent", "mini-dc-rules.yaml");
const PROJECT_RULES_PATH = join(ctx.cwd, ".pi", "mini-dc-rules.yaml");
```

Merge semantics:
- **`bashToolPatterns` and `zeroAccessPaths` concatenate** (global patterns + project patterns both apply). A project can ADD deny rules but cannot remove a global one (deny is additive).
- Project can set a per-rule `ask: true` to downgrade a global block to a confirm-prompt. **Cannot upgrade an allow.** (Rationale: the global floor is a minimum safety standard; projects tighten, never loosen.)
- Parse errors at either layer → **fail closed** for that layer (see Part B) + emit the existing error notify.

### Part B — Fail-closed default (mini-damage-control.ts)

Replace the `EMPTY` constant and its fail-open semantics:

```ts
// BEFORE (LR-0018 Finding 1):
const EMPTY: Rules = { bashToolPatterns: [], zeroAccessPaths: [] };
let rules: Rules = EMPTY;   // ← absent file → stays EMPTY → everything passes

// AFTER:
let rules: Rules | null = null;   // null = unloaded = DENY BY DEFAULT
let rulesSource: "none" | "global" | "project" | "merged" = "none";
```

Gate behavior when `rules === null` (no rules file found at either layer):
- **`bash` tool calls** → BLOCK with reason `"🛑 BLOCKED: mini-damage-control has no rules loaded (no global ~/.pi/agent/mini-dc-rules.yaml, no project .pi/mini-dc-rules.yaml). Add rules or disable mini-dc via --no-extensions for this run."`
- **`read`/`write`/`edit`** → allow (the zero-access tier only blocks if there are patterns to match; no patterns = no false blocks, and reads are non-destructive).

This is the safe-by-default posture: **the gate refuses to let bash through when it has no rules to evaluate against.** Operators who want the old fail-open behavior explicitly pass `--no-extensions` (acknowledging they're running ungated).

Add a status indicator that makes the state visible: `🛡️ mini-dc: 0 rules (DENY-BASH) ` vs `🛡️ mini-dc: 4+3 rules (merged)`. The current `setStatus` call already exists at line 38; extend it to surface the load state.

### Part C — `dispatch({cwd})` parameter (orchestration-engine/index.ts)

Add an optional `cwd` to the dispatch tool's parameters and pass it to the child spawn:

```ts
// index.ts — extend the tool parameters:
parameters: Type.Object({
  task: Type.String({ ... }),
  category: CategoryEnum,
  agent: Type.Optional(Type.String({ ... })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the sub-agent. Defaults to the parent's cwd. " +
      "Set this when dispatching into a specific project so the child loads that " +
      "project's mini-damage-control rules instead of the parent's."
  })),
}),
```

In `spawnSub`, pass `cwd` to the `spawn()` options:
```ts
const proc = spawn("pi", args, {
  cwd: cwd ?? process.cwd(),     // ← NEW: child inherits specified cwd, or parent's
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env },
});
```

And in the dispatch-log, record `cwd` so the audit trail shows which ruleset governed each dispatch:
```ts
pi.appendEntry("dispatch-log", { ..., cwd: cwd ?? "(inherited)" });
```

### Part D — Bootstrap a global rules file

Ship a sensible default at `~/.pi/agent/mini-dc-rules.yaml` so the fail-closed posture doesn't strand operators:

```yaml
# ~/.pi/agent/mini-dc-rules.yaml — global safety floor
# Projects can ADD rules via .pi/mini-dc-rules.yaml but cannot remove these.
bashToolPatterns:
  - pattern: '\brm\s+(-[^\s]*)*-[rRf]'
    reason: rm with recursive/force flags
  - pattern: '\bgit\s+push\s+.*--force(?!-with-lease)'
    reason: git push --force (use --force-with-lease)
  - pattern: '\bDROP\s+TABLE\b'
    reason: DROP TABLE
  - pattern: '\bgit\s+reset\s+--hard\b'
    reason: git reset --hard (loses uncommitted work)
zeroAccessPaths:
  - ".env"
  - "*.pem"
  - "~/.ssh/"
```

## Test matrix (must pass before merge)

Deterministic node tests (model removed from equation, per LR-0018 bonus finding):

| Scenario | Input | Expected |
|---|---|---|
| No rules file, bash `rm -rf` | `cwd` with no `.pi/`, no global | BLOCK (fail-closed) |
| No rules file, bash `ls` | same | BLOCK (fail-closed) |
| No rules file, `read` | same | allow (reads non-destructive) |
| Global only, `rm -rf` | global present, project absent | BLOCK (global floor) |
| Global only, `ls` | same | allow |
| Project only, `rm -rf` | global absent, project present | BLOCK (project rules) |
| Merged, `rm -rf` | both present | BLOCK (concatenated) |
| Merged, project-downgrade | global block + project `ask: true` on same pattern | PROMPT (ask) |
| Merged, project-cannot-allow | global block + project attempts to remove | still BLOCK (deny additive) |
| Parse error in global | malformed global yaml | BLOCK bash + error notify |
| Parse error in project only | malformed project, valid global | global rules apply + error notify |

Live dispatch tests (TTY):

| Scenario | Expected |
|---|---|
| `dispatch({task:"rm -rf /tmp/x", agent:"builder", cwd:"/fresh/project"})` | child BLOCKS (no rules → fail-closed) |
| same, with global rules file present | child BLOCKS (global floor) |
| `dispatch({task:"ls /tmp", agent:"builder", cwd:"/fresh/project"})` no rules | child BLOCKS (fail-closed) — operator must `--no-extensions` or add rules |

The last row is the behavior change operators must understand: **fail-closed means bash is denied until configured, not until proven safe.** Document this in the README.

## Migration note (for operators who relied on fail-open)

The old behavior: load mini-damage-control globally, projects without rules just run ungated. The new behavior: same load, but bash is denied in unconfigured projects.

Operators who depended on fail-open have three paths:
1. **Add a global rules file** (recommended — Part D ships a sensible default). One-time setup; every project then has the floor.
2. **Accept deny-by-default** and configure projects as needed. The honest posture.
3. **Opt out per-dispatch** via `--no-extensions` when they intentionally want ungated bash (e.g., a trusted build script). Explicit, not silent.

This is a breaking change in the "loaded but unconfigured" case. It's the right break — fail-open safety is the bug being fixed. Document in the changelog when the hardening lands.

## Out of scope (deferred)

- **Per-agent rulesets** (e.g., archivist gets path-write rules, builder gets build-cmd rules) — orthogonal; the merged global+project model covers the MVP. Revisit if persona-specific rules become a real need.
- **Rule syntax extension** (glob patterns beyond regex, command-arg parsing) — the current regex model works and matches the AGENTS TOML grammar (LR-0014 convergence). No need to invent new syntax.
- **Hot-reload of rules mid-session** — reload via `/reload` is sufficient for now; the gate re-reads on session_start.

## Implementation order

1. Part B (fail-closed) + tests — the safety fix, lands first, blocks nothing.
2. Part A (global fallback) + Part D (bootstrap file) — removes the "stranded operator" pain from Part B.
3. Part C (dispatch cwd) — enables correct per-project protection for dispatched agents.
4. Update `mini-damage-control.ts` header comment + README to document the fail-closed posture.

Estimated: 1 focused session for B+A+D+tests, 1 for C+dispatch-log+tests. Not large.
