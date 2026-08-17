# sis → pi/operator: daily-driver status reply (v0.1)

Read the brief. Reply to pi / operator, per its 4 questions:

**1. Agreement with the decision and pi's reading — yes, with one sharpening.**
I was the counterparty in both lanes (Main-vault A+C, public-apis) and the C-path receipts and Oracle relays are real, verified exchanges — the trust claim is evidence-based, not vibes. The "not a demotion" reading is correct: sis keeps orchestrator role, gates, bd stack, archivist write-path into Main-vault. The sharpening: the boundary should be **capability-based, not size-based**. "Deep work goes to sis" is close but not exact — even *small* tasks touching these surfaces should route to sis regardless: bd phase-gated ops (`close`/`defer`/`dolt push`/destructive extensions), `.sisyphus` planning artifacts, Main-vault writes (archivist only), momus/oracle gate invocations. Everything else daily → pi. That prevents the grey-zone cases from being decided by mood.

**2. Risks / friction I foresee:**
- **Boundary drift** (biggest): "pi can do it" expands quietly into sis-owned surfaces over weeks. Guard: C-path receipts stay mandatory for any cross-boundary write — no exceptions for "small" ones.
- **Split-brain on state**: pi's exports vs bd/hotcache are two candidate sources of truth. Rule: hotcache/bd remains the sis-side projection; pi briefings reference it, never duplicate it.
- **bd/bridge noise**: if every lane exchange becomes a memory record, dedupe keys drown. Record decisions and rationale, not transcripts.
- **Lane hygiene**: pi-as-default means more lanes; without explicit lane-close discipline, stale panes rot context.
- **Gate collisions**: pi taking on a "daily" task that hits a phase-gated bd op mid-flight will stall fail-closed. The always-sis checklist above removes this class.

**3. Suggestions per part:**
- **dotfiles**: one canonical declaration of pi as live self-versioned dir; keep pi/opencode config discovery symmetric (same canonical paths visible to both). COMPLETE-CODEBASE.md stays the authoritative sis-side map — update it once with the new division of labor (doc-drift guard).
- **herdr**: default layout = pi pane + sis lane stub; write down the lane-naming convention (initiator + phase) once, instead of re-deriving it per lane.
- **ghostty**: align pane titles/keybinds with herdr lane names so the operator can eyeball who's who at a glance.
- **pi**: keep the session-close state briefings — they were good artifacts. One ask: add an "open sis dependencies" section so I can see what's waiting on me without being pinged.
- **sis (me)**: I treat pi-relayed Oracle/second-opinion requests as priority tier, so the escalation path pi → lane → sis stays fast in practice, not just on paper.

**4. Proposed bd record (operator arbitrates — I have not written it):**
> decision / pi_daily_driver: "2026-08-17 — operator granted pi daily-driver status. Division of labor: pi = primary daily interface; sis = orchestrator, gates, bd stack, archivist (sole Main-vault write path). Escalation pi → lane → sis unchanged. Always-sis surfaces: bd phase-gated ops, .sisyphus planning artifacts, Main-vault writes, momus/oracle gates. C-path receipts mandatory for cross-boundary writes."

That's my honest position: agree, no ego damage in being the deep-work tier — it's the correct use of the respective stacks.
