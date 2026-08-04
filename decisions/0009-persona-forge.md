# 0009 — `persona-forge` Meta-Agent

## Status

**SHIPPED** — v1 implements `/persona-forge evolve <target>` and `/persona-forge approve <new-id>`.

## Context

The roster in `~/.pi/agent/teams.yaml` already supports provenance metadata (`source`, `generated_by`, `review_status`, `parent`) for generated agents. The `generated-reviewers` team exists as a holding area for pending variants. The missing piece was the generator: a meta-agent that takes an existing persona, identifies a gap, drafts a specialized variant, reviews it with `momus`, and queues it for operator approval.

## Goals

- Cut thick-prompt maintenance by evolving focused variants from existing personas.
- Fix the “live-docs gap” by generating new agents in response to observed behavior rather than hand-authoring them.
- Keep all generated agents under the existing provenance + review-status model.

## Non-goals

- **Generate-from-scratch** is out of scope for v1; we start with `evolve` because it has a parent + a concrete gap.
- **Auto-approve** is out of scope; every generated agent starts as `review_status: pending` and requires operator approval.
- **Self-modifying system prompts** are out of scope; the primary performs the file writes after confirmation.

## Design

### Primary-owns-writes

`/persona-forge` is a two-stage primary command:

1. **`/persona-forge evolve <target>`** — dry-run. Runs the chain, shows the generated `.md`, the `momus` verdict, and the proposed `teams.yaml` diff. **No writes.**
2. **`/persona-forge approve <new-id>`** — after the operator views the output and confirms, the primary writes `agents/<new-id>.md` and appends the entry to `teams.yaml` with provenance.

This mirrors the `git-commit-message` pattern: the chain does the expensive reasoning, the primary does the irreversible writes.

### Evidence gathering

The primary reads the target persona and any other evidence it already has (e.g., `/routing-stats` output, recent dispatch failures) and passes it as text in the chain’s task input (`$ORIGINAL`). The chain steps do not read session files or raw routing logs themselves — the headless sub-agents cannot access the parent’s aggregation logic.

### Chain: `persona-forge-evolve`

Three steps defined in `~/.pi/agent/agent-chain.yaml`:

| Step | Agent | Category | Model | Purpose |
|------|-------|----------|-------|---------|
| `analyze` | `oracle` | `unspecified-low` | `glm-4.7` | Reason over the evidence; identify a clear gap |
| `generate` | `builder` | `unspecified-high` | `glm-5.2` | Draft the new persona markdown file |
| `review` | `momus` | `unspecified-low` | `glm-4.7` | PASS / WARNING / FAIL on scope, tools, model, safety |

The generate step is the only one on the flagship model; analyze and review are cheap tiers to keep the meta-agent economical.

> **_[Footnote 2026-07-13 — all three Model cells + the "flagship/cheap" framing above are superseded.]_**
> Current `agent-chain.yaml` + `tier-map.ts` (source of truth): `analyze` = `ultrabrain` → `glm-5.1`
> (was `unspecified-low`/glm-4.7, fixed 2026-07-12); `generate` = `unspecified-high` → **`glm-5-turbo`**
> (was glm-5.2, 2026-07-13 tier-map sync); `review` = `ultrabrain` → `glm-5.1` (was
> `unspecified-low`/glm-4.7, fixed 2026-07-12). The "analyze/review are cheap tiers" framing no longer
> holds — all three steps now run on high-effort reasoning tiers (07-12 bumped analyze/review to
> `ultrabrain` because `unspecified-low` was too weak for gap-analysis/verdict work). The chain
> *structure* (3 steps, `returnAllSteps`) is unchanged; live values in `agent-chain.yaml`.
>
> **_[Footnote 2026-08-04 — `ultrabrain` model cell above superseded again.]_** The 2026-07-13 footnote's `analyze`/`review` = `ultrabrain` → **`glm-5.1`** is now stale: `ultrabrain` primary is **`opencode-go/kimi-k3`** (per current `tier-map.ts` + README). `generate` = `unspecified-high` → `glm-5-turbo` remains current. So persona-forge now runs: analyze/review on `opencode-go/kimi-k3` (reasoning model), generate on `zai-coding-cn/glm-5-turbo`. The "all three on high-effort reasoning tiers" framing still holds. Live values: `agent-chain.yaml` + `tier-map.ts`.

