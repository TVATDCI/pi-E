# Improvement Plan v1 — pi agent system

> **⚠ v1.1 AMENDMENTS (2026-07-28) — AUTHORITATIVE.** Five operator scope-honesty probes
> supersede specific clauses. Read the **Amendments v1.1** section at the end of this file
> as current for: **D1** verification + failure-mode (probe 3), **D2** scope + failure-mode
> (probe 2), **D3** ENTIRE SECTION (probe 1), **D6** growth-policy addition (probe 5),
> **Self-audit (b)** re-scoring (probe 4). All other v1 text stands.

Input: `architecture-audit-2026-07-28.md` + 3 review layers (operator, third reviewer,
Oracle deep-read). All four converged on one root cause:

> **The composed system prompt is the single artifact that defines behavior, and it is
> simultaneously (a) mutated at runtime by 5 independent parties, (b) hand-restated in the
> `dispatch` description, (c) implicitly vocabulary-frozen, and (d) untested at the
> composition seams.** Every top finding is this problem wearing different clothes.

**Prescription:** prompts graduate from runtime strings to **build-time artifacts** — typed,
ordered, hashed, snapshot-tested, and generated from the code that is their source of truth.

All file paths/line counts below are **verified against source** (2026-07-28). No invented
structure.

---

## D1 — Prompt composition: typed fragments + deterministic order

### Target files (current line counts, verified)
| File | Lines | Role |
|---|---|---|
| `extensions/bd-bridge.ts` | 169 | contributor (1 mutation site) |
| `extensions/memory/index.ts` | 173 | contributor (1 mutation site) |
| `extensions/mini-purpose-gate.ts` | 126 | contributor (1 mutation site) |
| `extensions/orchestration-engine/index.ts` | 500 | contributor (1 mutation site) |
| `extensions/session-notes.ts` | 133 | contributor (1 mutation site) |
| `extensions/prompt-builder.ts` | **NEW** | the builder + registry |
| `extensions/prompt-flush.ts` | **NEW** | the single flusher (see Failure mode) |

### Current state (the 5 named mutation sites — all verified)
Each independently does `pi.on("before_agent_start", …)` and returns a re-chained
`event.systemPrompt + <its block>`. Order = pi's extension **load order** (deterministic
per version, **not contractually guaranteed**). There is no declared priority, no hash, no
snapshot test.

| # | Extension | handler line | mutation line | appends |
|---|---|---|---|---|
| 1 | `bd-bridge.ts` | `:127` | `:167` | `"\n\n" + header + "\n" + block` (bridged facts) |
| 2 | `memory/index.ts` | `:57` | `:72` | `"\n\n" + result.block` (`<memory-context>`) |
| 3 | `mini-purpose-gate.ts` | `:107` | `:110` | `…+ "\n\n<purpose>…"` |
| 4 | `orchestration-engine/index.ts` | `:245` | `:247` | `"\n\n## Cost Discipline\n…"` |
| 5 | `session-notes.ts` | `:124` | `:126` | `"\n\n## Session notes\n…"` |

### Proposed change (diff sketch)
A shared, pure builder. Each contributor stops returning `systemPrompt` and instead
**contributes a typed fragment** (refreshed per turn, since bd-bridge/memory re-read their
stores each turn). One flusher assembles in **declared priority order** and is the sole
writer of the final prompt.

```ts
// extensions/prompt-builder.ts  (NEW)
export type Slot = "governance" | "memory" | "focus" | "discipline" | "notes" | "bridge";
export interface Fragment { slot: Slot; priority: number; content: string; source: string; }
const reg: Fragment[] = [];
export function contribute(f: Fragment): void {           // idempotent per {slot,source}
  const i = reg.findIndex(x => x.slot === f.slot && x.source === f.source);
  if (i >= 0) reg[i] = f; else reg.push(f);                // per-turn refresh overwrites
}
export function buildFragments(base: string): { prompt: string; hash: string; order: string[] } {
  const sorted = [...reg].sort((a, b) => a.priority - b.priority || a.slot.localeCompare(b.slot));
  const order = sorted.map(f => `${f.slot}:${f.source}`);
  const prompt = base + sorted.map(f => `\n\n${f.content}`).join("");
  const hash = sha256(prompt).slice(0, 16);                // stable, content-addressed
  return { prompt, hash, order };
}
```

Each contributor changes from:
```ts
pi.on("before_agent_start", async (event) => {
  …
  return { systemPrompt: event.systemPrompt + "\n\n" + result.block };   // memory/index.ts:72
});
```
to:
```ts
pi.on("before_agent_start", async () => {
  const result = buildInjection(await store.snapshot({ scopes: ["global"] }));
  if (result.block) contribute({ slot: "memory", priority: 20, content: result.block, source: "memory" });
  // NOTE: returns nothing — does NOT touch event.systemPrompt
});
```

One flusher (`extensions/prompt-flush.ts`, loaded **last** — see Failure mode) is the only
handler that returns a prompt:
```ts
pi.on("before_agent_start", async (event, ctx) => {
  const { prompt, hash, order } = buildFragments(event.systemPrompt);
  pi.appendEntry("prompt-composition", { hash, order });   // D4-signal-1 rides this
  return { systemPrompt: prompt };
});
```

**Declared priority table** (replaces implicit load order):
`governance(10, AGENTS.md-base)` → `focus(15, purpose)` → `bridge(18, bd)` → `memory(20,
mem-context)` → `discipline(40, cost)` → `notes(50, session-notes)`.

### Dependencies
None. **D1 is the critical path** — unblocks D2 (generator produces a fragment through the
same builder) and D4-signal-1 (the hash).

### Verification
1. **Golden snapshot test per extension combination**: a `prompt-builder.test.ts` that
   registers a fixed fragment set and asserts `buildFragments()` output + hash. Any
   contributor/priority change updates the golden intentionally (reviewed diff).
2. **Order-drift detector**: a test that boots the real 5 extensions and asserts
   `buildFragments().order` equals the declared-priority order — **fails if pi's load order
   stops matching declared priority** (this is the drift net for the residual dependency).
3. **Hash logged at session start** via the `prompt-composition` entry (D4-s1).

### Rejection criteria (when NOT to apply)
- If pi ships a native `before_agent_start` **priority/weight** field in a future version,
  adopt it and delete the flusher — do not maintain a parallel ordering layer.
- Do NOT use D1 to centralize prompt *content* authoring (e.g., move AGENTS.md text into
  code). The builder orders and hashes; it does not own prose. AGENTS.md stays a file.

### Failure mode if done WRONG
- **A contributor forgets to migrate** and keeps returning `event.systemPrompt + X`
  directly. It now bypasses the builder → its block lands at an arbitrary position AND the
  hash excludes/cludes it inconsistently → **silent prompt corruption**. *Mitigation:* the
  order-drift test asserts the fragment set is complete (every declared `source` present); a
  stray direct-mutator is caught because the hash won't match any golden.
