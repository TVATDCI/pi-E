# Orchestration Engine — Model Routing Handoff (v2)

**Date:** 2026-07-04 · **Status:** L1 ✅ · L2 ✅ · L3 (dispatch tool) ⬜ open
**For:** sisyphus agent + operator. **Read PROBE-RESULTS.md first** — every model decision here is probe-verified, not assumed.

---

## The 3 layers

| Layer | Role | Owner | Artifact | Status |
|-------|------|-------|----------|--------|
| 1 | What models exist + specs | Pi core (`models.json` + built-ins) | `~/.pi/agent/models.json` | ✅ done |
| 2 | Which model for which task | This extension | `tier-map.ts` (v2) | ✅ done |
| 3 | Spawn the subprocess with the chosen model | This extension (TBD) | `index.ts` (TBD) | ⬜ open |

**Why two layers:** L1 makes a model *spawnable*; L2 *picks* one. Specs in L2 → invisible to Pi. Expecting L1 to route → still defaults to parent model.

---

## Layer 1 — `models.json` is now `{"providers": {}}`

All 5 plan-eligible text models are **Pi built-ins** under `zai-coding-cn`: glm-5.2, glm-5.1, glm-5-turbo, glm-4.7, glm-4.5-air. The file defines nothing custom.

**What was removed and why:**
- `zai` provider block — redundant, caused the `--model` ambiguity.
- `glm-5.2` override under `zai-coding-cn` — **broke the spawn's `--thinking off` flag** (set `off:null`). Built-in restored; `off` now works. (Verified: built-in `thinkingLevelMap` has no `off` key → supported.)
- `glm-4.7-flashx`, `glm-4-32b-0414-128k` (added in v1 draft) — **probe showed NOT on plan** (code 1113). Removed; would hard-fail.

**Verified:** `pi --list-models` shows 6 models under `zai-coding-cn` (5 plan + glm-5v-turbo which is listed but returns 1311 at call time).

⚠️ **No `baseUrl` override** — built-in `zai-coding-cn` uses `https://open.bigmodel.cn/api/coding/paas/v4`, the GLM Coding Plan dedicated endpoint. Overriding breaks plan routing.

---

## Layer 2 — `tier-map.ts` v2

**Categories PORTED from `oh-my-openagent.json`** (not invented). In OmO, `sisyphus-junior` is literally the "Category executor" — these names are the dispatch vocabulary of the existing hedge. Models remapped from the Claude/GPT/opencode mix to Z AI plan primary.

| Category | Provider/Model | Thinking | Quota | Why |
|----------|----------------|----------|-------|-----|
| `quick` | `zai-coding-cn/glm-4.5-air` | off | 1× | cheapest plan tier |
| `unspecified-low` (default) | `zai-coding-cn/glm-4.7` | off | 1× | routine low-effort |
| `unspecified-high` | `zai-coding-cn/glm-5.2` | high | 1×→2× | high-effort fallback |
| `deep` | `zai-coding-cn/glm-5.1` | high | 1× | autonomous research; OmO consolidated 5.2 (LR-0019) |
| `ultrabrain` | `zai-coding-cn/glm-5.1` | high | 1× | hardest logic; OmO variant=high (LR-0019) |
| `writing` | `zai-coding-cn/glm-4.7` | medium | 1× | prose/docs; OmO downshifted 5.1→4.7 (LR-0019) |
| `visual-engineering` | `zai-coding-cn/glm-5.1` | high | 1× | UI/frontend code = text; OmO moved off 5v-turbo (LR-0019) |
| `artistry` | `zai-coding-cn/glm-5.1` | high | 1× | creative; OmO standardized on Z AI (LR-0019; loses gemini-domain strength) |
| `git-commit-message` | `opencode/deepseek-v4-flash-free` | off | FREE | preserves plan quota; OmO keeps this category opencode-primary by design (operator reverted an interim glm-4.5-air) |