### Chain data-flow fix: `returnAllSteps`

`run_chain` returns only the final step’s output by default. `persona-forge` needs the intermediate `generate` output (the new `.md`) while still seeing the final `review` verdict.

**Decision:** add a `returnAllSteps: boolean` option to `run_chain` (default `false`, non-breaking). When `true`, the response text includes every step’s output. The `persona-forge` command handler uses the same shared runner with `returnAllSteps: true` and reads the `generate` step result from `stepResults`. This is a general chain enhancement, not a persona-forge hack.

### Location

- `~/.pi/agent/agent-chain.yaml` — the live `persona-forge-evolve` chain definition.
- `~/.pi/agent/extensions/chain-runner.ts` — shared `loadChains()` and `runChainByName()` used by both the `run_chain` tool and `persona-forge`.
- `~/.pi/agent/extensions/agent-chain.ts` — the `run_chain` tool and `/chain`/`/chain-list` commands.
- `~/.pi/agent/extensions/persona-forge.ts` — the primary command that invokes `persona-forge-evolve` via `runChainByName()` and handles the approve/write flow.
- `~/.pi/agent/agents/<new-id>.md` — generated artifact (written by primary).
- `~/.pi/agent/teams.yaml` — roster entry under `generated-reviewers` (written by primary).

### Safety / governance

- **Deny-additive roster writes.** `persona-forge` can only add new agents; it cannot remove or override handcrafted agents.
- **No model pins.** Generated personas inherit the category tier; a pinned model is rejected at the review stage unless justified.
- **Mandatory provenance.** Every generated entry has `source: generated`, `generated_by: persona-forge@v1`, `review_status: pending`, and `parent: <target>`.
- **Fail-closed approve.** `approve` refuses to write if the `momus` verdict is `FAIL`. `FAIL` means the operator must re-run `evolve` with correction guidance.
- **Double-gate.** `evolve` never writes; `approve` requires a second explicit `ctx.ui.confirm` before touching the file system.

## Files touched

- `~/.pi/agent/extensions/agent-chain.ts` — added `returnAllSteps` option.
- `~/.pi/agent/extensions/chain-runner.ts` — shared chain loader + runner used by `run_chain` and `persona-forge`.
- `~/.pi/agent/agent-chain.yaml` — added `persona-forge-evolve` chain.
- `~/.pi/agent/extensions/persona-forge.ts` — new extension; invokes the chain via `runChainByName()`.
- `~/.pi/agent/extensions/orchestration-engine/tier-map.ts` — fallback changed to `opencode/glm-5.1`.
- `~/.pi/agent/README.md` — updated backlog and extension list.

## Validation

1. `/persona-forge evolve reviewer` runs all three steps and shows the generated `.md` + momus verdict in the editor.
2. `/persona-forge approve <new-id>` writes `agents/<new-id>.md` and appends the roster entry with `review_status: pending`.
3. `run_chain({ chain: "persona-forge-evolve", returnAllSteps: true, task: "..." })` returns all three step outputs.
4. A `FAIL` verdict blocks the `approve` command.

## Open questions

1. Should `evolve` accept a `gap` or `evidence` argument so the operator can seed the analysis with specific failures? (Likely v2.)
2. Should the `approve` command automatically flip `review_status: approved` to `pending` after a manual smoke-test dispatch? (Likely v2 — status stays manual for now.)
3. Should `persona-forge` support a `write` subcommand that skips the in-memory pending map and writes immediately with `pending` status? (No — keep the double-gate.)

## Related

- ADR 0007 (team selector) — provenance model and `generated-reviewers` team.
- ADR 0008 (chain primitive) — the `run_chain` primitive and `returnAllSteps` enhancement.
