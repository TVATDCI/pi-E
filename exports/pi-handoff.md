# Pi Handoff — davidondrej skills absorption + guard + web access; pi-as-daily-driver progress (2026-08-16)

**Written at:** 2026-08-16T23:39:24Z
**Pi session:** 2026-08-16T14-08-02-225Z_01a00ae6-a2b1-7d80-8557-007b1d1a97d7 (+ restarts)
**Original intent:** explore /home/vladi/developer/davidondrej-skills/skills via find-skills, then validate→absorb what fits pi.

## Summary
Full absorption cycle executed: 48-skill repo explored → candidates/rejects verdict → oracle second opinion via herdr-collab lane (GO-WITH-CHANGES) → D1–D5 plan → executed + review-looped (2 rounds) + committed. pi gained a tested command-guard extension, 4 new skills (git-worktree, decisions, pi-web-search, research-prompt), a skill-creator upgrade, herdr-collab v0.2.2, real web access (pi-web-access), and a live-verified 429-fallback fix in dispatch orchestration. ~/dotfiles adopted the shared denylist + herdr-collab (new agents/ tree, ghostty-pattern symlinks). Operator articulated the umbrella model: dotfiles → ghostty/herdr/pi/opencode, with pi being developed into the daily driver inside herdr (in progress, not settled).

## Files touched
- ~/.pi/agent — NEW: extensions/command-guard.ts, extensions/lib/command-guard-core.ts, extensions/tests/command-guard.test.ts (119/119), skills/{git-worktree,decisions,pi-web-search,research-prompt}/SKILL.md; MODIFIED: extensions/orchestration-engine/{spawn.ts,spawn-outcome.ts} (+ tests 15/15), skills/skill-creator/SKILL.md, README.md, settings.json (pi-web-access), .gitignore-adjacent npm/.gitignore now tracked; exports/{absorption-plan-davidondrej.md,absorption-oracle-review.md}. Zone.Identifier junk removed.
- ~/dotfiles — NEW: agents/hooks/dangerous-patterns.txt, agents/skills/herdr-collab/ (commit 3c7c3a7).
- ~/.agents — symlinks into dotfiles (hooks + herdr-collab).
- pi commits: d355973, 250d48c, 91e8dea, 97d8488, 246b9bf (+ this handoff commit).

## Decisions made
- D1 GO command guard; D3 shared patterns at ~/.agents/hooks, dotfiles-owned — one tuning point, matches source design; asymmetry vs sisyphus-gates is deliberate (seatbelt vs policy gate).
- D2 absorb git-worktree (tool-agnostic core; Cursor ~15% stripped). D4 take decisions (manual-only; pi honors disable-model-invocation — verified). D5 herdr sharp edges went into herdr-collab skill (shared substrate).
- effective-agent-skills MERGED into skill-creator (dedupe-then-compress, ~33 lines), not installed alongside — two authoring skills = routing collision.
- pi-web-access installed after sis lane review (low-risk, kills lane round-trips, no duplication); keyless first (150/day), EXA_API_KEY only if it pins.
- Division of labor ratified: pi = breadth web, opencode = depth (Context7, cross-repo, blocked sites, synthesis). Paid keys in ONE stack.

## Dead ends
- "Operation aborted" during E2E guard probe — was the operator's own mini-damage-control aborting the NESTED pi (force-push BLOCK, mode=abort), not a guard fault. Discriminator-probe technique: use an uninstalled password-manager CLI so guard-failure = harmless command-not-found; NEVER probe with `gh auth token` (failure prints a real token).
- spawn.ts mid-fix corruption: a malformed edit left a broken function (helper body fused into loadPersona). Caught by immediate post-edit syntax checks, repaired; round-2 reviewer verified clean. Lesson: verify edit results immediately when edits share anchors.
- One davidondrej herdr edge is STALE on herdr 0.8.0 ("pane read --lines below viewport → empty" does NOT reproduce; probed --lines 1/5/10/42). Probes before enshrining third-party claims — the local-evidence rule paid off.
- reviewer-security `deep` dispatch 429'd terminally pre-fix — root cause: fallback gate only fired on EMPTY output; in-band error text makes output non-empty. Fixed (spawnFailedForFallback), live-verified opencode-go→zai glm-5.3.
- Lane prompt --wait timed out at 6min while oracle was mid-review (working ≠ stalled). Anti-reflex rule: agent get + read BEFORE any input decision.

## Incomplete work
- herdr-collab description fix (audit finding: how-summary + missing Do-NOT-use-for boundary) — one dotfiles commit, deliberately pending operator timing.
- pi-custom-model skill still parked (trigger: next scoped-models/tier-map session; re-probe bundled-models-list path then).
- Lane dirs /tmp/herdr-collab/{absorb-davidondrej,pi-daily-driver}/ — pi created them; pi cleans them next session or on request (sis-response.md worth archiving first if wanted).
- planning/ PLAN docs lack SHIPPED/SUPERSEDED status headers (flag-only nicety).

## Proposed bd facts
- scope=global | category=constraint | key=lane_citation_contract | value="Lane research claims carry provider+URL per load-bearing finding so the peer spot-verifies instead of re-searching (ratified pi+sis 2026-08-16); confirmed/inference/unresolved separated, no fake consensus."
- scope=global | category=constraint | key=web_division_of_labor | value="pi handles breadth web research (keyless Exa 150/day, news/blogs/forums/release notes/GitHub reads); opencode/sisyphus handles depth (Context7, cross-repo code search, blocked/anti-bot sites, multi-source synthesis). Paid keys live in ONE stack's config."
- scope=global | category=dependency | key=shared_command_denylist | value="~/.agents/hooks/dangerous-patterns.txt is a shared catastrophic-command denylist (32 POSIX-ERE, Linux), owned by ~/dotfiles/agents (symlinked), re-read per call by pi's command-guard. Deliberate asymmetry vs sisyphus-gates stands; an opencode-side consumer is possible later if ever wanted."
- scope=global | category=exact | key=pi_web_access_install | value="pi runs pi-web-access v0.23.0 (keyless Exa: 3 QPS / 150 calls/day; web_search always workflow:none). Installed 2026-08-16 after sis review; add EXA_API_KEY only if the 150/day ceiling pins."

## Next steps for opencode
- Review/promote the proposed bd facts above (Step 5); the citation contract + division of labor are the load-bearing ones for future lanes.
- Note herdr-collab is now v0.2.2 with probe-verified sharp edges (send-text no-submit + separate enter for TUI composers; C0 bytes erase typed text; foreground_cwd vs frozen cwd; verify submit by lifecycle flip, never content-change).
- pi's herdr-collab reviews (sis-review-v0.1/v0.2) moved with the skill into ~/dotfiles/agents/skills/herdr-collab/reviews/.
- pi-as-daily-driver development continues (operator-driven, inside herdr); pi's repo is clean at 246b9bf with this handoff on top.