> **_[Footnote 2026-07-13 — 2 table rows + the fallback-chain line below are superseded.]_**
> Per the current `tier-map.ts` (post OmO-2026-07-12-rebalance sync): `unspecified-high` and
> `visual-engineering` are now **`glm-5-turbo`** (not `glm-5.2` / `glm-5.1` as the rows above
> state). The global `FALLBACK` referenced below in “tier → glm-5.2 → throw” is
> **`opencode/glm-5.1`** (the code-level `FALLBACK` const), not glm-5.2. The table above is the
> original 2026-07-08 v2 record; live values live in `tier-map.ts` `TIERS` + `README.md`.

8/9 categories are Z-AI-plan-primary (LR-0019); git-commit-message stays on the FREE opencode tier by design. opencode survives in OmO fallback chains (not modeled here), the `explore` agent, the `git-commit-message` category, and multimodal-looker's fallback.

**Exports:** `TIERS`, `resolveModel(cat, registry, opts?)`, `listTiers(registry)`, `isPromoActive()`, `isPeakHours()`, `PROMO_SUNSET_ISO`. Types: `TaskCategory`, `TierEntry`, `ResolvedModel`, `ModelRegistryLike`.

**Engineering guarantees (unchanged from v1):** framework-agnostic (`ModelRegistryLike` → unit-testable), fallback chain (tier → glm-5.2 → throw, never silent), every resolution carries `rationale` + `source`.

**Compiles clean** under `~/.pi/agent/tsconfig.json` (strict, ES2022).

---

## ⚠️ Reversals from v1 (read before logging as a learning record)

1. **Category names: Pi-native → PORTED from OmO.** v1 proposed `exploration/architecture/review/…`. v2 ports `quick/deep/ultrabrain/…`. Reason: this is a port, not a fresh build. OmO's categories are the dispatch vocabulary sisyphus-junior executes; renaming forces retraining prompts/skills/muscle memory. Sisyphus's "don't cargo-cult" concern is mitigated: the category names are intent labels (model-agnostic), not Claude/GPT model names — remapping models doesn't invalidate the vocabulary. **Flag for sisyphus: this reverses the earlier fork.**

2. **5-turbo agents: "downgrade to 4.7" → "keep glm-5-turbo".** v1 flagged atlas/sisyphus-junior/archivist as a budget leak. The OmO overview doc corrects this: all three are **agent-loop execution** roles (delegation, category-dispatch, tool-heavy file ops), which is *exactly* Z AI's positioning of glm-5-turbo ("optimized for OpenClaw scenario — tool invocation, long-chain execution"). Keep 5-turbo for all three. Caveat: 5-turbo carries the same 2×/3× multiplier as 5.2 — free during promo (1× off-peak through Sep 30), 2× after. Revisit quota math in October. **LR-0019 update:** OmO later demoted *atlas* alone to `glm-4.7` (sisyphus-junior + archivist kept 5-turbo). The port should follow: atlas → glm-4.7.

3. **Vision: removed from the plan-tier assumption.** glm-5v-turbo returns 1311 on the Coding Plan endpoint. Vision routes to opencode gemini (honest fallback). The plan's "Vision Understanding" benefit is the MCP server, not the model. **LR-0019 resolution (2026-07-06):** docs confirmed glm-5v-turbo is STANDARD-API-only (`/api/paas/v4/`, pay-as-you-go), not the Coding Plan (`/api/coding/paas/v4/`) — so 1311 is correct for the plan endpoint, not a stale result. Operator routed multimodal-looker to `opencode/gemini-3.1-pro` primary (Option A). No OmO primary uses glm-5v-turbo now.

---

## ⚠️ LR-0019 reconciliation (2026-07-06) — category map aligned to OmO reconfiguration

