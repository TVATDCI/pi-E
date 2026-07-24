# Decision 0003 — Prometheus (interview-first) is incompatible with the dispatch model

**Status:** FINDING + DEFERRED (resolve when Layer-4 wiring starts)
**Date:** 2026-07-06
**Discovered during:** 7-persona roster port (scout/explore/oracle/librarian/reviewer/archivist/builder live)
**Blocks:** the prometheus port specifically; does NOT block metis or momus
**Pi version:** 0.80.3

> **Re-verify (2026-07-16 · pi 0.80.8):** Finding **stands unchanged**. Print mode (`pi -p`) remains non-interactive — `memory_remember` and `fetch` both ran in print mode on 0.80.8 without any UI dialog, and `ctx.ui` is still gated when no TTY is present. prometheus (interview-first) is still not portable as a dispatchable persona. No regression.

## The finding

**prometheus cannot port as a dispatchable Pi persona.** prometheus is *interview-first planning* — its core behavior is asking the operator clarifying questions before producing a plan. But a dispatched sub-agent runs in print mode (`pi --mode json -p`), and **print mode cannot do interactive dialogs** — `ctx.ui.input()` throws when there's no UI (the exact LR-0017 mechanism, fixed in `mini-purpose-gate.ts` by guarding with `ctx.hasUI`).

So a dispatched prometheus that tries to interview crashes on its first question. Adding a `ctx.hasUI` guard would prevent the crash but **silently skip the interview** — which defeats prometheus's entire purpose. You can't make prometheus work in dispatch by guarding the dialog away; the dialog IS the function.

prometheus is a **primary-agent pattern**, not a sub-agent pattern.

## The generalization

This isn't unique to prometheus. **Any role whose function depends on interactive clarification is primary-pattern, not dispatch-pattern.** The dispatch model assumes the sub-agent receives a self-contained task and returns output — no back-and-forth. Roles that need back-and-forth (interview-first planners, clarify-then-act assistants, interactive debuggers that ask "what did you expect?") break that assumption.

Candidate OmO roles to screen against this before porting:
- **prometheus** (interview-first planning) — ❌ incompatible (this finding)
- **metis** (pre-planning analysis) — ✅ compatible (analyzes a spec/doc read-only; no interview)
- **momus** (ruthless critique) — ✅ compatible (critiques a PRD/plan read-only; no interview)
- **future roles:** any "interview-first" or "clarify-then-act" persona hits the same wall. Screen before porting.

## The two resolution options (decide when Layer-4 wiring is real)

### Option A — prometheus as primary, not dispatch target
prometheus runs in its own interactive session (operator invokes it directly, not via `dispatch`). The operator answers prometheus's questions in that session; prometheus produces the plan; the plan artifact (PRD/brief/spec) is then handed to dispatched sub-agents (metis analyzes, builder implements, etc.).

- **Pro:** preserves prometheus's interview function intact.
- **Con:** prometheus isn't reachable via the orchestration-engine's `dispatch` — it's a separate entry point. The dispatch model and the primary model coexist; prometheus lives in the primary layer.
- **Architecture impact:** the orchestration-engine stays as-is (dispatch targets sub-agents only). prometheus is invoked via `pi --print` or a dedicated command, not `dispatch({agent:"prometheus"})`.

### Option B — two-phase pattern (primary interviews, dispatches analysis)
The **primary** (operator + their interactive pi session) conducts the interview, captures answers, then **dispatches metis** (or a new "analyze-answers" persona) with the full Q&A as task context. prometheus-as-persona disappears; its interview function moves to the primary layer, its analysis function moves to a dispatchable sub-agent.

- **Pro:** keeps everything in the dispatch model; no separate entry point.
- **Con:** the interview quality depends on the primary (you + your interactive pi), not a specialized planner persona. You lose prometheus's "interview expert" framing.
- **Architecture impact:** no prometheus persona at all; the primary owns the interview step.

## Recommendation (tentative, deferred)

Lean **Option A** — it preserves the persona's specialized value and doesn't force the dispatch model to absorb a pattern it wasn't designed for. But this is a Layer-4-wiring decision, not a now-decision. Defer until:
1. The spine (Layers 1–3 + 5–6) is built.
2. Layer-4 planning workflow is actually being wired.
3. Real usage of the 7-persona roster has shown whether the planning workflow even needs prometheus, or whether the primary (operator) can conduct the interview directly.

It's possible real usage reveals prometheus isn't needed at all — the operator + oracle (consultation) + momus (critique) might cover planning without a dedicated interviewer. Don't port prometheus until that's settled.

## What this does NOT block

- **metis and momus** — both port cleanly as read-only dispatch targets when Layer-4 wiring starts.
- **The 7-persona daily driver** — unaffected; none of the 7 are interview-first.
- **The spine build** — substrate-independent; no interview roles involved.
- **The meta-agent path (LR-0013)** — relevant: a meta-agent that generates personas must know NOT to generate interview-first personas into the dispatch roster. Add "is this role primary-pattern or sub-agent-pattern?" to the meta-agent's generation checklist.

## Cross-references

- **LR-0017** — the `ctx.ui` print-mode mechanism that makes this incompatible (the fix that confirmed `ctx.ui.input` throws without UI).
- **LR-0013** — the meta-agent reframe; this finding constrains what the meta-agent can generate into the dispatch roster.
- **LR-0014** — the converged permission grammar; prometheus's incompatibility is orthogonal to permissions (it's a control-flow issue, not a permission issue).
- **The 7-persona roster** (`~/.pi/agent/agents/`) — none are interview-first; the roster is dispatch-clean.

## Status
deferred — resolve at Layer-4 wiring. File the methodology finding in the curriculum (LR-0021) so it survives context loss.
