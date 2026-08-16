# Absorption Plan — davidondrej/skills → pi

2026-08-16 · validate→absorb flow · verdict reviewed by oracle (GO-WITH-CHANGES,
review preserved at `~/.pi/agent/exports/absorption-oracle-review.md`).
Source: `/home/vladi/developer/davidondrej-skills/skills` (David's repo, READ-ONLY,
never edited by us). Status: **plan only — nothing absorbed yet.**

## Phase 0 — operator decision points (block execution)

| # | Decision | Options / recommendation |
|---|---|---|
| **D1** | Command-guard extension (C2): GO / NO-GO | GO = build pi's first bash guard (extension). NO-GO = drop hooks/ material, record named reject. **Gates C3's yolo line.** Framing: sisyphus-gates (opencode) is strict; this is a seatbelt — explicit asymmetry, not parity. |
| **D2** | `git-worktree` (oracle's catch): absorb vs named-reject | Tool-agnostic ~85%, Cursor ~15% cleanly strippable. Note: `herdr worktree` command group already exists (partial overlap — layout, not discipline). Absorb = new pi-native skill; reject = named reason in §B. |
| **D3** | Patterns file home (only if D1=GO) | **RECOMMENDED shared** `~/.agents/hooks/dangerous-patterns.txt` (one tuning point, matches source design; pi adapter reads it). Alternative: pi-private under `~/.pi/`. |
| **D4** | Borderlines to take now vs defer | `decisions`: cheapest real skill; pi HONORS `disable-model-invocation` (verified docs/skills.md L184 — oracle's "strip it" was based on my stale summary). `pi-custom-model`: **defer + revisit trigger** (next scoped-models session). `ask-then-build`: defer-to-no stands. |
| **D5** | C3 destination | **RECOMMENDED** extend `herdr-collab` SKILL.md (the shared-skill substrate, designed for cross-agent use) with probe-verified "Sharp edges" section. Alternative: pi-local notes file. |

## C1 — skill-creator merge (FIRST; independent; pure docs)

Protocol (oracle's dedupe-then-compress):

1. **YAML-colon probe.** Docs don't document the strict-colon rejection (skills.md
   frontmatter section has no mention). Verify against loader source in the
   installed package before enshrining; if unverifiable → keep the *practice*
   (single-quote colon-bearing descriptions) as generic YAML discipline, drop the
   pi-specific claim.
2. **Dedupe map** (extract → existing skill-creator coverage):
   (a) description-routes-not-how → partial ("be pushy" ≠ the how-summary trap);
   (b) strictness ladder → absent; (c) colon gotcha → absent; (d) Pattern A/B →
   absent (skill-vs-agent is a different axis — complement, not duplicate);
   (e) third-party security checklist → absent; (f) weakest-model + trigger-vs-
   execution framing → partial (checklist exists, those two ideas missing).
3. **Compress delta to ≤~40 lines.** Placement: (a)→description-tuning section;
   (b)→short new block; (c)→lean-format gotcha line; (d)→skill-vs-agent section;
   (e)→5-line checklist; (f)→validation checklist.
4. **Spec correction (verified this session):** skill-creator says frontmatter =
   two fields ONLY, extras are "opencode fields" — pi's real spec supports
   `license`, `compatibility`, `metadata`, `allowed-tools`,
   `disable-model-invocation`, and IGNORES unknown fields (docs/skills.md
   L137–184). Keep the lean *convention* (it's pi-native doctrine), fix the
   *rationale* text; note David's `disable-model-invocation` is honored.
5. **Operator approves diff → then write** (skill-creator's own rule). Never push.

Validation: lean-format checklist + 2–3 trigger-phrase sanity checks (should-fire
AND should-NOT-fire) in a fresh session.

## C2 — command-guard extension (gated on D1=GO)

Spec (oracle changes folded; API pre-verified extensions.md L765):

- **Patterns** (start from source 65 lines): strip macOS-cosmetic (`diskutil`,
  `/Users` tree); **ADD `/home` tree patterns** — the verified gap: literal
  `rm -rf /home/<user>` is currently unblocked; mirror `~`/`$HOME` semantics
  (whole-tree only, end-anchored — children stay allowed). Keep password-manager,
  `gh` destructive, reflog/gc-prune groups.
- **Adapter** `~/.pi/agent/extensions/command-guard.ts`: `pi.on("tool_call")` →
  `{ block: true, reason }`; **fail-open on adapter self-error** (try/catch → log
  → allow; a broken patterns file must never brick bash); `[:space:]`→`\s` +
  multiline-flag conversion; re-read patterns per call (instant tuning).
- **Tests**: adapter-level suite mirroring `test-guard.sh` block+allow cases
  INCLUDING false-positive allows (`git commit -m "rm -rf mention"`,
  `npm run pass-tests`); E2E probe: `pi -p --no-session 'Run exactly: git push
  --force…'` from a non-git dir → blocked = pass.
- **Asymmetry note** (extension header + this plan): sisyphus-gates blocks
  compounds outright; this is a catastrophic-only seatbelt. Different strictness
  by design.
- Estimate: ~70 lines patterns + ~70 adapter + ~130 tests. Quality doctrine:
  strict types (no `as any`), field-level diagnostics, fail-safe defaults.
- **If landed** → C3 gains the conditional yolo-rehabilitation line.

## C3 — herdr sharp edges (AFTER D1; ordering constraint)

Extract set (oracle-expanded) + evidence class:

| Edge | Evidence path |
|---|---|
| `pane read --lines` < viewport → EMPTY; request ≥200, tail locally | probe (own pane, `--lines 10`) |
| `pane get .cwd` frozen vs `.foreground_cwd` live | probe (own pane) |
| send-text → ~1s sleep → separate `send-keys enter` for TUI composers | probe (scratch pane I create) |
| slash-command popup eats first Enter; `escape` dismisses | probe (scratch pane) |
| verify submit via lifecycle flip, never "content changed" | evidenced this session (wait timeout → `working` + title) |
| `agent wait` / `wait output`, NEVER sleep-and-read | evidenced this session |
| always `--session`; never `server stop`; first-colon split on `w1:p2` | documented (bare subcommands behaved in-session) |
| `idle` during long foreground tool call → corroborate with pane text | evidenced this session (`foreground_cwd=/tmp` during oracle wait) |
| label non-uniqueness collision hazard | read-only check (`workspace list --json` dup labels) |
| restart husks (`agent_not_found` → close-and-replace) | DOCUMENTED-ONLY (needs server restart — too disruptive) |
| last-tab / only-pane deletion cascade | DOCUMENTED-ONLY (destructive) |
| C0 bytes eat typed text; U+2063 marker | probe (scratch pane, safe) |

Rules: probes only in panes I create (scratch pane, closed after — never the sis
pane); every entering line marked PROBED (date + herdr version) or DOCUMENTED.
Conditional: yolo-launch safety line if C2 lands.

## B — borderlines + named passes (audit record; EXECUTED 2026-08-16)

| Skill | Call | Outcome / record |
|---|---|---|
| `git-worktree` | **D2 = absorb** | DONE — `~/.pi/agent/skills/git-worktree/SKILL.md` (pi-native adaptation; Cursor ~15% stripped; herdr-worktree boundary in description) |
| `decisions` | **D4 = take** | DONE — `~/.pi/agent/skills/decisions/SKILL.md` (manual-only via `disable-model-invocation`, verified honored) |
| `research-prompt` | named reject-for-now | NOT DeepAPI-coupled (verdict correction); revisit when pi-side deep-research flows exist |
| `create-readonly-db-role` | named reject | portable pattern, no current Postgres in stack |
| `teach` | named reject | multi-file violates lean one-file convention; opencode-side teach exists → divergence risk |
| `pi-custom-model` | defer + revisit trigger | next scoped-models/tier-map session; re-probe bundled-list path (version-drift prone) |
| `ask-then-build` | defer-to-no stands | collides with plan discipline (anti-over-engineering) |
| `distribute-skill-to-all-agents` | named reject | doctrine-reinforcing: symlink layout = anti-pi-independence |
| `read-all-adrs` | named reject | unfinished stub |
| `brain-to-docs` | named reject | same family turf as ask-then-build |
| `pi-web-search` | reject stands + revisit trigger | precision fix: Exa path is zero-config; load-bearing fact = pi-web-access NOT installed. Resurrects if it ever installs. |

## Execution log (2026-08-16)

- **C2 DONE.** `~/.agents/hooks/dangerous-patterns.txt` (shared, Linux port, /home gap
closed) + `~/.pi/agent/extensions/command-guard.ts` + `lib/command-guard-core.ts`
(fail-open, pure core) + `tests/command-guard.test.ts` — **114/114 pass**.
E2E: nested `pi -p` probe `bw get password` → blocked by THIS guard (reason surfaced
to model verbatim). Attribution note: `git push --force` probe aborted the whole run
— that was the PRE-EXISTING mini-damage-control gate (its yaml blocks force-push,
mode=abort), not this guard; force-push is now double-gated. Probe safety: chose an
uninstalled password-manager CLI so guard-failure = harmless command-not-found
(NEVER probe with `gh auth token` — failure prints a real token).
- **C3 DONE.** herdr-collab SKILL.md → v0.2.2 + Sharp edges section (probe-verified
2026-08-16, herdr 0.8.0). **One source edge STALE:** `pane read --lines` < viewport →
empty does NOT reproduce on 0.8.0 (--lines 1/5/10/42 all return content) — recorded
NOT-REPRODUCED. PROBED: send-text-no-submit (+enter submits), C0-byte erases typed
text (P4-PREFIX-TYPED→P4-PREFIX-TYPE), cwd-basename auto-label collision mechanism.
EVIDENCED: foreground_cwd live vs .cwd frozen, lifecycle-flip verification, wait-
never-sleep, idle-during-tool-call. DOCUMENTED: --session discipline, restart husks,
last-tab cascade, slash-popup. Conditional yolo line added (guard present twice).
Scratch pane w4:p4 used for probes, closed after.

## Execution order & review policy

**C1 → D1 → C2 → C3 → B records.** C1 independent and safest; C2 gates C3's
content; B is cheap text. One oracle round already spent on the verdict — the
plan is reviewed by the operator in pi; no further cross-agent rounds unless the
finished artifacts turn contentious (one follow-up lane round is cheap: sis
alive at w4:p3, shared files preserved).

## Memory actions (per AGENTS.md compaction doctrine)

On each workstream landing: `memory_remember` the decision + reasoning (merge
choices; C2 GO/NO-GO + why; C3 probe outcomes; B named rejects with reasons).
If C2 GO: store command-guard constraint (patterns location, fail-open doctrine,
asymmetry note). Cross-task dependency to store: C2→C3 yolo line.

## Artifacts map

- This plan: `~/.pi/agent/exports/absorption-plan-davidondrej.md`
- Oracle review (audit copy): `~/.pi/agent/exports/absorption-oracle-review.md`
- Lane (ephemeral): `/tmp/herdr-collab/absorb-davidondrej/` + sis @ w4:p3
- Source repo: untouched clone of `github.com/davidondrej/skills`