OmO reconfigured all 16 agents + 9 categories to `zai-coding-plan` PRIMARY with `opencode` FALLBACK. This tier-map (a port of OmO categories) was reconciled to match. **5 categories changed** (see table above): `deep` 5.2→5.1, `ultrabrain` 5.2/xhigh→5.1/high, `writing` 5.1→4.7, `visual-engineering` gemini→glm-5.1, `artistry` gemini→glm-5.1. `git-commit-message` was reconciled to glm-4.5-air then **reverted by the operator** back to `opencode/deepseek-v4-flash-free` (FREE external, preserves plan quota — the one category OmO deliberately keeps off Z AI plan). Three of the 5 were **OmO-driven** (visual-engineering/artistry moved off opencode — divergence reason moot); two were **load-balancing** (deep/ultrabrain/writing — OmO consolidated 5.2 to 4 reasoning agents + unspecified-high, concurrency 2 saturated). **One residual trade-off flagged:** artistry loses gemini's creative-domain strength (revert if it bites). **glm-5v-turbo (was multimodal-looker primary): RESOLVED.** Docs (https://docs.z.ai/guides/vlm/glm-5v-turbo) confirmed it lives on the STANDARD Z.AI API (`/api/paas/v4/`, pay-as-you-go), NOT the Coding Plan (`/api/coding/paas/v4/`) — the 1311 was correct for the plan endpoint, not stale. Operator switched multimodal-looker to `opencode/gemini-3.1-pro` (Option A); no OmO primary uses glm-5v-turbo now. Full record: Main-vault `learning-records/0019-omO-model-reconfiguration.md`.

---

## ⚠️ The "Turbo ≠ cheap" correction (LR-worthy, per sisyphus)

Confirmed by probe AND FAQ:21 — glm-5-turbo is **plan-eligible but carries the same 2×/3× multiplier as glm-5.2**. It is an agent-loop-optimized model, NOT a budget tier. Routing "exploration/review" to it (the operator's original instinct) burns flagship-tier quota. The real 1× plan tiers are glm-4.5-air, glm-4.7, glm-5.1. This alone is worth a learning record.

---

## Layer 3 — open work (the dispatch tool)

**Goal:** a Pi extension tool whose `execute()`:
1. Receives `{ task, category }` from the parent agent.
2. Calls `resolveModel(category, ctx.modelRegistry)` → `modelFlag`.
3. Spawns `pi` with `--model modelFlag`, parses JSON event stream.
4. Returns the sub-agent's output as the tool result. Logs `{category, modelFlag, rationale, source}` for observable tuning.

**Verified spawn pattern (operator-provided):**
```ts
const r = resolveModel(category, ctx.modelRegistry);
const proc = spawn("pi", ["--mode","json","-p","--no-extensions",
  "--tools","read,bash,grep","--thinking","off",
  "--session", sessionFile,
  "--model", r.modelFlag, task],
  { stdio:["ignore","pipe","pipe"], env:{...process.env} });
```

**Reference impl:** `examples/extensions/subagent/index.ts:294-340` (spawn), `agents.ts:11-19` (persona frontmatter `model:`).

### Open L3 design decisions (4 — see earlier sisyphus pass for Q1-Q4)

1. **Category source:** EXPLICIT (operator-LLM picks category enum, no keyword matching). ✅ agreed (sisyphus Q1). The category descriptions in the tool-def schema ARE the routing instruction — load-bearing text.
2. **Precedence:** persona `model:` frontmatter > category tier > fallback. ✅ agreed (sisyphus Q2). **Refinement:** persona-overrides that deviate from the category tier must be LOGGED (`source: "persona-override"`), not silent — else budget guardrail is invisible. This logic lives in L3, not tier-map.ts.

   **⚠️ REVERSAL (2026-07-08, Tier 0a):** `builder.md`'s `model: zai-coding-cn/glm-5.2` pin was REMOVED — it silently overrode the category cost tier in **8 of 9 categories** (all except `unspecified-high`). Blast radius: `git-commit-message` 5.2→FREE (deepseek-v4-flash-free), `quick` 5.2→glm-4.5-air, `unspecified-low`/`writing` 5.2→glm-4.7, `deep`/`ultrabrain`/`visual-engineering`/`artistry` 5.2→glm-5.1 (**intended per LR-0019** — OmO consolidated these to 5.1; builder's pin was reversing that), `unspecified-high` 5.2→5.2 (unchanged). After reversal: 0 of 8 personas pin. _[Editorial note 2026-07-09: persona count is now **7** — `scout` was merged into `explore` (commit `bf8a3d4`); the "0 pin" finding still holds — no persona carries a `model:` pin.]_ Override FEATURE retained for future use; logging guardrail already satisfied (`index.ts:248` emits `source:"persona-override"`). Ceiling-vs-override design question deferred to the 3-layer `resolveRoute()` (3-LAYER-ROUTING-DESIGN.md §8 Q6). **Do NOT** write "only deep changes" — false (only `unspecified-high` is unchanged), corrupts future dispatch-log tuning.