- **Two flushers registered**, or the flusher loaded before a contributor → stale fragment
  for that turn. *Mitigation:* flusher is a dedicated file; a test asserts exactly one
  `before_agent_start` returns `systemPrompt` (grep-enforced lint).
- **Residual ordering dependency:** the flusher must run after all contributors in the same
  fan-out. Today that holds because contributors return `undefined` (no chained mutation)
  and the flusher is loaded last. The hash + order-drift test make this **detectable**, not
  eliminated — that is the honest boundary.

---

## D2 — Dispatch description generated from tier-map.ts

### Target files (current)
| File | Lines | Role |
|---|---|---|
| `extensions/orchestration-engine/tier-map.ts` | 334 | **sole source of truth** |
| `extensions/orchestration-engine/agent-map.ts` | 23 | category→default-agent map |
| `extensions/orchestration-engine/index.ts` | 500 | hand-maintained description (`:257–265`) |

### Current state (verified)
The `dispatch` tool description at `orchestration-engine/index.ts:257–265` is a hand-typed
string that **restates** `TIERS` (`tier-map.ts:129`), the category→model list, the
`0 of 14 agents pin a model` invariant, and the `quick→keymaker…` functional-agent defaults
(sourced from `agent-map.ts:resolveFunctionalAgent`). Changing `TIERS` does NOT change the
description → the LLM routes on stale guidance. This is the silent routing-drift class
flagged in Report 1.

### Proposed change (diff sketch)
Add a pure generator in tier-map (it already exports `listTiers()` at `:323` — extend the
pattern). Description is computed, not typed.

```ts
// tier-map.ts — add:
export interface AgentDefault { category: TaskCategory; agent: string; }
export function describeTiers(defaults: AgentDefault[]): string {
  const rows = (Object.keys(TIERS) as TaskCategory[]).map(c => {
    const t = TIERS[c];
    return `${c} (${t.provider}/${t.id}${t.fallbackId ? ` → fb ${t.fallbackProvider}/${t.fallbackId}` : ""})`;
  });
  const def = defaults.map(d => `${d.category}→${d.agent}`).join(", ");
  return `Categories (tier-map.ts is authoritative): ${rows.join(", ")}. ` +
         `${defaults.length - 0} agents pin a model — category is the sole model authority. ` +
         `Defaults: ${def}. One focused objective per dispatch.`;
}
```
```ts
// index.ts:255-265 — replace the literal string with:
import { describeTiers } from "./tier-map.ts";
import { FUNCTIONAL_DEFAULTS } from "./agent-map.ts";   // expose the map, not just the resolver
…
description: describeTiers(FUNCTIONAL_DEFAULTS),
```

### Dependencies
**D1** (the description can optionally be contributed as a `discipline`-adjacent fragment,
but generation itself is independent — D1 only matters if you want the generated text in the
*composed* prompt rather than the tool schema). Pragmatically D2 can ship without D1, but is
scheduled after it so the generator plugs into the builder convention.

### Verification
1. **Generator is pure** → unit-test `describeTiers()` against a golden string; any TIERS
   edit that changes output produces a reviewed golden diff.
2. **Invariant test:** the categories/models in the generated string exactly equal the keys
   of `TIERS` and the entries of `FUNCTIONAL_DEFAULTS` (asserts no hand-restatement can
   drift).
3. Boot assertion: `dispatch` tool schema `description` field contains every category name
   present in `TIERS`.

### Rejection criteria
- Do NOT generate the *tool parameter schema* (the `CategoryEnum` union at
  `index.ts:46–49`) from prose — that must stay a typed union. Only the human-readable
  `description` is generated.
- Do NOT inline agent persona descriptions into the dispatch description (scope creep into
  persona-authoring); keep it to tier routing + defaults.

### Failure mode if done WRONG
- Generator produces a **stale closure** over `TIERS` (e.g., captures a snapshot at
  module-eval and TIERS is later mutated) → drift returns, now harder to spot because "it's
  generated." *Mitigation:* `describeTiers()` reads `TIERS` fresh on each call (pure
  function over the live export, not a captured copy); the invariant test compares against
  the live `TIERS` keys.
- Generator formats model names with a typo/class (`glm-5.2` vs `glm5.2`) → the LLM sees
  garbage. *Mitigation:* the string is built from `t.provider+"/"+t.id` (same construction
  `resolveModel` uses at `:255`), never hand-typed.

---

## D3 — Verification default for delegated results

### Target files (current)
| File | Lines | Role |
|---|---|---|
| `extensions/orchestration-engine/spawn.ts` | 350 | builds the dispatch result + `dispatch-log` (`:322`) |
| `extensions/orchestration-engine/index.ts` | 500 | `dispatch.execute()` return shape (`:300–310`) |
| `AGENTS.md` | — | prompt-level "treat every delegated result as unverified" rule |
| `extensions/orchestration-engine/index.ts` (Cost Discipline block) | `:245–247` | the prompt rule carrier (becomes a D1 fragment) |

### Current state (verified)
AGENTS.md states the discipline in prose; **nothing enforces it**. `dispatch.execute()`
returns the sub-agent's output text + `details` (`:300–310`) with **no `verified` field**.
The implicit model behavior is "trust the summary." Rework (re-dispatching because the first
result was wrong) is invisible and unmeasured → the delegation ROI term is poisoned.

### Proposed change (diff sketch)
Make verification a **structured, default-on** property of every dispatch result, surfaced
to the model and measurable. Two settings; conservative auto-verify.

```ts
// spawn.ts — extend SpawnResult:
export interface SpawnResult {
  …
  verified: boolean;          // NEW: false until a check passes
  claims?: { files: string[]; tests: string[] };  // NEW: extracted from output (best-effort)
}

// index.ts dispatch.execute() return:
return {
  content: [{ type: "text", text:
    `[${category} → ${modelFlag}] … ${result.verified ? "" : "⚠ UNVERIFIED — re-check before acting"}\n\n${trimmed}` }],
  details: { …, verified: result.verified, claims: result.claims },
};
```

**Policy toggle** (default changes):
- `settings.json`: `dispatch.assumeVerified` — **default `false`** after ship (was: no
  field = implicitly trusted). This is the default change the prescription requires.
- Optional per-call `verify: "readback" | "none"` param. `readback` re-reads (read-only,
  cheap) every path in `claims.files` and flips `verified=true` only if each exists.
  `none` = skip (trust). Default honors the global setting.

**Enforcement** (prompt-level, now structured): the Cost-Discipline fragment (a D1
`discipline`-slot fragment) carries a HARD rule:

