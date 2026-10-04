---
name: model-tiers
description: Choosing a model tier or dispatch category — cheap vs strong routing, thinking-level defaults, Ctrl+P tier toggle, and the no-cheap-model-at-judging-node rule for review/verify/oracle dispatches.
user-invocable: false
metadata:
  internal: true
---

## Model selection

**enabledModels:** `zai-coding-cn` + `opencode` pairs (`glm-5.3` strong / `glm-5.3-flash` fast) — `Ctrl+P` toggles tiers. Cheap/fast: exploration, search, bulk mechanical edits. Strong: planning, synthesis, gate review, hard debugging; thinking starts `high`, raise only for genuinely hard problems. **Config authority: tier-map.ts** (dispatch categories, fallback chains). **Dispatch-tier routing:** trivial mechanical work → cheap tier; synthesis reserved to strong.

- **No cheap model at a judging node.** Review, verify, and oracle dispatches
  (`unspecified-high`→reviewer, `deep`→morpheus, `security-review`→security-reviewer,
  `ultrabrain`→oracle/neo) must use a strong-tier category. All judging
  categories' primaries AND fallback chains land only on strong-tier flagships
  (glm-5.x / kimi / grok-4.6 / qwen3.8-max / gpt-5.6-luna — see the
  STRONG-MODEL-AT-JUDGING block in tier-map.ts; security-review's per-tier chain
  is glm-family-only) — never on FREE/cheap tiers
  (deepseek-v4-flash-free / ling-*-flash-free / minimax-m2.7). One bad
  cheap-model review among parallel reviewers cascades through the whole graph
  and can't be traced.