3. **Modes:** single-dispatch for the port; parallel/chain are Tier-2 compositions built on top later. ✅ agreed (sisyphus Q3).
4. **Config form:** B1 (TS const) now; B2 (tiers.json) later. ✅ agreed (sisyphus Q4). jiti reloads TS on `/reload` so no build-step friction.

### NEW open L3 decisions (from v2 work)

5. **Thinking level per category.** The verified spawn hardcodes `--thinking off`. But `architecture`/`ultrabrain` on glm-5.2 (a reasoning model) with thinking off leaves capability on the table. tier-map.ts now carries `thinkingLevel` per category (preserved from OmO `variant`). **L3 decides: honor it, or stay `off`?** Lean: honor it (the map already encodes the right levels).
6. **Observable tuning (operator's "difficult to say how clever" insight).** Operator can't pre-judge model-fit per agent. Design requirement: L3 logs every dispatch (category → model → rationale → outcome) so the operator tunes from real data after ~2 weeks. The logging hooks are already in tier-map.ts (`rationale`, `source`).
7. **Persona port scope.** OmO has 15 named agents (sisyphus, hephaestus, oracle, explore, librarian, multimodal-looker, prometheus, metis, momus, atlas, sisyphus-junior, archivist, athena, auditor, post-reviewer, reviewer). 1:1 port to `~/.pi/agent/agents/*.md`? Triage which are load-bearing? **Open — operator to decide.** Each `.md` frontmatter carries `model:` (per Q2 precedence).

---

## Quota budget (Pro Plan, Berlin operator)

- 2,000 prompts/week, 400/5h. One prompt ≈ 15-20 model calls ≈ one dispatch.
- Operator works outside peak (08:00-12:00 Berlin) → 3× multiplier never bites.
- Through Sep 30: glm-5.2 == glm-4.7 off-peak (1×). Exploit aggressively.
- After Oct 1: glm-5.2/glm-5-turbo = 2× off-peak. The cheap defaults (glm-4.5-air, glm-4.7) re-earn their place for routine work.

---

## File map

```
~/.pi/agent/
├── models.json              # L1: {"providers":{}} — all plan models are built-ins
├── models.json.bak          # pre-change backup (v0, with zai block + glm-5.2 override)
└── extensions/orchestration-engine/
    ├── tier-map.ts          # L2 v2 (ported categories, plan-aware)
    ├── PROBE-RESULTS.md     # empirical plan-support evidence
    └── HANDOFF.md           # this file
```

## Sources cited (for verification)
- **Pi:** `docs/models.md:194-264` (schema, merge), `docs/sdk.md:368-404` (`find`/`getAvailable`), `docs/extensions.md:933,1574-1585` (`ctx.modelRegistry`), `docs/usage.md:182` (`--model`), `examples/extensions/subagent/index.ts:294-340`
- **Z AI:** `/devpack/overview` (plan tiers, multiplier), `/devpack/faq.md:11,21,66-69,236` (multiplier, no-fallback, model claims), `/devpack/latest-model` (glm-4.5-air on plan)
- **OmO:** `oh-my-openagent.json` (config), `docs/guide/overview.md` (architecture, agent roles, category system)
- **Empirical:** `/tmp/zai-probe.mjs` → PROBE-RESULTS.md
