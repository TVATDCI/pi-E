# Decision 0001 — Layer 4 Substrate: Sisyphus-opaque (GSD ruled out by probe)

**Status:** DECIDED
**Date:** 2026-07-06
**Trigger:** LR-0016 (update Pi → probe GSD same session → decide before Layer-4 build)
**Pi version at decision:** 0.80.3 (updated from 0.79.9 this session)

> **Re-verify (2026-07-16 · pi 0.80.8):** Static/non-interactive checks PASS — pi boot ✅, all global extensions + orchestration-engine load ✅, `dispatch` registers + core spawn ✅, JSON-mode print spawn ✅, `--thinking <level>` ✅. **Drift:** thinking levels are now **7** (`off/minimal/low/medium/high/xhigh/max`) — this ADR recorded 6; one level was added upstream. **New type drift:** `tsc --noEmit` no longer clean on 0.80.8 (AgentToolResult now requires `details`) — see ADR 0011/0012; runtime unaffected. **Still pending interactive TTY re-verify:** triggerTurn forcing (LR-0009) + gated-bash BLOCK/ASK (LR-0011/0012) — cannot be exercised in print mode.
**Decider:** Operator (per MISSION — Layer 4 was the operator's call, equipped not prescribed)

## The decision

**Layer 4 substrate = sisyphus-opaque (`.sisyphus/`).**

GSD-transparent (`.pi/gsd/`, v1.30.0) is **ruled out** as a substrate for Pi by three hard blockers, confirmed by empirical probe + Sascha Koenig's own harness-agnostic migration plan (`~/developer/AGENTS/.sisyphus/plans/harness-agnostic-migration.md`).

This is a **conclusive** probe result — the inconclusive-probe escape hatch (LR-0016: "second gated trigger, not forced binary") does **not** apply. The probe gave a clean answer.

## Evidence — three hard blockers

### Blocker 1: Missing state engine (`gsd-tools.cjs`)
- 9 of 17 GSD agent files reference `node "$HOME/.claude/get-shit-done/bin/gsd-tools.cjs"` — the state-management CLI that powers every planning workflow.
- `gssd-executor.md` alone has **13 references** (advance-plan, update-progress, record-metric, add-decision, mark-complete, etc.).
- `find / -name gsd-tools.cjs` → **not present anywhere on the system.** Claude Code is not installed.
- Every state-managing workflow (`gsd-new-project`, `gsd-plan-phase`, `gsd-execute-phase`, `gsd-verify-work`, etc.) fails at its first bash call without this binary. GSD cannot manage project state on Pi.

### Blocker 2: Slash-command format mismatch
- GSD workflows start with `<gsd-version v="1.12.4" />` tags, **not YAML frontmatter**.
- Pi prompt templates **require** frontmatter (`description`, optional `argument-hint`) — see `docs/prompt-templates.md:30-40`. Filename becomes `/command` only when frontmatter is present.
- As-is, `/gsd-new-project` would not invoke on Pi — the 65 workflow files aren't recognized as templates. Fixable per-file, but it's 65 files of mechanical work on top of Blocker 1.

### Blocker 3: Hooks are Claude-Code-format (`.js` PreToolUse)
- GSD ships 5 hooks: `gsd-workflow-guard.js`, `gsd-context-monitor.js`, `gsd-prompt-guard.js`, `gsd-statusline.js`, `gsd-check-update.js`.
- These use Claude Code's stdin/stdout JSON PreToolUse protocol.
- Pi registers lifecycle handlers via TypeScript extensions (`pi.on("tool_call", ...)` etc.) — it does **not** execute standalone `.js` hooks.
- The hooks' "SHARED CANONICAL, auto-detect harness from `__dirname`" comment is about locating the config dir *within a harness that already loads the hook* — it does not make Pi load the hook. Each hook needs a Pi extension wrapper to fire at all.

## Corroborating evidence — Sascha's own migration plan

Sascha's `harness-agnostic-migration.md` (1679 lines) explicitly scopes the Pi renderer (Task 11, lines 909-951):

> *"Pi has NO subagent concept — renderer produces DIFFERENT outputs than OpenCode/Claude Code: `~/.pi/agent/SYSTEM.md` or `.pi/SYSTEM.md` — Primary agent's system prompt. `.pi/settings.json` fragment. Skill symlinks."*

> Do NOT: *"Create agent files (Pi doesn't have them). Include MCP config (Pi uses extensions instead)."*

**The Pi renderer produces AGENTS.md + SYSTEM.md + settings.json. It deliberately does not produce the GSD workflow/agent/hook infrastructure.** The `.pi/gsd/` directory in the AGENTS repo is GSD-for-Claude-Code placed in a `.pi/` folder — not rendered, not adapted, not runnable on Pi. It is a candidate source for *future* porting work, not an installable substrate.

The version chaos in the directory confirms this is not a clean Pi deployment: workflows range `v1.12.4` → `v2.0.24`; hooks at `v1.30.0`; VERSION file says `1.30.0`. Mixed-version dump, not a prepared Pi target.

## What this means for the port

**The LR-0006 note ("GSD is post-update, not on 0.79.9") was misleading.** It implied a newer Pi would run GSD. The truth: GSD requires Claude Code's runtime infrastructure (gsd-tools.cjs + the hook protocol + the slash-command format) that **no version of Pi has or will have** — those are Claude-Code-specific. Updating Pi was never the gate. The real gate is "port GSD's engine to Pi," which is a from-scratch rewrite, not an update.

**For the MVP:** keep sisyphus-opaque (`.sisyphus/`). It's tested (verified across multiple projects in `~/developer/test-artifacts/`), transparent enough (the workflow files are readable markdown), and works with the existing toolchain. The orchestration-engine's `dispatch` tool will target sisyphus-style personas.

**The deeper option (build a Pi-native planning layer)** remains open as implementation-phase work — but it is net-new construction, not a substrate choice between two existing options. GSD removed itself from the choice; the decision is now "use sisyphus-opaque now, build Pi-native later if the build phase demands it." That sequencing is honest and matches MISSION's "implementation phase, separate engagement, operator in-loop."

## Secondary findings (this session)

- **LR-0017 (0.80.3 regression):** `mini-purpose-gate.ts` crashed in print mode — `ctx.ui` access tightened in 0.80.3 (now throws when no UI). Fixed with `ctx.hasUI` guards on `session_start` + the `input` gate. Same bug-class as LR-0011 (purpose-gate in print mode); 0.80.3 made it loud instead of silent. **Behavior pending interactive test:** triggerTurn forcing (LR-0009) and gated-bash command-blocking (LR-0011/0012) load clean on 0.80.3 but weren't behavior-tested in print mode.
- **0.80.3 regression set:** compile (clean), pi boot (clean), all 5 global extensions + orchestration-engine load (clean), `--thinking` all 6 levels (intact), JSON-mode spawn full event stream (intact), `dispatch` tool registers (intact).

## Open follow-ups (not blocking, logged)

1. **Interactive re-verify on 0.80.3:** triggerTurn forcing + gated-bash proof need a TTY session to behavior-test (print mode can't exercise them). Fire this before the first real dispatch in the implementation phase.
2. **gsd-tools.cjs as a port source:** if a Pi-native planning layer is later built, GSD's `gsd-tools.cjs` command surface (state advance-plan / update-progress / record-metric / add-decision / mark-complete) is a well-designed CLI contract worth mirroring — read it as a spec, don't port the binary.
3. **The 65 GSD workflows as a pattern library:** even though they don't run on Pi, they're a rich reference for what a planning workflow covers (discovery, research, planning, execution, verification, debugging). Mine them for requirements when building Pi-native, don't copy them.

## Verdict

Layer 4 = **sisyphus-opaque**. GSD-transparent ruled out by conclusive probe. The capstone's Layer 4 row resolves. The implementation phase builds on `.sisyphus/` with the orchestration-engine dispatching into it; a Pi-native planning layer is deferred to a future engagement if the build phase surfaces the need.