> Any dispatch result whose `details.verified === false` MUST be independently re-checked
> (re-read the claimed files / re-run the claimed tests) BEFORE you act on it, report it as
> done, or chain it. Do not relay an unverified result as fact.

### Dependencies
None for the default flip. **D4-signal-3 (rework rate) depends on D3** — the `verified`
flag + task-hash reuse is how rework is measured. D3 must ship before any D4 measurement is
acted on.

### Verification
1. Unit test: a mock sub-agent returning a claimed file path; `verify:"readback"` flips
   `verified` true iff the file exists; missing file leaves it false.
2. Integration: a real dispatch with a deliberately-wrong claim returns
   `verified:false` and the result text carries the ⚠ marker.
3. The rework metric (D4-s3) moves from undefined → defined once this lands.

### Rejection criteria
- **Do NOT auto-run tests in `verify`** (flaky, slow, may mutate state, scope creep into a
  test-runner). `verify` is read-only readback of explicitly-listed file paths only.
- Do NOT make `verified` a tool_call *block* (hard-gating the parent's next action). That
  couples dispatch to a gate and breaks legitimate "decide later" flows. The default is a
  **structured prompt obligation**, not a hard block.
- Do NOT extract `claims` with an LLM/regex black box beyond "files mentioned / test
  commands mentioned" — keep claim-extraction conservative and best-effort; false-verified
  is worse than false-unverified.

### Failure mode if done WRONG
- **`verify:"readback"` flips `verified=true` when a file merely *exists***, not when the
  sub-agent's claimed *content* is correct → the parent trusts a result that touched the
  wrong file. *Mitigation:* `readback` proves *existence*, never *correctness*; the marker
  text and the prompt rule say "re-check," and the `verified=true` semantics are documented
  as "claim read back, not validated." Honest framing, not false assurance.
- Default ships `assumeVerified:true` (preserving old behavior) "to be safe" → the whole
  point (poisoned ROI term) is lost. *Mitigation:* the default flip is the deliverable; ship
  `false` and accept the transition noise.

---

## D4 — 5-signal minimum instrumentation set

**Add ONLY these five.** Everything else in this section's prose is a *declined* addition.

### Target files (current)
| File | Lines | Role |
|---|---|---|
| `extensions/orchestration-engine/routing-stats.ts` | 204 | existing aggregator (extend, don't re-instrument) |
| `extensions/orchestration-engine/spawn.ts` | 350 | writes `dispatch-log` (`:322`) — data already present |
| `extensions/orchestration-engine/index.ts` | 500 | `/routing-stats` command (`:412`), `/tiers` (`:467`) |

### Current state (verified)
`dispatch-log` already records: `category`, `modelFlag`, `source` (`spawn.ts:263` =
`tier-map|persona-override|downshift-unavailable|downshift-exhausted`), `downshiftedFrom`
(`:334`), `outcome`, `task.slice(0,200)` (`:336`), `usage`. `routing-stats.ts` already
groups by category (`:81`), model (`:124`), agent (`:144`), source (`:184`) and emits
downshift (`:192`) + exhausted (`:195`) **global** flags. **Most of the data exists; D4 is
surfacing + cross-tab, not re-instrumentation.**

### The 5 signals
1. **Prompt-hash per session start** — rides D1's `prompt-composition` entry (hash + order).
   Closes the Report-4 deduction ("composed prompt not logged"). *Dep: D1.*
2. **Fallback rate per category** — cross-tab `category × source` where source ∈
   `{downshift-unavailable, downshift-exhausted}` over total, added to `routing-stats.ts`.
   Data is in `dispatch-log`; **no new instrumentation**. This is the silent-degradation
   signal (blind spot #3). *Dep: none.*
3. **Delegation rework rate** — a dispatch whose `task` hash matches a prior dispatch's hash
   within N turns AND the prior had `verified:false` counts as redone. Surfaced as
   `accepted-as-is vs redone`. *Dep: D3 (needs `verified` flag).*
4. **Per-agent invocation count + last-used timestamp** — `byAgent` view already counts
   (`:144`); add `lastUsedAt` (max `recordedAt` per agent). Surfaced in `/routing-stats`.
   *Dep: none.*
5. **Chain context-truncation events** — `chain-runner.ts` already truncates inter-step
   input (`STEP_INPUT_MAX=20000`, W6) but does **not log it**. Add an `appendEntry` when
   truncation fires. This is a **correctness boundary**, not a metric — it tells you a chain
   step may have operated on truncated input. *Dep: none.*

### Proposed change (sketch)
- `routing-stats.ts`: add a `byCategoryFallback` cross-tab (group entries by category,
  within each compute `downshifts/total`), emit a flag when any category's fallback rate >
  threshold. Reuse the existing `group()` helper.
- `chain-runner.ts`: at the `STEP_INPUT_MAX` branch, `pi.appendEntry("chain-truncation",
  { chain, step, inputLen, capped })`.
- `spawn.ts`: include `recordedAt` (already implicit via log append order) → expose
  `lastUsedAt` in the by-agent view.

### Dependencies
s1 → D1. s3 → D3. s2, s4, s5 → none (independent, ride existing log).

### Verification
- s2: a test `dispatch-log` fixture with 2/5 downshifts in `deep` → asserts `deep` fallback
  rate = 40% and a flag fires.
- s5: a chain whose step-1 output > 20000 chars → asserts a `chain-truncation` entry is
  written exactly once.
- All signals surfaced read-only via `/routing-stats` (no new commands, no UI).

### Rejection criteria — instrumentation NOT to add (named & declined)
- ❌ **Latency dashboards** — dispatch already logs `elapsedMs`; a dashboard invites
  optimization theater, not decisions.
- ❌ **Model-utilization heatmaps** — derivable from `byModel`; standing infra for a
  one-time question.
- ❌ **Token-cost-per-category attribution** — `usage` is in the log, but per-category cost
  attribution invites ROI-gaming and the operator explicitly rejected it.
- ❌ **ROI benchmarking as standing infrastructure** — poisoned by the unverified-results
  term until D3 ships; even after, it's a periodic analysis, not always-on.
- ❌ **Memory-growth graphs** — `rotate-memory-md.ts` bounds growth operationally; a graph
  doesn't change the bound.
- ❌ **Real-time dashboard UI** — pi is a TUI agent, not a metrics platform; `/routing-stats`
  is sufficient.
- *Temptation to name & decline:* **prompt-diff visualization** (a "what changed in the
  composed prompt" viewer). Declined — the hash + golden snapshot is enough; a diff UI is
  scope creep that nudges toward prompt-churning.

### Failure mode if done WRONG
- Adding signal #2 as a **new instrumentation point** in `spawn.ts` instead of a cross-tab
  in `routing-stats.ts` → duplicated data, two sources of truth for "did it downshift."
  *Mitigation:* the rule is "aggregate from `dispatch-log`, never re-log"; a test asserts
  `spawn.ts` adds no new appendEntry for fallback (the existing one suffices).
- Treating #5 (truncation) as a *metric* and computing rates → it's a **correctness event**,
  not a number; a single truncation in a reasoning chain may be load-bearing. *Mitigation:*
  surface as discrete events, never averaged.

---

## D5 — YAML deny/allow merge as versioned security boundary

### Target files (current)
| File | Lines | Role |
|---|---|---|
| `extensions/mini-damage-control.ts` | 408 | `loadRulesLayer` + `mergeRules` (rules: bash patterns, zeroAccess, readOnly) |
| `extensions/orchestration-engine/index.ts` | 500 | `loadTeamsLayer` + `mergeTeams` + `normalizeTeamsFile` (roster → spawned agents) |
| `extensions/chain-runner.ts` | 188 | `loadChainsLayer` + `mergeChains` + `normalizeChainsFile` (steps → spawned agents) |
| `extensions/security/yaml-merge.ts` | **NEW** | the extracted, versioned boundary primitive |

### Current state (verified — NOT a refactor)
Three near-identical merge implementations, each loading a global file + a project file and
concatenating deny arrays additively. **This is a security boundary, not duplicated code:**
for teams and chains, the merged result decides **which agent files get spawned** (i.e.,
which code runs); for rules, it decides **what bash is allowed**. Today the invariant
("project can ADD, never REMOVE a global deny") is enforced independently in 3 places with
no shared version/schema — a regression in any one is a containment hole.

### Proposed change (sketch)
Extract the **merge primitive**, not a unified schema. The three schemas (rules / teams /
chains) stay distinct; only the load+deny-additive+version logic is shared.

```ts
// extensions/security/yaml-merge.ts  (NEW)
export const MERGE_SCHEMA_VERSION = 1;
export interface MergeResult<T> { data: T | null; source: "none"|"global"|"project"|"merged"; schemaVersion: number; }

export function denyAdditiveMerge<T>(opts: {
  globalPath: string; projectPath: string;
  parse: (raw: unknown) => T | null;          // null on missing/parse-error (fail-closed layer)
  empty: T;
  addInto: (acc: T, layer: T) => void;        // mutates acc — MUST only append, never remove
}): MergeResult<T> { /* load both, addInto(global) then addInto(project), version+source */ }
```
Each call site shrinks to a typed `denyAdditiveMerge({ parse, empty, addInto })` invocation
that preserves: global layer always present; project only appends; parse-error ⇒ null layer
(fail-closed); bash-pattern first-match-wins ordering preserved (rules-specific `addInto`
concatenates arrays in order).

**Versioning:** every merged result carries `schemaVersion`. An ADR records that the merge
is the containment primitive and that future out-of-tree extension trust keys off this
version + signature.

### Dependencies
Independent. Parallelizes with D6.

### Verification
1. **Invariant tests** (the security contract): (a) project layer cannot remove a global
   deny rule — seed a global bash block, add a project layer, assert the global block still
   fires; (b) parse-error in the project layer ⇒ null project layer (fail-closed), global
   still applied; (c) project can add a new deny.
2. **Regression parity:** each of the 3 call sites produces byte-identical merged output to
   its pre-extraction behavior (golden fixtures).
3. The version field is present on every merged result.

### Rejection criteria
- **Do NOT unify the three schemas** into one `MergedConfig` mega-type. They are different
  shapes (rules vs rosters vs pipelines). Extract the *primitive*, keep 3 schemas.
- Do NOT add "project can downgrade block→ask" as a generic feature — that's a rules-
  specific behavior (`mini-dc-rules.yaml` comment); keep it in the rules `parse/addInto`,
  not in the primitive.
- Do NOT wire an out-of-tree trust/signature system in this deliverable — versioning the
  schema is the *prerequisite*, not the trust story.

### Failure mode if done WRONG
- **Extracting a *generic* merge that lets project *replace* global arrays** (e.g.,
  `addInto` does `acc.rules = layer.rules`) → a project `.pi/mini-dc-rules.yaml` silently
  removes a global safety rule → **containment breach**. *Mitigation:* `addInto` is
  append-only by contract; the invariant test (project cannot remove global deny) fails the
  build on any such regression.
- **Normalizing away rules-specific ordering** (bash patterns are first-match-wins) → the
  `rm -rf` block stops preceding the `rm -f` ask → wrong severity fires. *Mitigation:* rules
  `addInto` concatenates `[...global, ...project]` preserving order; parity golden test
  catches reordering.

---

## D6 — Upstream-API adapter shim

### Target files (current)
| File | Lines | Role |
|---|---|---|
| `extensions/mini-damage-control.ts` | 408 | the 0.80.3 `ctx.ui.confirm→ctx.ui.select` patch (documented at file top + `:190–210`) |
| `extensions/mini-task-tracker.ts` | 302 | the 0.79.9→0.80.x `input.source` regression guard (`:255–265`) |
| `extensions/upstream-adapter.ts` | **NEW** | the shim |

### Current state (verified)
Two runtime seams have already broken across minor bumps and been patched *in place*, with
version-scoped comments:
1. **`ctx.ui.confirm` does not render during `tool_call` preflight on 0.80.3** →
   `mini-damage-control.ts` switched the ASK branch to `ctx.ui.select` + a hand-built
   `SafetyConfirmDialog` via `ctx.ui.custom`.
2. **`input` event `source` field** changed semantics 0.79.9→0.80.x (the nudge's own
   `sendMessage({triggerTurn})` now fires `input` with `source:"extension"`) →
   `mini-task-tracker.ts` filters on `event.source === "interactive"` to avoid an infinite
   nudge loop.

Each patch lives where the symptom appeared. The next minor bump that touches either seam
will require re-finding both.

### Proposed change (sketch)
One local interface + adapter; call sites depend on the **local** type, never the upstream
type directly for these surfaces.

```ts
// extensions/upstream-adapter.ts  (NEW)
export interface UiAdapter {
  confirmDialog(ctx: Ctx, message: string): Promise<boolean>;   // tries confirm, falls back to select/custom
  promptInput(ctx: Ctx, question: string, placeholder?: string): Promise<string | undefined>;
}
export function isHumanTurn(event: { source?: string }): boolean { return event.source === "interactive"; }
export function makeUiAdapter(ctx: Ctx): UiAdapter { /* probe ctx.ui shape once; cache */ }
```
- `mini-damage-control.ts`: the ASK branch calls `adapter.confirmDialog(ctx, violation)`.
- `mini-task-tracker.ts`: the `input` handler calls `isHumanTurn(event)`.

A version probe at adapter construction logs which upstream path is active
(`"confirm"|"select-fallback"|"custom"`), so a bump that silently changes behavior shows up
in the `prompt-composition`-adjacent startup log.

### Dependencies
Independent. Parallelizes with D5.

### Verification
1. **Adapter tests** that inject a fake `ctx.ui` exposing only `confirm` (asserts confirm
   path) and one exposing only `select`/`custom` (asserts fallback) → the shim's branching
   is unit-tested independent of the live runtime.
2. `isHumanTurn` test: `{source:"extension"}` ⇒ false; `{source:"interactive"}` ⇒ true.
3. A startup log line names the resolved adapter path.

### Rejection criteria
- **Do NOT shim surfaces that haven't broken.** Only `ctx.ui.confirm/select/custom`,
  `ctx.ui.input`, and `input.source`. Shimming `registerTool`/`appendEntry`/`setWidget` is
  premature abstraction (they're stable, widely used).
- Do NOT make the adapter a full "pi SDK polyfill" with its own version matrix — it's a
  thin local interface with a probe, not a compatibility layer spec.
- Do NOT hide the upstream type entirely from *new* code; only the two patched seams route
  through the adapter.

### Failure mode if done WRONG
- **Leaky shim:** the adapter re-exports the upstream `ExtensionContext` type in its
  signature → callers still compile-depend on the runtime type → a bump still breaks them.
  *Mitigation:* the adapter declares a **local** `Ctx` slice (only the fields it uses);
  the upstream type is referenced only inside `upstream-adapter.ts`.
- **Probe mis-detection** (e.g., feature-sniffing `ctx.ui.confirm` by typeof that's truthy
  even when it silently no-ops, as on 0.80.3) → the shim picks the broken path. *Mitigation:*
  the probe preferentially uses `ctx.ui.custom`/`select` (the paths proven to render during
  preflight), and the startup log makes the choice auditable.

---

## D7 — Sequenced plan (dependency graph + schedule)

### Dependency graph
```
        D1 (prompt builder) ──────┬──► D2 (generated dispatch desc)
   [critical path]               └──► D4-s1 (prompt hash)

        D3 (verification default) ─────► D4-s3 (rework rate)

        D5 (yaml-merge boundary) ┐
        D6 (upstream adapter)    ┴── independent, parallel, no dep on D1/D3

   D4-s2, s4, s5 ── independent (ride existing dispatch-log / chain-runner)
```
Hard ordering rules:
- **D1 first** — unblocks D2 and D4-s1; everything that makes the prompt a build-time
  artifact depends on it.
- **D3 before any D4 measurement is acted on** — s3 (rework) is meaningless without the
  `verified` flag; acting on a poisoned ROI term is worse than no metric.
- **D5 ∥ D6** — independent; land in the same wave.

### Schedule (4 waves; D1 is the critical path)
| Wave | Items | Rationale | Gate to next |
|---|---|---|---|
| **W1 — foundation** | **D1** + **D6** + **D5** (parallel) | D1 establishes the artifact model; D5/D6 are independent boundaries that don't block it. | D1 golden + order-drift tests green; D5 invariant tests green; D6 adapter tests green. |
| **W2 — rides D1** | **D2** + **D4-s1** (prompt hash) | Both consume the builder. | Generated-desc invariant test green; prompt hash logged on session start. |
| **W3 — verification default** | **D3** | Flip the default; structured prompt obligation. | Dispatch results carry `verified`; ⚠ marker present when false. |
| **W4 — measurement (gated on D3)** | **D4-s3** + **D4-s2, s4, s5** | s3 needs D3; s2/s4/s5 independent but batched. | `/routing-stats` shows fallback-rate-per-category + rework rate + per-agent lastUsed; chain-truncation entries logged. |
| **Canary (after W1 stabilizes)** | `statusline-encom.ts` review | Explicitly deferred — it's the D1 confidence canary. | n/a |

**Smallest safe first commit:** D1 alone (W1 minus D5/D6) is shippable and immediately
makes the composed prompt a hashed, ordered, tested artifact — the root-cause fix in
isolation.

---

## Explicit non-goals (declined, with reasons)

| Declined | Why |
|---|---|
| **Touch `statusline-encom.ts` (877 lines)** | It is the **confidence canary** for D1 — if the prompt-builder refactor is clean, the statusline (the most indirect-of-effect, largest file) should still render unchanged. Scheduled *after* D1 ships, not before. Touching it now defeats the canary. |
| **Consolidate the 3 memory substrates** (`memory.md` + `store.jsonl` + bridge) | Different risk class. The unifying frame here is the **composed prompt**, not memory topology. Consolidation is a separate, larger effort with its own data-loss risk; out of frame for v1. |
| **Give sub-agents / reviewers the composed prompt or memory** | Sub-agents run `--no-extensions` by design (clean context, can't pollute parent). Fresh-context reviewer rebuild is acknowledged but is an *intentional* isolation property, not a defect in frame. |
| **Extract the widget-Map+tick lifecycle** | It is duplicated *code*, not a behavioral/security boundary. Lower leverage than the yaml-merge extraction (D5), which IS a boundary. Deferred — not declined forever, just not v1. |
| **Unify the 3 YAML schemas** | Different shapes (rules/rosters/pipelines). D5 extracts the *primitive*, not a unified model. |
| **Auto-run tests in D3 `verify`** | Flaky, slow, may mutate state. D3 `verify` is read-only readback of claimed file paths only. |
| **Any instrumentation beyond the 5 signals** | Latency dashboards, utilization heatmaps, per-category cost attribution, standing ROI infra, memory-growth graphs, real-time dashboard UI — all explicitly rejected (see D4). |
| **Dead-file cleanup** (`footer-status.ts.disabled`, `hello-status.ts.disabled`, `statusline-encom.PLAN.md`, `test-web-research.ts`) | Trivial, no behavioral risk. Fold into the D5 PR as a janitorial line, not a deliverable. |

---

## Self-audit

### (a) Original 4-report findings this plan does NOT address
| Finding (Report 1/4) | Status | Justification |
|---|---|---|
| `statusline-encom.ts` 877 lines (R1) | **Deferred** | Confidence canary for D1; scheduled after D1 ships. |
| 3 memory substrates / 2 taxonomies in one prompt (R1, R2) | **Deferred** | Out of frame — the unifying frame is the prompt artifact, not memory consolidation. Separate effort. |
| Fresh-context reviewers re-derive context (R2) | **Deferred** | Intentional `--no-extensions` isolation; not a defect this frame fixes. |
| widget-Map+tick duplication (R1) | **Deferred** | Code dup, not a boundary; lower leverage than D5. |
| Dead/disabled files (R1) | **Folded into D5 PR** | Trivial; not a deliverable slot. |
| `persona-forge.ts` re-declaring teams schema (R1) | **Not addressed** | Minor drift; would be fixed as a side-effect of D5 if persona-forge adopts the merge primitive, but not required by v1. |

### (b) Scoring moves after this plan ships (touched dimensions only)
| Dimension | Now | After | Why |
|---|---|---|---|
| Testability | 7 | **8** | D1 golden + order-drift tests cover the composition seam; D5 invariant tests cover the merge seam; D6 adapter tests cover the UI seam. The 7→8 is conservative: seams are now *tested*, not eliminated (the blind spot was testing the part that doesn't break). |
| Coupling | 7 | **8** | D1 replaces implicit load-order with declared priority; D2 kills the description↔tier-map mirror; D6 centralizes the upstream-type dependency. |
| Simplicity | 6 | **7** | D5 collapses 3 merge impls → 1 primitive; D2 removes hand-restated prose. Offset by new builder/adapter files, hence +1 not +2. |
| Observability | 9 | **10** | D4 adds prompt-hash (closes "composed prompt not logged"), fallback-rate-per-category, rework rate, lastUsed, truncation events. The 9→10 closes the exact deduction. |
| Failure Isolation | 8 | **9** | D3 default-on `verified` + D4-s2 per-category fallback rate directly address blind spot #3 (silent degradation scored as detectability, not just containment). |
| Cognitive Efficiency | 6 | **7** | Named fragments + generated description lower the mental model the operator/agent must hold. |
| Evolvability | 8 | **9** | D6 stops version-scattered patches; D5 versions the merge boundary; D1 gives prompts a stable contract. |

**Untouched (do not re-score):** Cohesion 8, Reliability 9, Cost Efficiency 9.

**Composite: 77 → 84** (8+8+7+10+9+9+8+9+7+9). Conditional on the plan shipping; the gains
are concentrated exactly where the 4 review layers said the risk lived (seams, coupling,
silent degradation, observability of the prompt artifact).

### (c) Smallest deliverable that materially reduces the silent-degradation risk (blind spot #3)
**D4-signal-2, narrowed to its core:** the fallback data already exists in `dispatch-log`
(`spawn.ts:263 source`, `:334 downshiftedFrom`) and `routing-stats.ts` already aggregates it
globally (`:192`, `:195`). The single smallest change that converts *silent* degradation
into *loud* degradation is:

1. **Reclassify severity:** `spawn.ts:282` and the exhausted-retry `notify` (`:311`-ish)
   change `"info"` → **`"warning"`**. (2 lines.)
2. **Cross-tab:** add `category × downshift-source / total` to `routing-stats.ts` and emit a
   per-category flag. (~15 lines, reuses `group()`.)

This ships in isolation, needs no other deliverable, and directly addresses blind spot #3:
today a tier-fallback "quietly uses a worse model"; after, it warns per-dispatch **and**
surfaces a per-category rate that tells you a whole tier is degrading. Everything else in
this plan is leverage on top of that visibility.

---

*End of improvement-plan-v1.md. Grounded in source read 2026-07-28; all line counts
re-verified against the working tree before writing.*

---

## Amendments v1.1 — scope-honesty probe responses (2026-07-28)

Five probes from the operator post-v1. Each clause below is **authoritative** and
supersedes the named v1 text. All citations re-checked against source.

### Probe 1 → D3 ENTIRE SECTION SUPERSEDED: floor raised from path-existence to execution-receipt

**Verified finding (the probe is decisive and correct):** I surveyed pi as independent and
missed that **`execution-receipt` is a realized skill on the opencode/sisyphus sibling**
(`~/.config/opencode/skills/execution-receipt/SKILL.md`, 286 lines), and that pi already
carries its discipline as the **AGENTS.md:61 mandate** ("re-read the files, re-run the
tests, confirm the claimed outcome; never trust a self-report as ground truth"). v1 D3
proposed **path-existence readback** — strictly weaker than both. If shipped, `verified:true`
would mean "a claimed file exists" while execution-receipt would call the same result
`verify=fail(N)`. The W4 rework term would stay poisoned. **Path-existence is removed.**

**What execution-receipt actually does (read from source, not assumed):**
- **Observes** changed paths via `git status --porcelain` BEFORE/AFTER the task
  (orchestrator-side; does NOT trust the subagent's claimed file set).
- Runs **real static checks** per changed file: `lsp_diagnostics` (errors/warnings) or
  syntax checks (`bash -n`, `node -e JSON.parse`).
- `verify = pass` **only on zero diagnostics**; `fail(N)` otherwise; `skipped(reason)` with
  honest reasons (`dirtytree`, `nolsp`, `nofiles`, `declined`).
- **Retry on `exec=success AND verify=fail AND retry<2`** with the diagnostic list
  prepended to the re-dispatch prompt. Does NOT retry `refused`/`error`/`partial`.
- Writes a structured receipt (`exec/verify/model/files/duration/retry`) that survives
  compaction.

**Amended D3 (supersedes v1 D3 in full):**

*Target files:* `extensions/orchestration-engine/spawn.ts` (350), `…/index.ts` (500)
(`dispatch.execute()`), `AGENTS.md:61` (mandate → becomes a D1 `discipline` fragment),
**NEW** `extensions/orchestration-engine/execution-receipt.ts` (orchestrator-side verifier).

*Change:*
- `SpawnResult.verify` becomes a union, not boolean: `"pass" | "fail(N)" | "skipped(reason)"`.
- Orchestrator-side, after spawn: capture `git status --porcelain` before dispatch and
  after; diff → **observed** changed paths (the subagent's claimed set is ignored).
- Run diagnostics on observed paths via bash using the project's real tooling
  (`tsc --noEmit`, `eslint`, `bash -n`, `node -e JSON.parse`…). `pass` iff zero errors.
- Retry-on-fail (max 3 attempts) with diagnostics prepended; do not retry
  refused/error/partial (escalate).
- Receipt appended to `dispatch-log` (pi's compaction-surviving store) with
  `verify/exec/files/retry`.
- **Path-existence is deleted.** `claims` extraction is kept only as advisory context,
  never as a verification input.

*Dependencies:* none for the floor. D4-s3 (rework rate) now measures `verify=pass`-on-
first-attempt vs retried — a **trustworthy** term, fully de-poisoned.

*Verification:* unit-test the git-diff path-extraction + diagnostic-counting on fixtures
(clean tree → pass; introduced lint error → fail(1); dirty-before → skipped(dirtytree));
integration test a real dispatch that introduces a syntax error → verify=fail + retry fires.

*Rejection criteria:* do NOT run the project's full test-suite in verify (flaky/slow/may-
mutate) — static checks only (type-check/lint/syntax), matching execution-receipt's scope.
Do NOT make verify a hard `tool_call` block (still a structured prompt obligation + retry).
Do NOT trust claimed paths — observe via git.

*Failure mode if done WRONG:* (a) trusting the subagent's claimed file set instead of
observing via git → a lying subagent defeats the floor — *mitigation:* changed-paths come
ONLY from the git diff, never from output parsing; (b) running verify when `files=0`
(read-only research dispatches) → spurious skip noise — *mitigation:* `files=0` ⇒
`skipped(nofiles)` immediately; (c) treating `dirtytree` as `pass` → false trust —
*mitigation:* dirty-before ⇒ `skipped(dirtytree)`, recorded; the rework metric excludes it
from the denominator with a footnote.

### Probe 2 → D2 scope EXPANDED: generate the typed schema too (kills the surviving drift class)

v1 D2 generated only the prose `description` and left the `CategoryEnum`
(`orchestration-engine/index.ts:46–49`) hand-written — so schema↔tier-map drift survived.
**Amended:** derive BOTH prose AND schema from `TIERS` keys.
```ts
import { Type } from "typebox";
const CategoryEnum = Type.Union(
  (Object.keys(TIERS) as TaskCategory[]).map(c => Type.Literal(c)),
);
```
Now there is **zero** hand-maintained tier-map mirror. *Failure mode if done WRONG:* adding
a key to `TIERS` that isn't meant to be a dispatch category — *mitigation:* an invariant
test asserts `Object.keys(TIERS)` ⊆ an allowed-dispatch-category literal set, so an
accidental non-category key fails the build. The "D2 kills routing drift" claim now holds
for both the description and the schema.

### Probe 3 → D1 verification + failure-mode AMENDED: the order-drift gate runs at RUNTIME, not dev-only

v1 said "the test catches it" without saying where. For a single-operator local config
there is no CI/deploy pipeline — so "pre-deploy" = **session start** (before the first agent
turn). **Amended:** dual gate —
1. **Dev:** golden unit test (intended changes produce a reviewed golden diff).
2. **Runtime (the actual close):** the flusher, at every `session_start`, computes
   `buildFragments().order` + hash; if order ≠ declared priority OR hash ∉ the known-good
   set, emit a loud `WARN` and log `{drift:true}` to the `prompt-composition` entry. This
   makes "detectable" true **at use time**, including after a pi upgrade silently reorders
   the `before_agent_start` fan-out.
*Failure mode if done WRONG:* the runtime check only WARNs and the model ignores it → still
silent to the operator — *mitigation:* the `drift:true` entry is surfaced in `/routing-stats`
(D4) as a standing flag, so it is operator-visible, not model-visible-only.

### Probe 4 → Self-audit (b) RE-SCORED: 84 → 82 (three concessions; detectability re-attributed)

The operator is methodologically correct on all three points:
- **Detectability ≠ Failure Isolation.** The notify-severity flip + fallback cross-tab
  (D4-s2) is detectability, which belongs in **Observability** (already counted 9→10), NOT
  folded into Failure Isolation. v1 double-counted. Corrected.
- **Cognitive Efficiency 6→7 was premature.** Five new signals add monitoring load;
  named-fragments reduce hand-sync load marginally → **net-neutral, stays 6** until receipts
  visibly reduce rework.
- **Evolvability 8→9 from a reactive shim is optimistic.** A shim absorbs pain locally;
  version-scattered breaks still arrive. **Stays 8** (D5's versioned boundary is a small
  architectural gain, offset by unchanged runtime-seam coupling).

**Re-attribution:** Failure Isolation 8→9 is now justified by **D3's upgrade to
execution-receipt** (retry-on-fail + escalation = genuine containment of bad results), NOT
by detectability. The separation is now clean.

| Dimension | v1 | v1.1 | Driver |
|---|---|---|---|
| Testability | 7→8 | 7→8 | D1 golden + D5 invariants + execution-receipt verify-logic (unchanged) |
| Coupling | 7→8 | 7→8 | D1 + D2 + D6 (unchanged) |
| Simplicity | 6→7 | 6→7 | D5 collapse, D2 removal, offset by new modules (unchanged) |
| Observability | 9→10 | 9→10 | prompt-hash + fallback-rate + receipts — **detectability lives here** |
| Failure Isolation | 8→9 | 8→9 | **re-justified: D3 execution-receipt retry/escalation** (was detectability — corrected) |
| Cognitive Efficiency | 6→7 | **6→6** | conceded: net-neutral until rework visibly drops |
| Evolvability | 8→9 | **8→8** | conceded: D6 is local mitigation, not architectural |

**Composite: 84 → 82** (Cohesion 8, Coupling 8, Simplicity 7, Observability 10,
Testability 8, Evolvability 8, Reliability 9, Cost 9, Cognitive 6, Failure Isolation 9 =
82). Matches the predicted 81–82 band. Detectability is offered as an optional 11th audit
dimension (the operator's call on the rubric); within the existing 10-dimension schema it
is a facet of Observability.

### Probe 5 → D6 ADDS a Growth Policy (the shim is bounded, not open-ended)

v1 shims only the 2 broken surfaces with no growth bound — deferred debt. **Amended:** the
adapter carries an explicit policy.
- **Type discipline (invariant):** the adapter only TRANSLATES (local interface → upstream
call + handles the known break). It must NOT reimplement runtime semantics. (Note: the
existing `SafetyConfirmDialog` in `mini-damage-control.ts` IS a reimplementation — it stays
in the feature module, NOT in the adapter. The adapter covers confirm/select dispatch +
`input.source` only.)
- **Fold-back review trigger:** (a) whenever a 3rd+ surface is added; (b) quarterly; (c) on
every pi minor bump — for each shimmed surface, test whether the upstream API stabilized
across the last 2 minors. If stable → delete that adapter branch (shrink the shim).
- **Fork threshold (STOP — escalate):** adapter covers **>5 distinct upstream surfaces**;
OR any single shim exceeds **~50 LOC** of behavioral logic (translation is ~5–15
LOC/surface); OR the adapter begins **version-detecting across >2 runtime versions**
simultaneously. Hitting any → this is effectively a fork. Escalation: (i) pin the runtime
version (halt auto-upgrade) until upstream stabilizes, or (ii) propose the stable contract
upstream to pi.
- **Enforcement:** a test asserts the adapter is translation-only and under its LOC budget;
breaching the budget fails the build → forces the fork conversation rather than silent
growth.

*Failure mode if done WRONG:* the budget test is set too loose (e.g., 200 LOC) so the shim
grows into a fork without tripping — *mitigation:* budget is set tight (~15 LOC/surface) and
the >5-surface and >2-version triggers are independent hard stops that fire regardless of
LOC.

---

*v1.1 appended 2026-07-28. The v1 body above is preserved unchanged for the audit trail;
the five superseded clauses are marked at the top pointer and superseded here in full.*

---

## Amendments v1.2 — W1 execution findings (2026-07-29)

W1 was executed against the runtime. Two deliverables hit platform reality that changes
their status. This is the execution-receipt loop applied to the plan's own work.

### D1 — LIVE-VERIFIED FAILURE: blocked by pi's per-extension module isolation
The migration shipped and passed every static gate (golden 12/12, `node --check` syntax,
consistency grep). The operator reloaded pi. The live `prompt-composition` log then proved
the shared-registry design is **fundamentally incompatible** with pi: each extension gets
its OWN module instance, so the module-level `registry` in `prompt-builder.ts` is **not
shared** across extensions — each contributor built with only its own fragment (5 log
entries, each `order` of size 1). Priority-ordering was **not** achieved.
- **No regression:** the `before_agent_start` EVENT CHAIN is shared (`runner.js:827`), so
  all 5 blocks still compose — in load order; the prompt is byte-identical to pre-migration
  and pi works.
- **Net effect:** neutral on content, but adds indirection + 5 noisy single-fragment hash
  logs for zero benefit → **net-negative**.
- **Status: BLOCKED.** Recommend REVERT to known-good (restore direct `event.systemPrompt
  + block`; drop the `prompt-builder` imports). Priority-ordered composition needs a
  pi-native shared-state primitive or a file-based flusher (deferred — complexity
  unjustified until pi offers the primitive). Recorded as durable fact
  `pi_extension_module_isolation`. **Awaiting operator's revert word.**

### D5 — primitive shipped + verified; ADOPTION DEFERRED (real finding)
`extensions/security/yaml-merge.ts` + invariant tests (**12/12**) shipped — fail-closed
load, project-can't-remove-global, versioned. But adopting it across the 3 call sites is
**lower-value / higher-friction** than v1 assumed:
- The security property (fail-closed + deny-additive) **already holds** in all 3 current
  merges (each does try/catch→null + concat/add). The rewire's marginal value is versioning
  + centralization, NOT security.
- The clean-fit schema (rules = pure additive arrays) is **mini-damage-control = the safety
  gate** — marginal versioning value does not justify unverified-boot risk.
- chains + teams have **last-wins scalars** (`version`, `default_team`, per-team fields)
  that the primitive's `addInto` does not express — forcing them risks behavior drift.
- **Status:** primitive delivered + verified; adoption deferred (apply opportunistically
  when a call site is naturally rewritten, or extend the primitive to distinguish additive
  vs override fields). The boundary is available + versioned.

### D6 — COMPLETED
`extensions/upstream-adapter.ts` + tests (**8/8**, incl. growth-policy LOC guard at 46 ≤ 50)
shipped. Rewired `mini-task-tracker`'s `input.source` check → `isHumanTurn(event)`,
**verified behaviorally identical** (runtime test: `isHumanTurn` ≡ `source==="interactive"`
for interactive/extension/undefined/rpc). `mini-damage-control`'s confirm→custom-dialog
path stays feature-local by design (type-discipline: the adapter translates, never
reimplements a component). **D6 done.**

---

*v1.2 appended 2026-07-29. Net W1 outcome: D6 done; D5 primitive done + verified, adoption
deferred (finding); D1 blocked by a verified platform property — revert recommended, pending
operator word.*

---

## Amendments v1.3 — D1 resolved (partial revert); W1 closed (2026-07-29)

Operator decision: **partial revert, not full** — drop the failed mechanism, KEEP the
observer (the higher-value half). Executed + statically verified.

### D1 — RESOLVED (observer kept, mechanism dropped)
- **Mechanism REMOVED:** the 5 `before_agent_start` handlers reverted to original direct
  `event.systemPrompt + block` mutation (bd-bridge, memory/index, mini-purpose-gate,
  orchestration-engine/index, session-notes); `prompt-builder.ts` + its test deleted. Grep-
  confirmed zero mechanism references; all syntax-valid. Composition is back to known-good
  (load-ordered, all 5 blocks via the event chain).
- **Observer KEPT** (new files): `prompt-hash.ts` (pure `hashPrompt` + `KNOWN_GOOD_HASHES` +
  `isKnownGood`); `prompt-observer.ts` (hooks `agent_start` — fires AFTER the prompt is
  finalized at agent-session.js:898-916 — hashes `ctx.getSystemPrompt()`, the event chain's
  OUTPUT, logs `prompt-composition {hash, known, drift}`, WARNs on unknown hash);
  `prompt-hash.test.ts` (**golden 7/7**, canonical hash `8a642115a2fa768c`).
- **`{drift:true}` surfaced in `/routing-stats`** (4-point edit: collect prompt-composition
  drift entries in both scan paths + a drift section + flag-count).
- **Reframed D1 goal:** from “impose declared order” → **“observe the event-chain’s actual
  output + detect prompt drift.”** The observer hashes the OUTPUT, so it sidesteps module
  isolation entirely. **Hash-level drift ships now; order-level drift (which extension
  moved) is deferred** — needs upstream event-chain instrumentation (the
  `pi_extension_module_isolation` fact means “declared priority” waits for an opencode
  primitive).
- **Status:** code-complete + statically verified + runtime-seam verified-by-reading-dist;
  **pending one live boot** to confirm `agent_start`+`ctx.getSystemPrompt` yields the
  composed-prompt hash. Defensive: if the seam is wrong, the observer **no-ops** (try/catch
  + empty-skip) — never a crash, never a regression.

### D5 — primitive-only accepted; adoption trigger recorded
Operator confirmed all three deferral points. Recorded durable constraint
`d5_yaml_merge_adoption_trigger`: **4th merge site appears → adopt the primitive at the new
site (mandatory) + backfill rules as the clean-fit demonstration.** Header note added to
`yaml-merge.ts`.

### W1 — CLOSED
| Deliverable | Outcome |
|---|---|
| **D6** | ✅ done (adapter + tests 8/8 + `mini-task-tracker` rewire verified-equivalent) |
| **D5** | ✅ primitive-only (12/12); adoption deferred, trigger recorded |
| **D1** | ✅ honest failure salvaged — observer kept (7/7 golden + drift wiring), mechanism dropped |

The cycle’s lesson, preserved: live verification — not planning, not assertion — caught a
design assumption (shared module state across pi extension modules) no upstream review would
have found. Reverting with the observer intact keeps the lesson’s evidence (the drift hash)
without paying for the failed mechanism.

---

*v1.3 appended 2026-07-29. D1 partial-revert complete + statically verified (observer
pending one live boot to confirm the agent_start seam). W1 closed.*
