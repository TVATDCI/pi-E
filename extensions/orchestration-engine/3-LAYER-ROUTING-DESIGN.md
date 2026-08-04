# 3-Layer Model-Routing Architecture for the Pi Orchestration Engine

**Status:** v1 partially **implemented** (re-checked 2026-07-09): **F4 + F6 + persona-override shipped** (see ADRs `0005-availability-precheck-f4.md` + `0004-observability-loop.md`); **F1 (LLM classifier) 🔒 CLOSED** (explicit-category chosen; reopen only on `/routing-stats` evidence); **F2 peak-hour downshift + F3 runtime retry still deferred.** · **Originally designed:** 2026-07-05 · **Last revised:** 2026-07-09
**Scope:** `~/.pi/agent/extensions/orchestration-engine/` (`index.ts`, `tier-map.ts`)
**Builds on:** existing `dispatch` tool + `resolveModel()` + `dispatch-log` appendEntry
**Grounded in:** `docs/extensions.md`, `docs/sdk.md`, `docs/models.md`, `examples/extensions/subagent/`, `PROBE-RESULTS.md`

> **_[Footnote 2026-07-13 — worked-example model values reflect an older tier-map snapshot.]_**
> The worked examples below (e.g. `ultrabrain → glm-5.2`, downshift to
> `unspecified-high`/`glm-5.2`, `FALLBACK`/glm-5.2) illustrate the *resolution flow* and were
> written against an earlier `tier-map.ts`. **`tier-map.ts` `TIERS` is the source of truth for
> current model values** — e.g. `ultrabrain` → `glm-5.1`, `unspecified-high` &
> `visual-engineering` → `glm-5-turbo`, global `FALLBACK` → `opencode/glm-5.1`. The flow logic
> (precedence, downshift, availability) is unchanged; only the concrete model strings in the
> examples are dated.

---

## 0. Reconciling "3 layers" — there are already two different layer schemes

Before defining anything, kill a naming collision that will cause bugs if ignored.

`HANDOFF.md` already uses L1/L2/L3 for a **different axis** (the *catalog* axis):

| HANDOFF label | Meaning | Artifact |
|---|---|---|
| L1 | "what models exist" | `~/.pi/agent/models.json` + built-ins |
| L2 | "which model for which task" | `tier-map.ts` |
| L3 | "spawn the subprocess" | `index.ts` |

The user's prompt uses L1/L2/L3 for the **routing pipeline** axis (classify → select → dispatch). These two schemes describe the same code from different angles, and if both float around the repo, every conversation will require disambiguation.

**Resolution (opinionated):** the catalog is *infrastructure*, not a routing decision. I demote the HANDOFF's L1 to **Layer 0 (Catalog)** and reserve **Layer 1/2/3** exclusively for the routing pipeline. This matches the user's framing and gives every layer a single, testable responsibility.

| Layer | Name | Responsibility | Artifact (current → target) |
|---|---|---|---|
| **0** | Catalog | Make models spawnable; declare specs (cost, ctx window, `thinkingLevelMap`) | `~/.pi/agent/models.json` + Pi built-ins *(unchanged)* |
| **1** | Intent classifier | Map an incoming `{task, context}` → a `TaskCategory` + confidence | *(new)* `intent.ts` |
| **2** | Route selector | Map `{category, context signals}` → concrete `{provider, id, thinkingLevel, effort}` | `tier-map.ts` *(extended, not rewritten)* |
| **3** | Execution dispatch | Spawn the chosen model, retry/fallback, parse events, return result, log | `index.ts` *(extended)* + *(new)* `router.ts` orchestrator |

The catalog (L0) is owned by Pi core. **Layers 1–3 are entirely inside this extension.** The rest of this doc is about L1–L3.

---

## 1. Rationale — what failure modes does the split solve?

