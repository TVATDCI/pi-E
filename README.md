# pi · agent (`~/.pi/agent`)

> A **cost-disciplined, methodology-heavy personal system** built on the [Pi Coding Agent](https://github.com/earendil-works/pi) core. Philosophy: _ride pi's native features; add only what cost-discipline + the planning methodology need. Don't port other tools' machinery — adopt disciplines by fitness, reject the rest with stated reasons._ (See `AGENTS.md`.)

This is **not** a showcase. It's a single-operator production config: narrow and deep where it matters (routing economics, safety policy, specialist prompts, governance), intentionally thin everywhere else (1 theme, no cosmetic widgets).

---

## At a glance

|                        |                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------- |
| **Pi version**         | `0.84.2` (npm: `@earendil-works/pi-coding-agent`)                               |
| **Provider (primary)** | `zai-coding-cn` — Z-AI Coding Plan (quota-based, **no** balance fallback)       |
| **Default model**      | `glm-5.3` @ `high` thinking, theme `encom`                                      |
| **Extensions**         | 19 active top-level + 6 subpackages (`orchestration-engine/`, `memory/`, `budgets/`, `security/`, `lib/`, `tests/` — 0 disabled) — incl. chain widget, acceptance gates, clarify, background dispatch, compaction capture, command guard |
| **Agents**             | 15 (7 personas + 8 Matrix operatives; 0 model pins)                             |
| **Governance**        | 13 ADRs in `decisions/`; 10 pi-native skills in `skills/`                       |
| **Secondary providers** | `opencode` + `opencode-go` (FREE/external tiers — `quick` & `git-commit-message` primaries, `deep` & `ultrabrain` primaries, many fallbacks) |

---

## Quick start

```bash
pi                         # launch (loads extensions from ~/.pi/agent/extensions/)
dispatch …                 # delegate a sub-task (the core tool)
                           #   dispatch(category="deep")                    → morpheus (auto-resolved; no agent=)
                           #   dispatch(category="quick", agent="morpheus") → explicit agent wins (KEY INVARIANT)
/team <name>               # select active roster for dispatch/chain
/chain <name>              # select active sequential agent pipeline
run_chain({ task: … })     # execute the active chain (e.g., commit-message)
run_chain({ …, clarify: true })    # preview/edit overlay first (task + per-step model/thinking/prompt)
run_chain({ …, background: true }) # fire-and-forget: returns now, toast on completion (/stop <runId>)
/chain-clarify <chain> <task…>     # clarify-then-run, direct (no LLM flag needed)
/stop <runId>              # stop a background chain run
/chain-status              # fleet view: all active + recent chain runs at a glance
/chain-transcript <runId>  # tail a running chain's accumulated per-step output
run_chain({ …, context: "…" }) # curated handoff: findings/constraints appended to every step's system prompt
/tiers                     # see the 10 categories × model × REAL availability
/routing-stats             # observability: aggregate dispatch-log across this project
/persona-forge evolve <target>  # generate + momus-review a persona variant
/persona-forge list        # list pending personas
/persona-forge approve <new-id> # write agents/<new-id>.md + teams.yaml
/persona-forge reject <new-id>  # discard a pending persona
/dc-mode abort|continue    # toggle damage-control mode
/note <text>               # persistent in-session note
Remember that …          # persists a fact via memory_remember → ranked + injected next turn
```

---

## Project structure

```
~/.pi/agent/
├── AGENTS.md                 # lean always-on governance (every turn)
├── settings.json             # defaultProvider/Model/thinking, theme, skills path
├── models.json               # provider catalog overrides (currently empty — built-ins used)
├── auth.json                 # provider keys: zai-coding-cn, opencode, opencode-go
├── mini-dc-rules.yaml        # GLOBAL safety floor (deny-additive; projects ADD, can't REMOVE)
├── tsconfig.json
├── bin/                      # vendored CLIs: fd, rg
├── npm/                      # pi-managed extension packages (pi-web-access)
├── themes/encom.json         # the one theme
├── agents/                   # 15 agents: 7 personas + 8 Matrix operatives (.md w/ frontmatter: name/description/tools)
├── decisions/                # 13 ADRs (architecture decision records)
├── skills/                   # 10 pi-native skills (git-commit-message, review-loop, session-close, shell-safety, skill-auditor, skill-creator, git-worktree, decisions, pi-web-search, research-prompt)
├── scripts/                  # bootstrap.sh, run-tests.ts, rotate-memory-md.ts, install-pre-commit.sh
├── agent-chain.yaml          # global chain definitions (deny-additive)
└── extensions/
    ├── orchestration-engine/ # the dispatch tool + tier-map + functional-agent map + observability + team/chain (the core)
    │   ├── index.ts                  # dispatch + /team + /team-list + /routing-stats + /tiers + Cost-Discipline hook
    │   ├── spawn.ts                  # resolveAndSpawn + stable sessions + rotation + usage capture + signal/abort
    │   ├── agent-map.ts              # category → functional-agent default (Tier 2)
    │   ├── tier-map.ts               # category → model map (L2, sole model authority)
    │   ├── routing-stats.ts          # pure aggregation incl. usage (unit-tested)
    │   ├── test-routing-stats.ts     # 13/13 seed tests
    │   ├── 3-LAYER-ROUTING-DESIGN.md # design doc (F1–F6 failure modes; F1 closed, F4/F6 shipped)
    │   ├── HANDOFF.md                # decision/reversal log
    │   └── PROBE-RESULTS.md          # empirical model/plan facts
    ├── memory/                # structured cross-session memory (memory_remember tool + <memory-context> injection)
    │   ├── index.ts                  # session_start hydrate + before_agent_start inject + memory_remember tool
    │   ├── store.ts                  # JsonlMemoryStore: atomic writes, dedup, secret scan, provenance guard
    │   ├── injection.ts              # pure pipeline: rank → budget → format
    │   ├── {classifier,scanner,ranker,budget,formatter,normalizer,schema}.ts  # pure functions
    │   └── test-*.ts                 # 147 assertions + smoke (all green)
    ├── chain-runner.ts        # shared chain loader + runner (+ overrides, acceptance wiring)
    ├── agent-chain.ts         # run_chain + /chain + /chain-list + /chain-clarify + /stop + chain widget + background dispatch
    ├── chain-clarify.ts       # clarify-before-launch overlay (preview/edit task + per-step model/thinking/prompt)
    ├── acceptance.ts          # acceptance gates: provenance badges + enum verify-command table (shell:false)
    ├── background-helpers.ts  # pure helpers: bg dispatch + fleet view + transcript + batched toasts
    ├── persona-forge.ts       # evolve personas, momus review, operator-approved roster writes
    ├── statusline-encom.ts    # encom statusline footer: segment registry, config/presets, customItems, /encom-* commands
    ├── mini-task-tracker.ts   # `task` tool + widget (bd replacement)
    ├── mini-damage-control.ts # safety hooks (fail-closed + deny-additive)
    ├── command-guard.ts       # catastrophic-command seatbelt for bash (fail-open; patterns in ~/.agents/hooks, dotfiles-owned)
    ├── session-notes.ts       # add_note + /note widget
    ├── mini-purpose-gate.ts   # boot intent gate
    ├── prompt-coordinator.ts  # SOLE before_agent_start registrant — composes system-prompt sections in fixed order, dedups memory+bridge overlap
    ├── prompt-observer.ts     # prompt-hash drift detector (agent_start; strips volatile blocks)
    ├── compaction-capture.ts  # hooks session_compact → appends summary to memory.md before discard (narrative)
    ├── compaction-extract.ts  # hooks session_compact → extracts structured facts → store.jsonl (inferred provenance)
    ├── web-research.ts        # keyless search + fetch tools (Wikipedia/DDG-IA/npm/GitHub + w3m text)
    ├── bd-bridge.ts           # READ-ONLY sisyphus→pi memory bridge (before_agent_start; never writes bd)
    ├── herdr-agent-state.ts   # herdr multiplexer integration (vendor-managed; pane state via unix socket)
    ├── budgets/               # turn/tool/usage budget primitives + resolver (pure library, PORT-PLAN ①)
    ├── security/              # yaml-merge.ts — deny-additive YAML layer-merge as versioned security boundary (D5)
    ├── lib/                   # shared: prompt-hash.ts, upstream-adapter.ts (cross-version seam shim, D6), command-guard-core.ts (pure guard core)
    └── tests/                 # 17 test files (node --experimental-strip-types; all green on 0.84.2)
```

---

## Extensions

| Extension                                                                  | LOC | Role                                                                                                                                                    |
| -------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestration-engine/index.ts`                                            | 500 | `dispatch` (functional-agent resolution) + `/team` + `/team-list` + `/routing-stats` (F6) + `/tiers` (F4) + `before_agent_start` Cost-Discipline inject |
| `orchestration-engine/tier-map.ts`                                         | 322 | Category→model map (sole model authority), peak/promo/availability logic, resolver                                                                      |
| `orchestration-engine/agent-map.ts`                                        | 22  | Category→functional-agent DEFAULT + `resolveFunctionalAgent()` (Tier 2)                                                                                 |
| `orchestration-engine/spawn.ts`                                            | 510 | `resolveAndSpawn` + stable sessions + rotation + usage capture + Esc/signal-abort + `clarify-override` (model/thinking) + cross-provider fallback walk on **empty output OR in-band error** (PORT-PLAN ③ live 429s, live-verified 2026-08-16) |
| `command-guard.ts` + `lib/command-guard-core.ts`                            | 109 | Catastrophic-command seatbelt on the bash tool: whole-handler fail-open, `{block, terminate}` on match, POSIX-ERE→JS conversion (`[:space:]`→`\s`, multiline), patterns re-read per call from `~/.agents/hooks/dangerous-patterns.txt` (dotfiles-owned; 119/119 tests) |
| `chain-runner.ts`                                                          | 272 | Shared `loadChains()` + `runChainByName()` (chain consumers) + overrides + acceptance wiring (inject/parse/strip/verify)                               |
| `agent-chain.ts`                                                           | 463 | `run_chain` (sequential pipelines + `clarify`/`background` params) + `/chain` + `/chain-list` + `/chain-clarify` + `/stop` + **chain widget** (rich per-step line, adaptive tiers, spinner) + background dispatch (registry, cap, toasts) |
| `chain-clarify.ts`                                                         | 394 | Clarify-before-launch overlay (`ctx.ui.custom`): preview/edit task + per-step model/thinking/prompt. Pickers are internal sub-modes; prompt edit via exit-reopen `ctx.ui.editor` |
| `acceptance.ts`                                                            | 429 | Acceptance gates: provenance ladder (claimed→attested→checked→verified) + **enum verify table** (`test\|typecheck\|lint\|build`→argv, `shell:false`, no YAML env/cwd). badge-only `auto`; explicit can fail |
| `background-helpers.ts`                                                    | 140 | Pure helpers: resolveBgStatus/formatBgToast/formatBatchedToast (bg dispatch) + formatFleet (fleet view) + formatTranscript (transcript tail); isolated for bare-node testing |
| `persona-forge.ts`                                                         | 150 | `evolve` + `approve` + `list` + `reject` persona variants with provenance; pending personas persisted to disk                                           |
| `statusline-encom.ts`                                                      | 877 | Encom statusline footer: segment registry, config/presets/customItems, 10-style separators, streaming ticker                                                                                                          |
| `mini-task-tracker.ts`                                                     | 229 | `task` tool + widget; non-mutating tools (read/grep/find/ls/`memory_remember`) exempt from the task gate                                                |
| `mini-damage-control.ts`                                                   | 168 | Safety: fail-closed + deny-additive + `/dc-mode`                                                                                                        |
| `orchestration-engine/routing-stats.ts`                                    | 204 | Pure aggregation for `/routing-stats` incl. usage section (unit-tested)                                                                                 |
| `session-notes.ts`                                                         | 133 | `add_note` + `/note` persistent widget                                                                                                                  |
| `mini-purpose-gate.ts`                                                     | 126 | Boot intent gate                                                                                                                                        |
| `orchestration-engine/test-routing-stats.ts`                               | 58  | Aggregator unit tests (13/13)                                                                                                                           |
| `web-research.ts`                                                          | 311 | Keyless `search` (Wikipedia+DDG-IA+npm+GitHub) + `fetch` (curl+w3m→text, truncated, SSRF-hardened) tools                                                    |
| `test-web-research.ts`                                                     | 107 | web-research logic tests (42/42 pass); main-guard + no-op default (ADR 0011)                                                                                 |
| `memory/index.ts`                                                          | 127 | `memory_remember` tool + `session_start` hydrate + `before_agent_start` inject                                                                          |
| `memory/store.ts`                                                          | 217 | `JsonlMemoryStore`: atomic temp+rename, dedup, secret scan, provenance guard+downgrade                                                                  |
| `memory/injection.ts`                                                      | 40  | Pure pipeline: rank → budget → format `<memory-context>` block                                                                                          |
| `memory/{classifier,scanner,ranker,budget,formatter,normalizer,schema}.ts` | 269 | Pure functions: classify, secret-scan, rank, budget, format, normalize                                                                                  |
| `memory/test-*.ts`                                                         | 652 | Unit tests (147 assertions + smoke, all green)                                                                                                          |

---

## Statusline (`extensions/statusline-encom.ts`)

Encom-themed single-line footer that **replaces Pi's built-in footer** via the canonical `ctx.ui.setFooter` API (not `setWidget`). Selectively ported (Strategy C) from `pi-powerline-footer` v0.7.0 — footer-relevant subsystems only; the fixed-editor cluster, bash-mode, editor stash, working-vibes, and welcome overlay are deliberately excluded (different surface). Unconfigured, it renders byte-identical to the prior hand-built footer.

**Segments** (12, registry-driven; order is data):
`dir` · `git`(+staged/unstaged/untracked) · `context %` · `tokens` · `cache_read` · `cache_write` · `model`(+thinking) · `tps` · `cost` · `time_spent` · `session` · `clock`
(`cache_read`/`cache_write` hide until the model reports cached tokens; `subagents` deferred — Pi exposes no count.)

**Commands**

| Command | Effect |
| --- | --- |
| `/encom` | Show preset + active segments + custom-item count |
| `/encom-preset <default\|minimal\|full>` | Switch segment set; persisted to `settings.json` (safe read-modify-write) |
| `/encom-sep <style>` | Thin-path separator: `powerline-thin\|powerline\|chevron\|slash\|pipe\|dot\|star\|block\|none\|ascii` |
| `/encom-style <solid\|thin>` | Render mode: filled bg-blocks vs separators |
| `/encom-nerd <on\|off\|auto>` | Nerd-font glyphs + segment icons (live override; else auto-detect) |

**Config** — `settings.json` key `encomStatusline` (project `.pi/settings.json` overrides global):

```json
"encomStatusline": {
  "preset": "default",
  "layout": { "left": ["dir", "git", "clock"] },
  "disabledSegments": ["cost"],
  "customItems": [{ "id": "ci", "statusKey": "ci-status", "prefix": "CI", "color": "warning" }]
}
```

`customItems` is a **plugin surface**: any extension can `ctx.ui.setStatus("key", "val")` and you promote it to a footer segment (read via `footerData.getExtensionStatuses()`). Colors are theme tokens in this revision (hex is a follow-up).

**Internals** — unified `SegmentContent` model (each segment emits thin + solid forms from one computation); streaming-aware render ticker (1 s idle → 250 ms while a response streams, so context/tokens move live); async `git status --porcelain` poll (2 s TTL, per-cwd cache). Pure helpers unit-tested in `extensions/tests/statusline-encom.test.ts` (10/10). Phased port record: `extensions/statusline-encom.PLAN.md`.

---

## Agents (15)

Specialist system prompts in `agents/*.md` — **0 of 15 pin a `model:` frontmatter**; `tier-map.ts` is the sole model authority. Two classes:

**Personas (7)** — invoked explicitly via `agent=`:

| Persona             | Depth    | Tools          | Role                                                                                                                                |
| ------------------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `momus`             | 73 lines | read-only      | ruthless PRD/plan gate (PASS/WARNING/FAIL)                                                                                          |
| `reviewer`          | 60 lines | read-only      | post-change code review + pre-merge hygiene                                                                                         |
| `reviewer-security` | 94 lines | read-only      | generated variant of `reviewer` — deep security review (threat modeling, vuln-class checklist, auth/session flow, dependency audit) |
| `oracle`            | 30 lines | read-only      | architecture/debug reasoning consultant (persona-only; `ultrabrain` now maps to `neo`)                                              |
| `librarian`         | 36 lines | read-only      | docs / external-reference specialist                                                                                                |
| `archivist`         | 20 lines | **gated-bash** | file-operations executor                                                                                                            |
| `system-thinker`     | ~198 lines | read + write/edit | pre-flight system reasoning — models a system (incl. pi itself) before builders arrive; manual-only, never auto-dispatched         |

**Matrix operatives (8)** — auto-resolved from the dispatch category when `agent=` (and `team=`) are omitted — see `agent-map.ts`:

| Operative    | Category                          | Depth    | Tools                                     | Role                                                                        |
| ------------ | --------------------------------- | -------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `keymaker`   | `quick`                           | 31 lines | read, grep, find, ls                      | fast codebase recon — finds the path                                        |
| `trinity`    | `unspecified-low` / `-high`       | 36 lines | read, bash, grep, edit, write             | general implementation — gets it done                                       |
| `morpheus`   | `deep`                            | 36 lines | read, grep, find, ls, bash                | deep investigation — sees what others miss                                  |
| `neo`        | `ultrabrain`                      | 54 lines | read, grep, find, ls, bash                | consistency guardian — surfaces hidden / conflicting decisions              |
| `mouse`      | `writing`                         | 27 lines | read, bash, edit, write                   | prose/docs — creates content                                                |
| `architect`  | `visual-engineering` / `artistry` | 32 lines | read, bash, grep, edit                    | UI/frontend — designs structure                                             |
| `seraph`     | `git-commit-message`              | 32 lines | read, bash, grep                          | commit protection — seals the work                                          |
| `researcher` | `research`                        | 40 lines | read, grep, find, ls, bash, search, fetch | web research — keyless composite (Wikipedia/DDG-IA/npm/GitHub + docs-fetch) |

**Removed:** `builder` (role split across `trinity` + `architect`) and `explore` (evolved into `keymaker`). **Rosters** (`teams.yaml`): `matrix` (the 8 operatives), `all` (all 14), plus `build` / `research` / `review`. Generated variants live in `generated-reviewers` with `review_status: pending`.

---

## How routing works (the dispatch flow)

The parent keeps **full tools**; `dispatch` is one optional tool. One focused objective per dispatch. A `before_agent_start` hook injects a `## Cost Discipline` stanza every turn, steering the parent to delegate grunt work to cheaper operatives.

```
parent calls dispatch(category, [agent], [team], [cwd])   ← category is REQUIRED
        │
        ▼
1. resolve agent:     explicit `agent=` wins (KEY INVARIANT); else if no `team=`,
                      resolveFunctionalAgent(category) → Matrix operative (agent-map.ts)
2. loadPersona(agent)        → persona.model (optional override); persona.tools / systemPrompt
3. resolveModel(category)    → tier-map.ts TIERS[category] → {model, thinking}   (SOLE model authority)
4. precedence:               persona.model  >  category tier  >  FALLBACK (opencode-go/glm-5.1)
5. F4 availability precheck: getAvailable(); no key → downshift to FALLBACK (loud: notify+log)
6. per-{agent,project} mutex → one writer per session file (delete-only-if-tail pattern)
7. rotateIfNeeded:           session >100KB → rename to .archive.jsonl, start fresh (NOT truncate)
8. spawn pi --mode json -p --no-extensions [--ext mini-damage-control if bash]
            --session sub-<agent>--<gitRoot>.jsonl   ← STABLE per {agent, project} (was ephemeral)
            --tools <agent> --thinking <level> --model <flag> --append-system-prompt <agent> <task>
            Esc / abort → proc.kill SIGTERM (no orphan subprocess)
9. parse JSON stream: text deltas + tool starts + message_end usage + error detection
10. appendEntry("dispatch-log", {category, modelFlag, thinkingLevel, source, agent, outcome, elapsedMs, usage, …})
    source ∈ {tier-map, persona-override, functional-agent, downshift-unavailable, downshift-exhausted}
```

**Category→model map** (`tier-map.ts` is authoritative — category NAMES ported from OmO for cross-system LLM ergonomics; MODEL assignments are pi-owned and independent of OmO. 6 of 10 categories Z-AI-plan-primary; `quick`/`git-commit-message` → FREE `opencode`, `deep`/`ultrabrain` → external `opencode-go` quota shield, verified live 2026-08-14 — burn opencode-go's external quota first, Z-AI plan is the safety net):

| Category             | Model                           | Thinking | Quota                          | Functional agent | Fallbacks                                        |
| -------------------- | ------------------------------- | -------- | ------------------------------ | ---------------- | ------------------------------------------------ |
| `quick`              | opencode/deepseek-v4-flash-free | off      | FREE                           | keymaker         | opencode/ling-3.0-flash-free                     |
| `unspecified-low`    | zai-coding-cn/glm-4.7           | off      | 1×                             | trinity          | opencode/deepseek-v4-flash-free                  |
| `unspecified-high`   | zai-coding-cn/glm-5-turbo       | high     | 1× promo → 2× after 2026-09-30 | trinity          | opencode-go/kimi-k2.7-code → opencode-go/glm-5.2 |
| `deep`               | opencode-go/glm-5.3             | high     | external (quota shield)        | morpheus         | zai/glm-5.3 → opencode-go/glm-5.2 → opencode-go/kimi-k2.7-code |
| `ultrabrain`         | opencode-go/kimi-k3             | xhigh    | external                       | neo              | opencode-go/glm-5.3 → zai/glm-5.3                |
| `writing`            | zai-coding-cn/glm-4.7           | medium   | 1×                             | mouse            | opencode/deepseek-v4-flash-free                  |
| `research`           | zai-coding-cn/glm-4.7           | medium   | 1×                             | researcher       | opencode-go/minimax-m2.7                         |
| `visual-engineering` | zai-coding-cn/glm-5-turbo       | high     | 1× promo → 2× after 2026-09-30 | architect        | opencode-go/glm-5.2                              |
| `artistry`           | zai-coding-cn/glm-5.2           | high     | 1× promo → 2× after 2026-09-30 | architect        | opencode-go/glm-5.1                              |
| `git-commit-message` | opencode/deepseek-v4-flash-free | off      | FREE                           | seraph           | opencode-go/minimax-m2.7 → zai/glm-4.7           |

Fallbacks are **per-tier** in `tier-map.ts` and are **automatically retried** by `resolveAndSpawn` when the primary fails **soft** (empty response — Z-AI plan quota has no balance fallback) **or loud** (in-band agent error, e.g. opencode-go monthly-cap `429 GoUsageLimitError` — PORT-PLAN ③ live-error half, live-verified `opencode-go/glm-5.3 → zai/glm-5.3` 2026-08-16). A fallback hop that also errors in-band keeps walking; a timeout aborts the chain (Edit 7). The pre-check fallback for missing keys still uses the global `FALLBACK` (`opencode-go/glm-5.1`). Both paths are surfaced in `/routing-stats` as `downshift-unavailable` and `downshift-exhausted`.

---

## Chain runs (`run_chain` + widget + acceptance + clarify + background)

Sequential agent pipelines from `agent-chain.yaml` (deny-additive: projects ADD chains, can't remove global). `$ORIGINAL` = the initial task (all steps); `$INPUT` = previous step's output.

**Live widget** (`setWidget("chain")`) — per-step: model · tool-count · tokens · cost + a live `⎿ <text>` line on the running step; chain row shows elapsed + aggregate cost. Adaptive tiers (single-line <60col or >6 jobs; progressive `+N more`; full). Braille spinner @180ms (one tick drives elapsed + frame, idle-stopped). **Esc/abort now SIGTERMs the child** (was an orphan-process bug — `_signal` was dropped at `execute()`).

**Acceptance gates** (`acceptance:` per step/chain) — each step earns a provenance badge: `claimed` → `attested` → `checked` → `verified` (or `rejected`). `auto` (default) infers from the agent's declared tools (`edit`/`write` ⇒ checked, else attested) and is **badge-only — never rejects**. Explicit levels can fail the step. The child gets an acceptance contract + fenced `acceptance-report` JSON schema; the report is parsed back and **stripped from `$INPUT`** (no propagation noise). **`verified` runs a parent-side enum command** — `kind ∈ {test,typecheck,lint,build}` → fixed argv, `shell:false`, **no YAML `env`/`cwd`** (chain config is deny-additive + `run_chain` is LLM-callable, so arbitrary exec is unacceptable). Provenance persists to `dispatch-log`.

**Clarify-before-launch** (`run_chain({clarify:true})` or `/chain-clarify <chain> <task>`) — a `ctx.ui.custom` overlay to preview/edit the task + per-step model/thinking/prompt before burning tokens. Pickers are internal sub-modes (never a nested `custom()`); prompt/task edit uses `ctx.ui.editor()` via an exit-reopen pattern (cleaner than the `setHidden` choreography, which didn't reliably hide the overlay). Esc/abort cancels with no spawn.

**Background dispatch** (`run_chain({background:true})`, Group 3 Tier A) — fire-and-forget: returns immediately with a `runId`; runs concurrently in the parent's event loop; the widget shows it as a compact `⟳ bg: N running` line (**excluded from `MAX_WIDGET_JOBS`** so it doesn't collapse the foreground). Completion → toast (✓/✗/■) + `dispatch-log` `background-result`. **In-parent** (not a detached runner — that machinery is cross-process-survival only; completion = promise resolution). `/stop <runId>` aborts a per-job `AbortController` (registry-keyed; decoupled from the turn-coupled tool signal) → SIGTERM → `■ stopped` (distinct from `✗ failed`). Concurrency cap **3**.

**Fleet view** (`/chain-status`) — a slash command that dumps all active + recent chain runs (foreground + background) from the `running` map into a scannable `notify`: `⟳ #1 scout-twice [bg] · 45s · step 1/2: scout · glm-4.7 · 3🛠 · 4.2k tok`. Ordered running-first/newest; `[bg]` marks background jobs (also the `/stop`-eligible indicator). Retention cap: oldest done/error foreground chains evicted beyond 5 (bounds the `StepState.output` leak). Background *results* live in the toast + `dispatch-log` (not in `running` post-settle).

**Transcript tail** (`/chain-transcript <runId>`) — peek at a running chain's accumulated per-step text without waiting for completion. Shows the last ~600 chars of each running step's text (where the child is NOW) + the final output for done steps. Useful for debugging a slow background job.

**Curated handoff** (`context:` param on `dispatch` + `run_chain`) — the parent composes a handoff (findings, constraints, prior decisions) and the child receives it as a system-prompt-level `## Handoff Context` block, persistent across all chain steps. Children go from “blind delegate” to “briefed delegate”. Replaces wholesale session fork (cost-explosion + secret-leak risks; pi already ships `--fork`). Soft cap: truncated >2000 chars.

**Batched toasts** — successful background completions within a 1500ms window are grouped into one notification. Failures/stopped flush immediately (never delay errors).

---

## Safety model (two layers)

### `mini-damage-control` — policy gate (fail-closed)

- **Fail-closed by default** — no rules loaded → bash DENIED (never open).
- **Deny-additive global floor** — `mini-dc-rules.yaml` is a floor projects can _extend_ but never _weaken_.
- **3 rule categories** implemented: `bashToolPatterns` (rm/git/sql/dd/mkfs/aws/gcp…) + `zeroAccessPaths` (secrets) + `readOnlyPaths` (lockfiles/build output). `git push`/`git commit` ASK; recursive `rm` hard-blocks.
- **`/dc-mode abort|continue`** — inline toggle (disler splits this into two extensions; we fold it into one).
- **Remaining gap (cherry-pick target):** no `noDeletePaths` category yet. Cloud-native patterns (aws/gcp/firebase/vercel) + `readOnlyPaths` are **shipped** — see `mini-dc-rules.yaml`.

### `command-guard` — catastrophic seatbelt (fail-open)

- **Different doctrine, deliberately:** mini-dc is a strict policy gate (fail-closed, ASKs on `git commit`); command-guard is a catastrophic-only **seatbelt against accidents** — `rm` at root/home tree, dd/mkfs, fork bombs, `curl|sh`, force-push, remote-delete, reflog/gc-prune destruction, `gh` destructive set, password-manager CLIs. **Not** a sandbox; explicit asymmetry vs opencode's sisyphus-gates.
- **Fail-open on adapter self-error** — a broken/missing patterns file must never brick bash (whole handler inside try; pi blocks the tool on an uncaught handler throw, so this matters). Blocked calls return `{block, terminate}` — framework-level no-retry.
- **Patterns:** `~/.agents/hooks/dangerous-patterns.txt` — 32 POSIX-ERE lines, **owned by `~/dotfiles/agents/`** (umbrella adoption 2026-08-16, symlinked — ghostty-config pattern), re-read per call so edits apply instantly. Linux port incl. `/home` tree + `/home/*` glob.
- **Tests:** 119/119 (`extensions/tests/command-guard.test.ts`) incl. false-positive allow cases; E2E-proven via nested-pi probe. Force-push is **double-gated** (mini-dc BLOCK + guard).

---

## Observability (F4 + F6 — shipped 2026-07-09)

- **`/tiers`** — the 10 categories × model / thinking / quota× / **REAL availability** (key configured). Run before switching models.
- **`/routing-stats`** — aggregates `dispatch-log` **cross-session / cwd-scoped**: per-category, per-model (with quota×), per-agent, routing-source views + threshold flags (fail-rate, override-rate, downshifts). Plus a **`▌ usage`** section (Tier 1): total/avg cost, turns, avg context-tokens — global and per-category. The tuning loop.
- **Prompt-drift detector** (`prompt-observer.ts` + `lib/prompt-hash.ts`) — hashes the composed system prompt on `agent_start`, warns if the hash leaves the known-good set (catches composition corruption — a rogue extension rewriting the prompt, `AGENTS.md` tampering — *not* injection, which lands in messages/tool output). `hashPrompt()` **strips the volatile blocks first** (`<memory-context>` + `<bridge-context>`) so memory growth / bridge re-exports don't false-fire — only real base-prompt changes do.
- **Cost reads `$0` until provider pricing is configured** (`zai-coding-cn` isn't priced yet); tokens are tracked regardless. Oracle Q7 caveat: summed `input` over-counts across turns — rely on `cost` + `contextTokens`.

---

## Memory (`extensions/memory/`)

Structured, persistent cross-session memory. The agent saves facts/constraints/decisions/conventions/preferences via the `memory_remember` tool; the extension classifies, ranks, and injects a budgeted `<memory-context>` block into the system prompt each turn.

- **`memory_remember` tool** — agent supplies `key` (topic-based, e.g. `strict_no_any`) + `value` + `provenance` (`operator`|`inferred`). System auto-classifies the category from the value.
- **Injection** — `before_agent_start` re-reads the store every turn, ranks by (category → provenance → recency), budgets to ~2000 tokens, appends a `<memory-context>` block to the system prompt.
- **Defenses** — secret scan at the write boundary (refuse + surface); inferred→operator provenance write-guard + category downgrade; dedup by `{scope}:{key}`; atomic temp+rename writes; malformed-line skip (one bad line never unloads the store).
- **Storage** — `~/.pi/agent/memory/{store.jsonl, audit.log}`. Coexists with (does not replace) `memory.md` handoff.
- **3-tier design** — 7 pure functions (classify/normalize/scan/rank/budget/format) → `JsonlMemoryStore` → Pi entry (`session_start` hydrate + `before_agent_start` inject + tool). 147 assertions + smoke; live-verified end-to-end (write → inject → recall).

---

## Environment integrations

**System dependencies:** `w3m` (HTML→text for the `fetch` tool — without it, `fetch` silently returns empty), plus `rg` + `fd` (vendored in `bin/`). Install: `apt-get install w3m`.

### Web access (two layers)

1. **Built-in keyless** (`web-research.ts`) — Wikipedia/DDG-instant/npm/GitHub search + w3m fetch. Always on, no quota.
2. **`pi-web-access`** (npm extension, installed 2026-08-17) — real web research: `web_search` (keyless Exa tier, **3 QPS / 150 calls/day**), `code_search`, `fetch_content` (PDFs → `~/Downloads`; GitHub URLs clone locally), `get_search_content`. **Always pass `workflow: "none"`** (skips the interactive curator). Usage discipline lives in the `pi-web-search` skill (effort tiers ≥2/≥4/≥8 queries; citation contract: provider+URL per load-bearing claim).

**Lane division of labor** (sis-ratified): pi = breadth (lookups, news/blogs/forums, release notes, GitHub reads); opencode/sisyphus = depth (Context7, cross-repo code search, blocked/anti-bot sites, multi-source synthesis). Paid keys live in ONE stack's config.

Two extensions wire pi into its host environment. Both are load-bearing for *this* operator's laptop setup and are the first things to understand before changing them.

### `bd-bridge.ts` — read-only sisyphus → pi memory bridge

- **What:** At `before_agent_start`, reads `bridge/global-export.jsonl` (generated by `bridge/export-bd-global.sh` from the sibling opencode+sisyphus agent's `bd` store) and string-concatenates a labeled `<bridge-context>[FROM bridge, exported <ts>]…</bridge-context>` block onto the system prompt. (The XML tags are so `prompt-hash.ts` can strip it as a volatile block — see Observability.)
- **Filter:** keeps only bd categories `constraint` / `exact` / `preference` / `reason` / `decision`; skips sisyphus-internal prefixes (`session-*`, `pre-test:*`, `next-session:*`, `files:*`).
- **Hard constraints (load-bearing):** READ-PATH ONLY — it **never writes to `bd`** and **never writes to `memory/store.jsonl`**. Bridged facts are *projected*, not merged into pi's own store.
- **Security self-model:** bridged values are **secret-scanned at inject** (`scanSecrets` from the memory extension); a hit is skipped + logged to `bridge/telemetry.log`. The bridge still bypasses the structured-store *write* boundary — bridged facts are *projected*, never stored in `store.jsonl` — and it never writes to `bd`. If sensitive-looking material ever appears in a `[FROM bridge]` block, flag it to the operator.
- **Two schemas parsed:** Schema A (clean `category:content`) and Schema B (`bd_remember.py` pipe-delimited `scope=…|category=…|…`). Escaped pipes (`\|`) in Schema B values **are** unescaped (`replace(/\\\|/g, "|")`).

### `herdr-agent-state.ts` — herdr multiplexer integration

- **What:** Vendor-installed by **herdr** (the terminal multiplexer this agent runs inside, alongside the sibling opencode+sisyphus pane). Reports pi's pane/agent state to herdr over a unix-domain socket (`$HERDR_SOCKET_PATH`), keyed by `$HERDR_PANE_ID`.
- **Managed file — do not hand-edit:** the header reads *managed by herdr; reinstalling or updating the integration overwrites this file*. `@ts-nocheck` is intentional. Add custom hooks in a **sibling** file, never inside this one.
- **No-op off-host:** gated on `HERDR_ENV === "1"` + a socket path + a pane id; if any are absent it resolves `true` and does nothing. Safe to ship unchanged in a dotfiles repo — it stays dormant outside the herdr environment.

---

## Two-platform architecture (where pi sits)

| Axis                                   | **pi** (this repo)                                                                                                                           | **opencode + sisyphus**                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Role                                   | **micro** — frequent, cost-sensitive, bounded execution                                                                                      | **macro** — rare, expensive, high-stakes methodology            |
| Standout                               | cost routing + availability + observability + Matrix functional agents                                                                       | ~41 planning skills (discovery→PRD→momus gate→plan→waves→close) |
| Memory substrate                       | `memory.md` (handoff) + `memory/` ext (structured JSONL)                                                                                     | `bd` + `.sisyphus/*` (file contracts)                           |
| Couplings to cut for full independence | (1) ~~`settings.json skills → ~/.config/opencode/skills`~~ ✂ CUT (`1dfdf30`, 2026-07-24 — pi skills native); (2) `git-commit-message` → opencode provider; (3) auth.json opencode/openrouter keys | —                                                               |

pi's skills are **pi-native real files** — `settings.json` loads none (`"skills": []`), zero symlinks to `~/.config/opencode/skills` (delinked `1dfdf30`, 2026-07-24). **Provider coupling remains** — tier-map.ts routes `quick`/`git-commit-message`/`ultrabrain` + several fallbacks to `opencode`/`opencode-go` (FREE models) — so pi is **skills-independent but provider-coupled**, not wholly independent. Pi now ships its own **Matrix operatives** (functional agents auto-resolved from the dispatch category), reducing reliance on sisyphus skills for delegated grunt work. The category taxonomy is **already pi-owned**; names sync to `oh-my-openagent.json` only for shared-document consistency.

---

## Governance

- **`decisions/`** — 13 ADRs (0001–0005: substrate · mini-dc · prometheus incompat · observability · availability precheck; 0006–0008: glob matcher · team selector · chain primitive; 0009 persona-forge · 0010 runtime fallback · 0011 extension loadtime no-side-effects · 0012 memory extension · 0013 AgentToolResult details contract).
- **`extensions/orchestration-engine/`** — `3-LAYER-ROUTING-DESIGN.md` (F1–F6), `HANDOFF.md` (reversals), `PROBE-RESULTS.md` (empirical model facts).
- Every load-bearing behavior is **verified on the pi version it shipped against** (behavioral re-verify evidence cited in the ADRs).

---

## Where we're heading (cherry-pick backlog, ranked)

From the disler comparison (`SYSTEM-COMPARISON-OURS-vs-DISLER.md` §8) — value ÷ effort × fit:

1. **YAML-only safety additions** — cloud `bashToolPatterns` + richer `zeroAccessPaths` + git-history patterns. Zero code change. _(next)_
2. **`readOnlyPaths` + `noDeletePaths`** rule categories — small code bump to the fail-closed hook.
3. **`coms`/`coms-net`** — DEFER, gated on the handoff-vs-conversation question.
4. **Group 3 Tier B/C + A.5** — batched toasts; fleet view, live transcript tail, control/needs-attention notices, intercom/supervisor, async parallel/nested; + detached-runner survivability (Tier A.5). (See `GROUP3-ASYNC-SPEC.md` in the pi-subagents clone.)

**Shipped:**

- Named `/team` + `/chain` primitives (2026-07-10). `dispatch` and `run_chain` share `resolveAndSpawn` for model resolution, availability precheck, and spawn. `git-commit-message` dogfoods the `commit-message` chain.
- `persona-forge` meta-agent (2026-07-11). `evolve` → `generate` → `momus` review → operator `approve`/`reject` write with full provenance; pending personas persisted to `sessions/persona-forge/`.
- F3 runtime retry with per-tier opencode fallback (2026-07-11). `resolveAndSpawn` retries once on empty primary output; surfaced in `/routing-stats` as `downshift-exhausted`.
- Structured memory extension (2026-07-13). `memory_remember` tool + `before_agent_start` injection. 3-tier design (pure functions → JSONL store → Pi wiring) with secret scan, provenance write-guard, dedup, atomic writes. 147 assertions + live-verified.
- **Persistent sub-agent sessions + usage + functional agents** (2026-07-15, “the bridge”). Tier 0: stable `{agent,project}` session files (`sub-<agent>--<gitRoot>.jsonl`) + rotation at 100KB (not truncation) + Esc/signal-abort + per-`{agent,project}` mutex (delete-only-if-tail). Tier 1: `message_end` usage capture (cost/tokens/turns) into `dispatch-log` + a `▌ usage` view in `/routing-stats`; latent error-path bug fixed (`ev.message.stopReason`, not `ev.stopReason`). Tier 2: `agent-map.ts` auto-resolves a Matrix operative per category when `agent=` is omitted (explicit agent always wins). 7 personas + 8 operatives; 0 model pins.
- **pi-subagents UI/UX absorption** (2026-07-30) — ported the *patterns* (not the code) from [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) v0.34.0: **live chain widget** (rich per-step line model·tools·tokens·cost + live chunk, adaptive tiers, braille spinner, Esc/orphan-fix); **acceptance gates** (provenance badges + sandboxed enum verify table, `shell:false`); **clarify-before-launch** (`/chain-clarify` + edit task/model/thinking/prompt); **background dispatch** Tier A (fire-and-forget + `/stop` + batched toasts + cap 3); **fleet view** (`/chain-status`); **transcript tail** (`/chain-transcript`); **curated handoff** (`context:` param — briefed delegates); prompt-hash drift detector hardened (strips volatile memory/bridge blocks). Oracle-reviewed per feature; the absorbed suites live in `extensions/tests/` (16 files at the time; 17 now, all green on 0.84.2) alongside the colocated memory (147 assertions), routing-stats (13), and web-research (42) suites.
- **davidondrej/skills absorption** (2026-08-16/17, validate→absorb + oracle lane review + 2-round review-loop) — command-guard seatbelt (above); skills: git-worktree (parallel-agent discipline), decisions (manual-only retrospective probe), pi-web-search + research-prompt (woke when pi-web-access installed; effort tiers + sis-ratified citation contract); skill-creator upgraded (frontmatter-reality, colon gotcha, routes-not-how, strictness ladder, Pattern A/B, third-party-skill security checklist); herdr-collab v0.2.2 probe-verified sharp edges (skill now dotfiles-owned with the denylist under `~/dotfiles/agents/`).
- **Live-error fallback** (PORT-PLAN ③, 2026-08-16) — the dispatch fallback chain now walks on LOUD in-band 429s, not just empty output; live-verified `opencode-go/glm-5.3 → zai-coding-cn/glm-5.3` mid-review-loop. Pure gate `spawnFailedForFallback` in `spawn-outcome.ts` (15/15 tests incl. the 429 regression).

**Deferred by design (not gaps):** F1 LLM intent-classifier (🔒 CLOSED — explicit-category chosen; reopen only on `/routing-stats` evidence). F2 peak-hour auto-downshift — still open.

---

## Reference

- **Pi core docs** — `~/.nvm/.../pi-coding-agent/docs/{extensions,sdk,models,providers,skills,settings,compaction}.md`
- **This system's design** — `extensions/orchestration-engine/3-LAYER-ROUTING-DESIGN.md`
- **Comparison vs disler** — `~/developer/yt-dlp/about-pi/pi-claude-style-setup/SYSTEM-COMPARISON-OURS-vs-DISLER.md` + `current-pi-vs-disler.md`
- **Always-on rules** — `AGENTS.md`

---

_Living doc — update when topology changes. Last revised: 2026-08-17._
