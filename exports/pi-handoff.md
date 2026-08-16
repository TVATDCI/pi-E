# Pi Handoff — pi 0.84.2 update + 4-layer keybinding map + README syncs (2026-08-16)

**Written at:** 2026-08-16T14:01:00Z
**Pi session:** 01a00a57-6c7b-7254-abb4-56cdc4fb5a9b
**Original intent:** Check the "pi update 0.84.2" reminder against the current workflow before applying.

## Summary
Updated pi 0.84.1→0.84.2 after a compatibility pre-check (extension seams untouched; 16/16 test suites green post-update; `pi update --extensions` confirmed N/A — local extensions are source files, not packages). Resolved the one real conflict the update introduced: pi's new transcript search defaulted to ctrl+shift+f, which ghostty consumes; rebound to ctrl+alt+f, enabled pi fullscreen mode, live-verified search end-to-end. Mapped the full 4-layer key-claiming stack (ghostty→herdr→opencode/pi) with local evidence, correcting two misattributions along the way (opencode ctrl+x IS a true leader; ctrl+enter is ghostty's fullscreen, not herdr's). Validated and synced both READMEs (dotfiles: 4 drifts; ~/.pi/agent: 8 drifts incl. tier-table rebuild from live tier-map.ts data).

## Files touched
- `~/.pi/agent/README.md` — 8 drift fixes (pi 0.84.2, glm-5.3@high, auth keys opencode-go not openrouter, tier table rebuilt from tier-map.ts data, structure tree +skills/scripts/compaction/prompt/lib/budgets/security/tests, test-count 16, stray `---READ` artifact removed, date) — commit `d7d551c`
- `~/dotfiles/README.md` — 4 drift fixes (ADR count 7→6 no phantom gap-closure, herdr scope: only config.toml symlinked / layouts+recipes consumed in place, sisyphus-ADR location claim corrected, .vscode added) — commit `f3b8099`
- `~/.pi/agent/keybindings.json` — NEW: `{"tui.altScreen.search": ["ctrl+alt+f"]}` — commit `b9ee716` (operator)
- `~/.pi/agent/settings.json` (gitignored) — `tuiMode: "fullscreen"` added via /settings
- memory store (store.jsonl) — 6 facts: verify_stack_answers_local_evidence, umbrella_stack_daily_driver (pi-daily-driver = PLANNED ONLY, not decided), fullscreen_stack_keybinding_map (corrected ctrl+enter attribution), key_handling_model_per_layer, herdr_prefix_stays_ctrl_b, pi_0842_update_completed

## Decisions made
- Apply pi 0.84.2 — pre-checked compatibility: upstream-adapter seams (input.source, dialog API) untouched; triggerTurn fix doesn't affect mini-task-tracker; agent frontmatter comma-strings still valid. nanoid DoS fix + nanoid-adjacent security was a plus.
- Search rebind Option A (pi-side, ghostty untouched) — operator chose keeping terminal-wide ctrl+shift+f muscle memory; ctrl+alt+f verified unclaimed by ghostty AND herdr AND (per-pane) opencode.
- Keyboard layout FROZEN — herdr prefix stays ctrl+b; operator explicitly declined all changes after evidence review; recorded "do not resurface prefix-change proposals uninvited".
- No pi version pin in dotfiles README — validated as intentional (ADR-0006 self-versioned refs; doctor.sh reads `pi --version` dynamically). The update event needed no dotfiles edit.
- Accountability: after I answered opencode's ctrl+x from memory (wrong), operator set a hard rule — all stack-layer answers must be verified against LOCAL evidence (config file / binary grep / docs) before asserting. Stored as constraint; changed behavior for the rest of the session.

## Dead ends
- herdr prefix ctrl+b→ctrl+X — REJECTED with evidence: `"leader": "ctrl+x"` is explicitly set in ~/.config/opencode/tui.json; herdr claiming ctrl+X would starve the entire <leader>* family (~16 chords: models m, agents a, sessions n/l, compact c, status s, theme t, sidebar b, timeline g, copy/undo/redo, conceal h, editor e, export x, quit q, quick-switch 1-9) inside herdr panes, plus pi's ctrl+x copy/clear binds. Structural rule discovered: ANY chord used as herdr prefix is dead to every app in every pane — pick the chord that costs least, and ctrl+X costs the most. Operator withdrew the whole idea.
- F12 as alternative herdr prefix — technically clean (verified unclaimed across ghostty 72 binds, herdr defaults, opencode tui.json+bundle, pi keybindings.md) but operator declined ANY rebind ("stays all as it is").
- `pi extensions list` from agent bash — HANGS (interactive TUI command blocks outside a TTY; cost a 6-minute stall this session). For package questions use `pi update --help` or docs/packages.md instead.
- `pi update --extensions` — investigated, confirmed N/A: pi's "extensions" there = installed npm/git packages under ~/.pi/agent/npm/; our 18 extensions are local source files loaded at startup, never package-managed. The "Extensions are skipped" notice is expected, not a gap.

## Incomplete work
- `extensions/orchestration-engine/tier-map.ts` line 186 comment still says "7 of 10 categories Z-AI-plan-primary" — contradicts its own data (6 of 10; deep moved to opencode-go/glm-5.3 on 2026-08-14). One-line comment fix flagged but deliberately kept out of the docs commit (code file). pi-side follow-up.
- Live pi sessions still on 0.84.1 code until restart — by design non-disruptive; this close + operator restart resolves it.

## Proposed bd facts
- scope=global | category=constraint | key=stack_key_claims | value="4-layer key map (verified 2026-08-16, local evidence): ghostty consumes ctrl+shift+f (custom) AND ctrl+enter (ghostty DEFAULT) = both toggle ghostty WINDOW fullscreen; ctrl+enter is NOT herdr's — herdr never receives it. herdr prefix ctrl+b shadows opencode ctrl+b session_background + pi cursor-left inside panes (arrow-key fallback works). opencode leader = ctrl+x (tui.json). pi transcript search = ctrl+alt+f, only inside pi fullscreen (tuiMode setting)."
- scope=global | category=decision | key=keyboard_layout_final | value="Stack keyboard layout frozen 2026-08-16: herdr prefix stays ctrl+b. ctrl+X rejected (is opencode's leader — claiming it kills ~18 <leader> chords in panes); F12 clean but declined. Do not resurface prefix-change proposals uninvited."
- scope=global | category=exact | key=pi_version | value="pi 0.84.2 (updated from 0.84.1 2026-08-16; 16/16 extension test suites green; search rebound to ctrl+alt+f; tuiMode fullscreen). opencode stays HELD at 1.17.12 pending PR anomalyco/opencode#40472."

## Next steps for opencode
- Review/promote the three proposed bd facts above (stack_key_claims is the load-bearing one — the ctrl+enter/ctrl+b shadow facts affect every opencode session inside herdr panes).
- pi-side follow-up exists (tier-map.ts stale comment) — pi will handle; nothing blocking sisyphus.
- No cross-agent work was mid-flight this session.