The current code is a **1.5-layer system**: the parent LLM picks `category` explicitly at tool-call time (HANDOFF decision #1, "EXPLICIT"), then `resolveModel(category, registry)` does a context-blind table lookup, then `spawnSub` runs it with no fallback. That design has six concrete failure modes, each of which maps to a layer the split introduces.

### F1 — Classification is done by the wrong model, and is unobservable

> **🔒 CLOSED (2026-07-09): explicit-category is the chosen design, not a placeholder.** The parent reliably handles the 9-way category pick at zero cost; a dedicated `intent.ts` classifier was evaluated and de-prioritized. `/routing-stats` (F6, shipped) now makes this an evidence-based call — **reopen only if** the stats ever show chronic parent mis-classification (sustained high fail-rate or quota waste on a category). The `intent.ts` interface sketches in §2–§5 below are retained as **historical design exploration, not a build queue.**
Today the parent agent (a flagship model) reads nine `CategoryEnum` literals plus a paragraph of category descriptions from the `dispatch` tool schema (`index.ts` `description:` field), then emits `category: "..."` as a tool arg. Two costs:
- **Token cost:** every dispatch forces the parent to carry the full category taxonomy in its tool schema. The taxonomy *is* the routing instruction (HANDOFF #1: "load-bearing text"). That's permanent context tax on the expensive model.
- **Quality cost + blindness:** the parent's classification reasoning is invisible. There's no confidence, no `alternatives`, no log of "why this category." When routing is wrong (a `quick` task sent as `ultrabrain`), the only signal is wasted quota — discovered weeks later, if at all.

**L1 fix:** classification becomes a first-class, logged step with a confidence score and an explicit `routedBy` provenance field. L1 also lets us A/B a cheap classifier model against the parent's choice without touching L2/L3.

### F2 — Route selection is context-blind despite the signals already existing
`resolveModel(category, registry)` (`tier-map.ts`) keys **only** on the category string. But `tier-map.ts` *already exports* `isPeakHours()`, `isPromoActive()`, `PROMO_SUNSET_ISO`, and the per-tier `promoAffected` flag — **none of which are consulted by `resolveModel` or `spawnSub`**. So:
- During peak hours (06:00–10:00 UTC) the router will happily send `deep → glm-5.2 @high` at **3× quota** even though the operator's own HANDOFF says "L3 may consult it to downshift architecture→4.7 if a dispatch lands in peak."
- After the promo sunset (**2026-09-30** — corrected to match `tier-map.ts PROMO_SUNSET_ISO`; this doc earlier mis-stated 10-30), `glm-5.2` silently goes from 1× to 2× off-peak with no behavior change in the router.
- ~~The `agent` parameter ("reserved for Lesson 0008 — specialist persona `.md`") is accepted but ignored, so persona `model:` frontmatter precedence (HANDOFF decision #2) is unimplemented.~~ **✅ IMPLEMENTED (2026-07-09):** `index.ts` loads the persona `.md` and honors a `model:` frontmatter pin (`persona?.model ?? tierDefault.modelFlag`). (The peak/promo auto-downshift in the two bullets above is still deferred — `isPeakHours`/`isPromoActive` are surfaced in `/routing-stats` + `/tiers` but do not yet auto-downshift `resolveModel`.)

**L2 fix:** `resolveRoute(input: RouteInput)` takes a *struct* of signals (`{category, peak, promoActive, personaOverride?, availability, recentFailures}`) and returns a `RouteDecision` that records *why* it picked what it picked (`downshiftReason`, `quotaCostX`). The promo math becomes a runtime check, not a doc comment.

### F3 — No runtime fallback (only registration fallback)

> **✅ IMPLEMENTED (2026-07-11, ADR 0010):** `resolveAndSpawn` now retries once on **empty primary output** (exit 0, len 0 — the quota-exhaustion signature) using each tier's per-tier `fallbackProvider`/`fallbackId` in `tier-map.ts`, before failing loudly. Surfaced in `/routing-stats` as `downshift-exhausted` (distinct from F4's `downshift-unavailable`). All 8 Z-AI-plan categories carry an explicit cross-provider fallback to `opencode`; `git-commit-message` is opencode-primary and needs none. **Per-tier fallback targets** (refined post-ADR, see ADR 0010 footnote): `quick`→`deepseek-v4-flash-free`, `unspecified-low`/`writing`→`hy3-free` (FREE), `unspecified-high`→`kimi-k2.7-code`, `deep`/`ultrabrain`/`visual-engineering`/`artistry`→`glm-5.1`. The prose below is the original design rationale, now realized.

`resolveModel` has a fallback, but it's a **registration** fallback: "tier model not in registry → use `glm-5.2`." It does nothing for **runtime** failures. Per `PROBE-RESULTS.md`, Z AI Coding Plan has **no balance fallback** (FAQ:66-69) — quota exhaustion is a hard fail. Today, when a spawned `pi` exits non-zero (`proc.on("close", code => ... code !== 0 → status: "error")` in `spawnSub`), the tool just returns `"failed"`. No retry, no downshift to a 1× tier, no re-dispatch.

> **🔄 RE-VERIFY 2026-08-04 (tier-map sync):** The per-tier fallback targets above are superseded by a `tier-map.ts` model change. Current map: `quick` is now **opencode-primary** (`opencode/deepseek-v4-flash-free`, fb `opencode/ling-3.0-flash-free` — no longer Z-AI-plan), so only **7 of 10** categories are Z-AI-plan-primary (was 8). Updated per-tier fallbacks: `unspecified-low`/`writing`→`opencode/deepseek-v4-flash-free` (was `hy3-free`), `deep`→`opencode-go/glm-5.2` (was glm-5.1), `visual-engineering`→`opencode-go/glm-5.2` (was glm-5.1), `artistry`→`opencode-go/glm-5.1` (unchanged), `unspecified-high`→`kimi-k2.7-code` (unchanged). Primary changes: `deep` 5.1→5.2, `artistry` 5.1→5.2, `quick` glm-4.5-air→opencode/deepseek-v4-flash-free. The original paragraph above is preserved as the 2026-07-11 point-in-time record.

**L3 fix:** explicit retry policy keyed on failure class (see §5). On promo-model quota exhaustion → downshift to `glm-4.7` (always 1×) and re-dispatch once. On crash/timeout → retry once, same model. On abort (`ctx.signal`) → propagate, never retry.

### F4 — Availability is checked at spawn-exit, not at route time

> **✅ IMPLEMENTED (2026-07-09, ADR 0005):** `index.ts` now calls `ctx.modelRegistry.getAvailable()` *before* spawn and **loudly downshifts** to the fallback (`glm-5.2`) when the chosen model has no configured key — notified + logged, never silent. The `/tiers` command surfaces real availability. The prose below is the original design rationale, now realized.
`resolveModel` calls `registry.find(provider, id)`, which `docs/sdk.md:383` documents as *"doesn't check if API key exists."* So a dispatch can pick `opencode/gemini-3.1-pro` for `visual-engineering`, spawn a full `pi` subprocess, wait for it to fail, and only then discover opencode was never configured. The correct API is `await registry.getAvailable()` (`docs/sdk.md:386`).

**L2+L3 fix:** `resolveRoute` does an availability precheck via `getAvailable()` (cached per session — see open questions §8). If the tier model is unavailable, L2 downshifts *before* L3 spawns anything.

### F5 — Doc/code drift on thinking level
`HANDOFF.md` (open decision #5) states: *"the verified spawn pattern currently hardcodes `--thinking off`."* But `index.ts` actually does `args.push("--thinking", r.thinkingLevel ?? "off")` — it **honors** the per-category level. The PROBE-RESULTS Q5 sub-check confirms honoring is safe end-to-end. So the code is ahead of the doc. That drift is the symptom of thinking-level being an *implicit* side-channel of L2 rather than a *named output* of it.

**L2 fix:** `thinkingLevel` becomes an explicit field on `RouteDecision`, with its own `rationale`, logged independently. No more "is it honored?" ambiguity.

### F6 — Observability is write-only (no tuning loop)

> **✅ IMPLEMENTED v1 (2026-07-09, ADR 0004):** `/routing-stats` now reads the dispatch-log back — **cross-session / cwd-scoped** (aggregates every session in the current project via `SessionManager.list(ctx.cwd)` + `parseSessionEntries`), with per-category / per-model / per-agent / routing-source views + threshold flags (fail-rate, override-rate, downshift count). Pure aggregator in `routing-stats.ts` is unit-tested. "Nothing reads it back" is no longer true. `/tiers` is the companion setup command.
`index.ts` calls `pi.appendEntry("dispatch-log", {...})` with `{category, modelFlag, thinkingLevel, rationale, source, outcome, elapsedMs, task}`. That's good write coverage. But **nothing reads it back.** The operator's stated goal (HANDOFF #6, "observable tuning") requires a feedback loop: "category X failed Y% on model Z," "we downshifted N times last week," "average L1 latency is M ms." None of that exists.

**L1+L2+L3 fix:** every layer writes structured fields to `dispatch-log` (see §6), and a new `/routing-stats` command reads them back. This closes the loop and is the *prerequisite* for ever trusting an LLM-based L1 (you can't measure classifier quality without labels, and the labels come from this log).

### Summary table — failure → layer that solves it

| Failure | Current behavior | Layer that fixes it |
|---|---|---|
| F1 Mis-classification by parent LLM, unobservable | Parent picks category, no log | **L1** (confidence + `routedBy` + log) 🔒 **CLOSED 2026-07-09** — explicit-category chosen; reopen on `/routing-stats` evidence |
| F2 Context-blind routing (ignores peak/promo/persona) | `resolveModel(cat)` only | **L2** (`resolveRoute(RouteInput)`) |
| F3 No runtime fallback on quota exhaustion | spawn exits ≠0 → "failed" | **L3** (retry policy by failure class) |
| F4 Availability checked too late | `registry.find` (no key check) | **L2** (`getAvailable()` precheck) ✅ shipped ADR 0005 |
| F5 Thinking-level doc/code drift | Honored but implicit | **L2** (explicit `RouteDecision.thinkingLevel`) |
| F6 Observability write-only | `appendEntry` writes, nothing reads | **L1+L2+L3** fields + `/routing-stats` ✅ shipped ADR 0004 |

---

## 2. Responsibility of each layer (inputs / outputs / what it does NOT do)

### Layer 1 — Intent Classifier (`intent.ts`, new)

**Job:** turn a free-text task + light context into a `TaskCategory` with a calibrated confidence.

- **Does:** run a pluggable classifier (default: deterministic keyword/heuristic; optional: a `quick`-tier LLM sub-call to `glm-4.5-air` returning structured output). Emit `confidence`, `alternatives` (runner-up categories), `signals` (which keywords/rules fired).
- **Does NOT:** know about models, providers, quota, or thinking levels. It speaks the category vocabulary only. This is the key separation — L1 can be unit-tested and A/B'd without a model registry.
- **Does NOT:** spawn anything in the default heuristic mode. (The optional LLM mode spawns one `quick` dispatch; see open questions §8.)

**Input:**
```ts
interface ClassifyInput {
  task: string;                 // the exact dispatch `task` text
  context?: {
    cwd?: string;
    fileExtensions?: string[];  // e.g. [".tsx",".css"] → hints visual-engineering
    hasImages?: boolean;        // → forces visual/artistry path
    recentCategories?: TaskCategory[]; // sticky-context: last 3 dispatches' categories
  };
  /** "explicit" = caller passed category; skip L1. "heuristic" (default) | "llm". */
  mode?: "explicit" | "heuristic" | "llm";
  explicitCategory?: TaskCategory; // present iff mode === "explicit"
}
```

**Output:**
```ts
interface IntentClassification {
  category: TaskCategory;
  confidence: number;           // [0,1], calibrated against the heuristic's rule strength
  routedBy: "explicit" | "heuristic" | "llm" | "fallback-low"; // see §5 fallback
  alternatives: Array<{ category: TaskCategory; score: number }>; // top 3, sorted
  signals: Record<string, string | number | boolean>; // e.g. { matchedKeyword: "refactor", hasImages: false }
  classifyMs: number;
  /** present iff routedBy === "llm" — the raw structured output for audit */
  rawLlmOutput?: unknown;
}
```

### Layer 2 — Route Selector (`tier-map.ts`, extended)

**Job:** map an L1 result + runtime context signals to a spawnable `{provider, id, thinkingLevel, effort}` plus a recorded rationale.

- **Does:** consult `TIERS` (unchanged data), apply context overlays (peak/promo downshift, persona `model:` override, availability precheck, quota-budget guard), return a `RouteDecision` that explains itself.
- **Does NOT:** spawn anything, retry, or decide *category*. It is a pure function of `(category, signals)` → `RouteDecision`. Stays unit-testable with a mock `ModelRegistryLike` (the existing `tier-map.ts` design guarantee is preserved).
- **Does NOT:** mutate `TIERS` at runtime. Promo/peak influence the *decision*, not the table.

**Input:**
```ts
interface RouteInput {
  category: TaskCategory;             // from L1 (or explicit)
  registry: ModelRegistryLike;        // existing; for the registry lookup
  available?: Set<string>;            // from getAvailable(); provider/id keys present = has key. undefined = skip precheck
  personaOverride?: { provider: string; id: string; thinkingLevel?: ThinkingLevel }; // from .md frontmatter
  peak?: boolean;                     // default isPeakHours()
  promoActive?: boolean;              // default isPromoActive()
  budget?: { remainingQuotaX?: number; recentFailures?: Record<string, number> };
}
```

**Output:**
```ts
interface RouteDecision {
  modelFlag: string;              // "zai-coding-cn/glm-5.2" — the literal --model value
  provider: string;
  id: string;
  thinkingLevel: ThinkingLevel;   // EXPLICIT, always present (fixes F5)
  effort?: "low" | "medium" | "high"; // advisory, surfaced in logs/widget
  category: TaskCategory;
  rationale: string;              // human-readable, explains downshifts
  source: "tier-map" | "persona-override" | "downshift-peak" | "downshift-unavailable" | "fallback"; // lineage
  quotaCostX: 1 | 2 | 3;          // computed from peak/promo/model (per PROBE-RESULTS table)
  availabilityChecked: boolean;
  downshiftReason?: "peak" | "unavailable" | "budget" | "promo-ended";
  resolveMs: number;
}
```

`resolveModel()` (the current export) **stays** as the low-level primitive — `resolveRoute()` calls it internally and layers the context overlays on top. No existing caller breaks.

### Layer 3 — Execution Dispatch (`index.ts` extended + `router.ts` new orchestrator)

**Job:** take a `RouteDecision`, spawn the subprocess, parse the JSON event stream, apply retry/fallback policy, return the result, and log a complete record.

- **Does:** spawn `pi` with the decided `--model`/`--thinking` (preserving the verified arg pattern from `index.ts` `spawnSub`), wire `ctx.signal` → `proc.kill()` (currently missing — see F3/open Qs), extract `usage`/`cost` from `message_end` events (port the parsing from `examples/extensions/subagent/index.ts:329-345` which the current `spawnSub` does NOT do), run the retry loop, and emit three log records (one per layer) to `dispatch-log`.
- **Does NOT:** decide category or model. L3 receives a `RouteDecision` and executes it. If L3 wants to override (e.g. retry on a different model after quota failure), it re-invokes `resolveRoute()` with a `budget.recentFailures` update — it does **not** reclassify. (Exception: if L3 exhausts the fallback chain, it can ask L1 to reconsider with `mode: "fallback-low"`; see §5.)
- **Does NOT:** render the widget differently. The existing widget (`render()` in `index.ts`) stays; it just reads richer `SubState` fields.

**Input:** `RouteDecision` + `{task, ctx, signal, onUpdate}`.
**Output:**
```ts
interface DispatchResult {
  output: string;
  code: number;
  exitReason: "done" | "error" | "aborted" | "quota-exhausted" | "timeout";
  elapsedMs: number;
  attempts: number;               // 1 = no retry; 2 = retried once
  finalModel: string;             // may differ from RouteDecision.modelFlag after downshift
  retried: boolean;
  downshifted: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number; turns: number };
}
```

---

## 3. Interface contracts between layers

The pipeline is a straight chain. Each boundary is a typed struct so any layer can be mocked for evals.

```ts
// Full pipeline signature (lives in router.ts)
async function routeAndDispatch(
  input: { task: string; explicitCategory?: TaskCategory; persona?: string },
  ctx: ExtensionContext,
  opts?: { onUpdate?: OnUpdateCallback; signal?: AbortSignal },
): Promise<DispatchResult> {
  // L1
  const intent = classify({
    task: input.task,
    mode: input.explicitCategory ? "explicit" : "heuristic",
    explicitCategory: input.explicitCategory,
    context: { cwd: ctx.cwd },
  });
  // L2
  const available = await getCachedAvailable(ctx.modelRegistry); // see §8
  const route = resolveRoute(
    { category: intent.category, registry: ctx.modelRegistry, available, personaOverride: loadPersonaModel(input.persona) },
  );
  // L3
  const result = await dispatchWithRetry(route, input.task, ctx, opts);
  // log all three (see §6)
  logTrace(ctx, { intent, route, result, task: input.task });
  return result;
}
```

**Boundary contracts:**

| Boundary | Contract | Failure semantics |
|---|---|---|
| L1 → L2 | `IntentClassification.category ∈ TaskCategory` (9-value enum). L2 must accept any of the 9. | If L1 emits `routedBy: "fallback-low"`, L2 must treat it as `unspecified-low` and set `source: "fallback"`. |
| L2 → L3 | `RouteDecision.modelFlag` must be a `provider/id` that `registry.find` resolves (non-undefined). | If L2 throws (`resolveModel`'s "NEITHER resolves" branch), L3 must NOT spawn; it returns `exitReason: "error"` with `attempts: 0`. |
| L3 → L3 (retry) | Retry re-enters L3 with a possibly-different `RouteDecision`. Max 1 retry. | A second failure of any class → terminal `exitReason`, propagate to caller. |
| L3 → L1 (escape hatch) | Only on total fallback-chain exhaustion: L3 may call `classify({mode:"fallback-low"})` once. | If that also fails, terminal error. (Discouraged; default policy is to fail rather than re-loop.) |

**Backwards compatibility:** the `dispatch` tool's `category` parameter becomes **optional**. If the parent LLM passes it, L1 runs in `mode: "explicit"` (zero-cost, zero-latency) and the behavior is identical to today. If omitted, L1 classifies. This means the split is a strict superset of current behavior — no prompt retraining needed (relevant given HANDOFF reversal #1 about preserving the OmO category vocabulary).

---

## 4. Integration with the existing code (refactor path, not rewrite)

Concretely, what stays, what moves, what's new. File-by-file.

### `tier-map.ts` — STAYS, EXTEND
- **Unchanged:** `TaskCategory`, `ThinkingLevel`, `TierEntry`, `ResolvedModel`, `ModelRegistryLike`, `TIERS`, `DEFAULT_CATEGORY`, `FALLBACK`, `PROMO_SUNSET_ISO`, `PEAK_UTC_HOUR_*`, `isPromoActive()`, `isPeakHours()`, `resolveModel()`, `listTiers()`. All current exports and their signatures are preserved.
- **New exports:**
  - `resolveRoute(input: RouteInput): RouteDecision` — wraps `resolveModel()`, adds the context overlays (peak/promo downshift, persona override, availability precheck). This is where `isPeakHours()`/`isPromoActive()` finally get *called* (today they're dead exports — F2).
  - `quotaCostX(model, {peak, promoActive}): 1|2|3` — pure fn encoding the PROBE-RESULTS cost table.
  - `downshiftTarget(category, reason): TaskCategory` — e.g. `deep → unspecified-low` under peak pressure; `visual-engineering → unspecified-high` when gemini unavailable.
  - Types: `RouteInput`, `RouteDecision` (from §2).
- **Why it stays:** the category port from OmO (HANDOFF reversal #1) and the probe-verified model assignments are the load-bearing facts. The split adds a *decision* layer on top of the *data* layer; it doesn't re-decide the data.

### `index.ts` — STAYS, EXTEND
- **Unchanged:** the `dispatch` tool registration, the `SubState` widget, `render()`, `startTick()`/`stopTickIfIdle()`, the `session_start` handler, the `pi.appendEntry("dispatch-log", ...)` call site.
- **Changed:**
  - `CategoryEnum` stays, but the `category` param on the tool becomes `Type.Optional(...)` (back-compat — see §3).
  - `spawnSub()` gains: (a) `signal` wiring (`proc.kill("SIGTERM")` on `ctx.signal?.addEventListener("abort", ...)` — currently absent), (b) `usage`/`cost` extraction from `message_end` events (port the parsing block from `examples/extensions/subagent/index.ts:329-345`), (c) classification of `exitReason` from the combination of `code`, `stderr`, and `signal`.
  - The tool `execute()` body becomes a call into `routeAndDispatch()` (from `router.ts`), replacing the direct `resolveModel(...)` + `spawnSub(...)` sequence. The widget state (`SubState`) gets two new fields: `confidence` (from L1) and `attempts` (from L3).
- **New:** nothing structural in this file — orchestration moves to `router.ts`.

### `intent.ts` — NEW
- `classify(input: ClassifyInput): IntentClassification` (sync, for heuristic mode) and `classifyWithLlm(input, ctx): Promise<IntentClassification>` (async, optional).
- The heuristic classifier: a scored keyword/regex table keyed on the 9 categories. Examples grounded in the existing `dispatch` tool description: `git commit|git log|rebase` → `git-commit-message`; `refactor|architecture|design` → `deep`; `hardest|prove|formal` → `ultrabrain`; `prose|docs?|readme` → `writing`; `\.tsx?|\.css|component|ui ` + image attachment → `visual-engineering`; `poem|creative|brand` → `artistry`; short (<120 chars) + imperative → `quick`. Scores normalized to `[0,1]`.
- `fallback-low` path: if top score < 0.4 → return `{category: "unspecified-low", routedBy: "fallback-low", confidence: score}`.

### `router.ts` — NEW
- Owns `routeAndDispatch()` (the pipeline from §3), `dispatchWithRetry()` (the L3 retry loop), `getCachedAvailable()` (per-session memo of `getAvailable()`), and `logTrace()` (writes the three-layer record to `dispatch-log`).
- This file is the *only* place that knows all three layers exist. `index.ts` and `tier-map.ts` remain individually testable; `router.ts` is the integration point.

### New command: `/routing-stats`
- Reads back `dispatch-log` entries (via `ctx.sessionManager.getEntries()` filtered by `customType === "dispatch-log"`) and prints: per-category count + success rate, per-model p50/p95 latency, total cost, downshift frequency, L1 mode distribution. Closes the F6 loop. Registered in `index.ts` via `pi.registerCommand("routing-stats", {...})`.

### What explicitly does NOT happen
- No change to `~/.pi/agent/models.json` (L0 catalog).
- No change to the spawn arg pattern that `PROBE-RESULTS.md` Q5 verified (`--mode json -p --no-extensions --tools read,bash,grep --session <file> --thinking <level> --model <flag> <task>`).
- No change to the 9 category names (OmO port preserved).
- No rewrite of `resolveModel` — `resolveRoute` wraps it.

---

## 5. Fallback strategy

Three layers, three fallback modes. Each is bounded so cost can't spiral.

### L1 uncertain (low confidence / tie)
- **Trigger:** heuristic top score < 0.6, OR top-2 scores within 0.1 of each other.
- **Response (default):** emit `routedBy: "fallback-low"`, category `unspecified-low`. The parent LLM sees in the tool result: `[routed: unspecified-low (uncertain, L1 tie: deep/ultrabrain @0.55/0.52)]`. The parent can then re-dispatch with an explicit `category` if it cares.
- **Response (interactive, optional):** if `ctx.mode === "tui"` and `ctx.hasUI`, pop a `ctx.ui.select("Ambiguous task — pick weight:", ["deep","ultrabrain"])`. Off by default; only enable if `/settings` exposes it.
- **Hard bound:** L1 never spawns a model in heuristic mode (zero cost). In LLM mode it spawns exactly one `quick` dispatch — bounded.

### L2 picks an unavailable model
- **Trigger:** `available` set is provided AND `available.has(`${provider}/${id}`)` is false.
- **Response:** call `downshiftTarget(category, "unavailable")` and re-resolve. Example: `visual-engineering` needs `opencode/gemini-3.1-pro` but opencode isn't configured → downshift to `unspecified-high` (`zai-coding-cn/glm-5.2`). Set `source: "downshift-unavailable"`, `downshiftReason: "unavailable"`. The result text warns: `[vision model unavailable — routed to text flagship; image input may be ignored]`.
- **Hard bound:** L2 downshifts at most once per dispatch. If the downshift target is *also* unavailable, fall to `FALLBACK` (`glm-5.2`), and if that's unavailable too, throw (matching today's `resolveModel` "NEITHER resolves" branch).

### L3 fails mid-execution
Classify the failure into one of five classes and respond per-class:

| `exitReason` | Detection | Response | Bound |
|---|---|---|---|
| `aborted` | `ctx.signal?.aborted` (Esc) | Kill proc, propagate. **Never retry.** | — |
| `quota-exhausted` | `code !== 0` AND (`stderr` matches `quota\|1311\|1113\|rate` OR HTTP 429 in stream) | Re-resolve via L2 with `budget.recentFailures[model]++` → L2 downshifts promo model to 1× tier (`glm-4.7`). Re-spawn **once**. | 1 retry |
| `timeout` | elapsed > `L3_TIMEOUT_MS` (default 600_000) | Retry **once**, same model. Second timeout → terminal. | 1 retry |
| `error` (transient) | `code !== 0`, not matching quota/abort | Retry **once**, same model. Second failure → terminal. | 1 retry |
| `done` | `code === 0` | Return. | — |

**Cross-layer escape hatch (discouraged):** if L3 exhausts its 1 retry AND the failure was `quota-exhausted`, it may call `classify({mode:"fallback-low"})` once to drop to the cheapest tier and try a final time. Default: **off** — fail loud, let the parent LLM decide. Rationale: silent triple-attempts hide quota problems that the operator needs to see.

**Hard global bound:** max 2 spawn attempts per dispatch (1 original + 1 retry), or 3 with the escape hatch. Total cost is bounded by `2× max(spawn cost)` — the L2 downshift guarantees the retry is on a ≤1× tier where possible.

---

## 6. Observability — what to log at each layer

Every dispatch writes **one** `dispatch-log` entry, but that entry now has three nested sub-records (one per layer). The schema extends the current flat shape (`index.ts` `appendEntry` call) rather than replacing it.

```ts
// Existing flat fields stay (back-compat with any log readers):
{
  customType: "dispatch-log",
  category: TaskCategory,
  modelFlag: string,
  thinkingLevel: ThinkingLevel,
  rationale: string,
  source: string,           // now richer: "tier-map" | "persona-override" | "downshift-peak" | ...
  outcome: "done" | "error",
  elapsedMs: number,
  task: string,             // first 200 chars (unchanged)

  // NEW — three nested records:
  l1: {
    routedBy: "explicit" | "heuristic" | "llm" | "fallback-low",
    confidence: number,
    alternatives: [{ category, score }],   // top 3
    signals: Record<string, unknown>,       // which rules fired
    classifyMs: number,
  },
  l2: {
    effort?: "low"|"medium"|"high",
    quotaCostX: 1|2|3,
    availabilityChecked: boolean,
    downshiftReason?: "peak"|"unavailable"|"budget"|"promo-ended",
    peak: boolean,
    promoActive: boolean,
    resolveMs: number,
  },
  l3: {
    exitReason: "done"|"error"|"aborted"|"quota-exhausted"|"timeout",
    attempts: number,
    finalModel: string,                     // differs from modelFlag iff downshifted/retried
    retried: boolean,
    downshifted: boolean,
    usage?: { input, output, cacheRead, cacheWrite, cost, contextTokens, turns },
  },
}
```

**Why these fields, mapped to tuning questions:**

| Signal | Layer | Tuning question it answers |
|---|---|---|
| `l1.confidence` distribution | L1 | "Is the heuristic good enough, or do we need the LLM L1?" |
| `l1.routedBy === "fallback-low"` rate | L1 | "How often is the taxonomy insufficient?" |
| `l1.alternatives` runner-up | L1 | "Which two categories are most confused?" (→ improve keywords) |
| `l1.classifyMs` (LLM mode) | L1 | "Is the classifier latency worth it?" |
| `l2.quotaCostX` histogram | L2 | "Are we burning 3× quota during peak? Is the downshift firing?" |
| `l2.downshiftReason` counts | L2 | "Is gemini misconfigured (unavailable) or are we just peak-shy?" |
| `l2.promoActive` at log time | L2 | "Did the Oct-1 sunset silently double our costs?" |
| `l3.exitReason` per `finalModel` | L3 | "Which models are flaky?" |
| `l3.retried` / `downshifted` rates | L3 | "Is the fallback policy actually engaged, or are we failing fast?" |
| `l3.usage.cost` sum per category | L3 | "Is `ultrabrain` (xhigh) worth it vs `deep` (high) for the same outcomes?" |
| `outcome` × `category` × `finalModel` success rate | all | "Should we remap category X off model Y?" (the core tuning loop) |

`/routing-stats` renders the above as a table; raw records remain in the session JSONL for offline analysis. This is the feedback loop that F6 says is missing today.

**Cost/usage extraction note:** the current `spawnSub` parses `message_update.text_delta` and `tool_execution_start` only. To populate `l3.usage`, port the `message_end` handler from `examples/extensions/subagent/index.ts:329-345`, which reads `msg.usage.{input,output,cacheRead,cacheWrite,cost.total,totalTokens}` and `msg.model`. This is a verified pattern from Pi's own example — not invented.

---

## 7. Worked example — one request, all three layers

**Request:** the operator types to the parent agent:

> "Refactor `src/auth/` to use the new session-token format and update the tests. This is subtle — the token has a new expiry field and the rotation logic has a race I keep hitting."

The parent agent decides this needs delegation and calls the `dispatch` tool with `task = "..."` and **no** `category` (relying on L1).

### L1 — classify
- `mode: "heuristic"` (no explicit category passed).
- Keyword scan: `refactor` → +0.4 `deep`; `subtle`/`race`/`rotation logic` → +0.5 `ultrabrain`; `tests` → +0.1 `deep`; `update the tests` (not "write tests") → no `writing` boost; no `.tsx`/`.css`/image → no `visual-engineering`; length > 120 chars → blocks `quick`.
- Scores: `ultrabrain 0.55`, `deep 0.50`, `unspecified-high 0.30`.
- Top-2 within 0.1 → **tie → uncertain**. Per §5, emit `routedBy: "fallback-low"`? *No* — top score ≥ 0.5, so we pick the leader: `category: "ultrabrain"`, `confidence: 0.55`, `alternatives: [{deep,0.50},{unspecified-high,0.30}]`.
- `classifyMs: 0.3` (heuristic, sync).
- *Note:* if the parent had passed `category: "deep"` explicitly, L1 would run `mode: "explicit"`, `confidence: 1.0`, `routedBy: "explicit"`, `classifyMs: 0`. (Back-compat path.)

### L2 — resolveRoute
- `category: "ultrabran"` → `TIERS.ultrabrain` = `{zai-coding-cn, glm-5.2, thinkingLevel: "xhigh"}`.
- Context overlays:
  - `peak = isPeakHours()` — say it's 14:00 UTC (summer Berlin = 16:00 local, off-peak) → `peak: false`.
  - `promoActive = isPromoActive()` — date is 2026-07-05, before `PROMO_SUNSET_ISO` (2026-09-30) → `true`.
  - `quotaCostX = quotaCostX("glm-5.2", {peak:false, promoActive:true}) = 1`.
  - `available.has("zai-coding-cn/glm-5.2")` → true (Z AI built-in, key configured).
  - No `personaOverride`.
- Decision: `{modelFlag: "zai-coding-cn/glm-5.2", thinkingLevel: "xhigh", effort: "high", source: "tier-map", quotaCostX: 1, availabilityChecked: true, peak: false, promoActive: true, rationale: "ultrabrain → glm-5.2 @xhigh; PROMO 1× off-peak; available."}`. `resolveMs: 0.5`.
- *Counterfactual:* if it were 07:00 UTC (peak), `quotaCostX = 3` and `downshiftTarget("ultrabrain","peak")` would return `"deep"` (still glm-5.2 but at `high` not `xhigh`, lowering effort not cost — *or* if budget pressure, `"unspecified-low"`). The decision would carry `source: "downshift-peak"`, `downshiftReason: "peak"`. Today's code cannot do this (F2).

### L3 — dispatchWithRetry
- **Attempt 1:** spawn `pi --mode json -p --no-extensions --tools read,bash,grep --session <file> --thinking xhigh --model zai-coding-cn/glm-5.2 "<task>"`. Widget shows `● #42 [ultrabrain] zai-coding-cn/glm-5.2 · xhigh · 12s · tools:7`.
- Stream parses: 7 `tool_execution_start` events (read/grep/bash), final `message_end` with `usage = {input: 18400, output: 6200, cacheRead: 15000, cacheWrite: 0, cost: {total: 0.0}, contextTokens: 24600, turns: 4}`. (Cost $0 — Z AI Coding Plan is quota-based, not dollar-based; the `cost.total` from the stream will be 0 for Z AI models. The *quota cost* is `l2.quotaCostX` × baseline, tracked separately. See open questions §8.)
- Exit `code: 0`. `exitReason: "done"`. No retry.
- `attempts: 1`, `finalModel: "zai-coding-cn/glm-5.2"`, `retried: false`, `downshifted: false`.
- `elapsedMs: 48000`.

### Log record written
```json
{
  "customType": "dispatch-log",
  "category": "ultrabrain",
  "modelFlag": "zai-coding-cn/glm-5.2",
  "thinkingLevel": "xhigh",
  "source": "tier-map",
  "outcome": "done",
  "elapsedMs": 48000,
  "task": "Refactor src/auth/ to use the new session-token format...",
  "l1": { "routedBy": "heuristic", "confidence": 0.55,
          "alternatives": [{"category":"deep","score":0.50},{"category":"unspecified-high","score":0.30}],
          "signals": {"matchedKeyword":"refactor","tieWith":"deep"},
          "classifyMs": 0.3 },
  "l2": { "effort": "high", "quotaCostX": 1, "availabilityChecked": true,
          "peak": false, "promoActive": true, "resolveMs": 0.5 },
  "l3": { "exitReason": "done", "attempts": 1,
          "finalModel": "zai-coding-cn/glm-5.2", "retried": false, "downshifted": false,
          "usage": {"input":18400,"output":6200,"cacheRead":15000,"cacheWrite":0,"cost":0,"contextTokens":24600,"turns":4} }
}
```

### Tool result returned to the parent agent
```
[ultrabrain (L1:0.55 heuristic, tie w/ deep) → zai-coding-cn/glm-5.2 @xhigh · 1× quota · 48s · 1 attempt] sub-agent done:

<the refactored code and test summary, truncated to 6000 chars as today>
```

The parent now has the *provenance* of the routing, not just the output — it can see the L1 tie and, if it disagrees, re-dispatch with `category: "deep"` explicitly.

### What would have been different today
- L1 wouldn't exist: the parent would have had to read all 9 category descriptions and pick. If it picked `quick` by mistake, the task would run on `glm-4.5-air` and likely fail — no retry, no downshift, no log of *why* `quick` was chosen.
- L2 wouldn't downshift on peak: a 07:00-UTC dispatch would silently cost 3× quota.
- L3 wouldn't retry: a transient Z AI 429 would return "failed" with no recovery and no `usage`/cost capture.

---

## 8. Open questions / risks / things to probe before implementation

Ordered by how much they block the design.

1. **`getAvailable()` cost and caching (blocks F4).** `docs/sdk.md:386` documents it as async and implies it probes API keys. Calling it on every dispatch may be slow or may hit rate limits. Need to probe: (a) how long does `await ctx.modelRegistry.getAvailable()` take? (b) Is it safe to memoize per-session, or do keys rotate (e.g. opencode OAuth refresh) mid-session? *Lean:* memoize for the session, invalidate on `model_select` event. Validate with a probe before shipping.

2. **Is the parent LLM actually mis-classifying today? (blocks the whole L1 investment).** The design assumes F1 is real. To prove it: instrument the *current* `dispatch` tool to log `(category_chosen, task_text)` for ~2 weeks, then hand-label a sample. If mismatch rate < 5%, skip the LLM L1 and keep heuristic-only. If > 20%, the LLM L1 pays for itself. *This is the single most important probe* — without it, L1 is speculative.

3. **Z AI quota is not exposed via API (blocks true budget guards).** `PROBE-RESULTS.md` confirms exhaustion = hard fail, and the FAQ gives no "remaining quota" endpoint. So `budget.remainingQuotaX` can only be *locally estimated* by summing `l3.usage` × `l2.quotaCostX` from the log. How accurate is that estimate against the real 400/5h and 2000/week limits? Unknown until we correlate log sums against actual exhaustion events. *Lean:* ship the estimator as advisory only; never hard-block a dispatch on it.

4. **`ctx.signal` wiring in `spawnSub` (concrete bug).** The current `index.ts` does not pass `signal` into the spawn or attach an abort listener — Esc during a dispatch does not kill the subprocess (the subagent example does, via `proc.kill` on abort). Confirm by reading the live code path during a dispatch with Esc; if confirmed, this is a standalone fix independent of the 3-layer work.

5. **Structured-output reliability for the LLM L1.** If we ship `classifyWithLlm`, it needs to return parseable JSON. Two paths: (a) prompt `glm-4.5-air` with "respond ONLY with JSON" and parse (fragile), or (b) use the `terminate: true` structured-output tool pattern (`docs/extensions.md` "Early termination" + `examples/extensions/structured-output.ts`) in a one-shot sub-call. Probe which is more reliable on glm-4.5-air specifically. *Lean:* (b), the tool pattern.

6. **Persona `model:` override precedence (HANDOFF #2, #7).** When `~/.pi/agent/agents/*.md` frontmatter sets `model:`, does it (a) bypass L2 entirely (hard override), or (b) bias L2 (preferred but L2 may downshift for availability)? The HANDOFF says "persona > category tier > fallback" but that predates the availability precheck. *Decision needed:* I recommend (a) hard override *but* still subject to availability — if the persona's model is unavailable, L2 downshifts and logs `source: "persona-override-unavailable"`. Probe: does `examples/extensions/subagent/agents.ts:parseFrontmatter` already expose what we need? (Yes — `frontmatter.model` is read; we reuse it.)

7. **Promo sunset cutover (2026-09-30 — corrected to match `tier-map.ts PROMO_SUNSET_ISO`; was mis-stated as 10-30).** `isPromoActive()` flips false. Every `deep`/`ultrabrain`/`unspecified-high` dispatch doubles in quota cost. The router handles this automatically (it calls `isPromoActive()` per dispatch), *but* the operator will want a heads-up. Add a `/routing-stats` banner when `!isPromoActive()` and recent `quotaCostX===2` dispatches exceed some threshold. Low-risk, but needs a decision on the threshold.

8. **Concurrency: L1 per-dispatch vs batched.** If the parent fires 4 parallel `dispatch` calls (the widget already supports parallel subs via the `Map<number, SubState>`), heuristic L1 is free so per-dispatch is fine. LLM L1 would fire 4 classifier calls. *Decision:* heuristic = per-dispatch; LLM = deferred until measured (see Q2). Don't build batching speculatively.

9. **Does `cost.total` in the event stream actually populate for Z AI?** The subagent example reads `msg.usage.cost?.total`. For quota-based plans (Z AI Coding Plan), this is likely `0` (no dollar metering), meaning our cost observability is really *quota-cost* observability via `l2.quotaCostX`, not dollar cost. Confirm by running one dispatch and inspecting the `message_end` event. Affects how `/routing-stats` labels its cost column.

10. **Test fixtures for L1.** Unit-testing the heuristic requires labeled `{task, expectedCategory}` pairs. None exist. Building a ~50-example fixture set is a prerequisite for any iteration on L1 keywords and for measuring Q2's mismatch rate. *Concrete first task* if this design is approved.

---

## 9. TL;DR

- **Three routing layers** (classify → select → dispatch) on top of Pi's model **catalog** (relabeled Layer 0 to avoid the HANDOFF's L1/L2/L3 collision).
- **L1 (`intent.ts`, new):** heuristic classifier first, LLM classifier only if measurement justifies it. Emits `{category, confidence, routedBy, alternatives}`. Never touches models.
- **L2 (`tier-map.ts`, extended):** new `resolveRoute(RouteInput)` wraps the existing `resolveModel()`, finally *calling* the currently-dead `isPeakHours()`/`isPromoActive()` exports, adding availability precheck and persona override. `resolveModel()` and all current exports unchanged.
- **L3 (`index.ts` extended + `router.ts` new):** retry/fallback policy by failure class, `ctx.signal`→proc wiring, `usage`/cost extraction from the event stream, three-layer log record. Spawn arg pattern (PROBE-verified) untouched.
- **Back-compat:** `dispatch`'s `category` param becomes optional — explicit category runs L1 in zero-cost `explicit` mode, identical to today. No prompt retraining.
- **The loop-closer:** `/routing-stats` reads `dispatch-log` back, turning the write-only log into the tuning loop the operator asked for (HANDOFF #6).
- **Biggest open question:** is L1 worth building at all? Answer with the §8 Q2 probe (instrument current dispatches, label a sample) *before* committing to the LLM L1. The heuristic L1 and the L2/L3 hardening are worth doing regardless.
