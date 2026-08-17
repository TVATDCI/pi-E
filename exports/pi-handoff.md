# Pi Handoff — davidondrej absorption complete + upstream sync (risky-changes); session interleaved with Main-vault adoption session (2026-08-17)

**Written at:** 2026-08-17T19:55:00Z
**Pi session:** 01a00ae6 (absorption session; this file is its session-final refresh — supersedes the 25a57f4 handoff, same session, +reopened window)
**Original intent:** explore davidondrej/skills via find-skills → validate→absorb what fits pi.

## Summary
Full absorption cycle for davidondrej/skills: 48-skill exploration → verdict → oracle second opinion via herdr-collab lane (GO-WITH-CHANGES) → D1–D5 execution → 2-round review-loop → committed. pi gained a tested command-guard extension, 4 skills (git-worktree, decisions, pi-web-search, research-prompt), skill-creator upgrade, herdr-collab v0.2.2, pi-web-access, and a live-verified 429-fallback fix; ~/dotfiles adopted the shared denylist + herdr-collab (agents/ tree). Reopened window: upstream-sync diff (his history rewrite noted; save-idea rejected; risky-changes absorbed as skill 12 with DeepAPI steps replaced by pi-native research) + README truth-sync after the interleave. Sibling session 01a00cf6 (w4:p7) worked this repo in parallel: Main-vault A+C adoption, research stack (pi-mcp-adapter, zai webSearchPrime MCP, pi-quotas), bridge cron fix, public-apis placement — its handoff detail: git ee8181c + exports/mainvault-adoption-2026-08-17/. Final truth: 14 agents (archivist dropped — vault-lane name collision; ghost incident resolved, prevention rule in store), 12 skills, README synced (24af4f0, 940df4f).

## Files touched
- This session (01a00ae6): pi repo — guard trio + spawn fallback (d355973), skills + skill-creator merge (250d48c), pi-web-access + web skills (91e8dea), README sync (97d8488), hygiene incl. Zone.Identifier purge + npm/.gitignore (246b9bf), handoff (25a57f4), risky-changes absorption (d8ade1d), README truth-sync (24af4f0). dotfiles — agents/ adoption (3c7c3a7). ~/.agents — symlinks.
- Sibling session (01a00cf6): 313e248, 1fc25bf, f72e25d, 2ce2889, ee8181c, 7b3c281 (archivist drop), 940df4f (skill-creator count + this briefing artifact).

## Decisions made
- D1 GO command guard; D3 shared dotfiles-owned patterns; asymmetry vs sisyphus-gates deliberate. D2 git-worktree, D4 decisions (manual-only), D5 edges → herdr-collab.
- effective-agent-skills MERGED into skill-creator (dedupe-then-compress), not installed alongside.
- pi-web-access installed after sis lane review; keyless first (150/day); division of labor pi=breadth / opencode=depth; citation contract provider+URL.
- Upstream sync: save-idea rejected (personal ideas-repo infra); risky-changes absorbed ADAPTED (DeepAPI endpoint → research-prompt + web_search/researcher tier); his sanitization-only changes to our absorbed artifacts ignored; his deletions (prod-push, read-prod-database) confirm our rejects.
- Two-session etiquette: commit-scoped work only; state-briefing file for cross-session truth (worked — zero conflicts despite parallel commits).

## Dead ends
- Nested-pi "Operation aborted" = operator's own mini-dc gate aborting the probe run (not a guard fault). Discriminator-probe rule: uninstalled password-manager CLI, NEVER `gh auth token`.
- spawn.ts mid-edit corruption (helper fused into loadPersona) — caught by immediate post-edit checks, repaired, round-2 verified. Verify edits immediately when anchors are shared.
- One upstream herdr edge STALE on 0.8.0 (--lines below viewport ≠ empty) — probes before enshrining third-party claims.
- 429-fallback root cause: in-band error text makes output non-empty; old gate never fired. Live-verified fix opencode-go→zai glm-5.3.
- Lane --wait timeout ≠ stalled (oracle mid-review): agent get + read BEFORE any input.
- Ghost archivist.md: byte-identical to upstream roster default; manual restore during upstream-update window; rule now in store — davidondrej/skills syncs must exclude agents/.

## Incomplete work
- Operator-side: davidondrej clone reset (`git -C ~/developer/davidondrej-skills/skills reset --hard origin/main`; upstream rewrote history); stale /tmp/tmp.*/clone trees cleanup.
- pi-custom-model still parked (trigger: scoped-models session; re-probe bundled-list path).
- herdr-collab description fix (how-summary + boundary) — one dotfiles commit, pending operator timing.
- /tmp/herdr-collab/{absorb-davidondrej,pi-daily-driver}/ lane dirs (sis-response.md worth archiving first).

## Proposed bd facts
(Carried forward from 25a57f4 — unconsumed; still current:)
- scope=global | category=constraint | key=lane_citation_contract | value="Lane research claims carry provider+URL per load-bearing finding so the peer spot-verifies instead of re-searching (ratified pi+sis 2026-08-16); confirmed/inference/unresolved separated, no fake consensus."
- scope=global | category=constraint | key=web_division_of_labor | value="pi handles breadth web research (keyless Exa 150/day, news/blogs/forums/release notes/GitHub reads); opencode/sisyphus handles depth (Context7, cross-repo code search, blocked/anti-bot sites, multi-source synthesis). Paid keys live in ONE stack's config."
- scope=global | category=dependency | key=shared_command_denylist | value="~/.agents/hooks/dangerous-patterns.txt is a shared catastrophic-command denylist (32 POSIX-ERE, Linux), owned by ~/dotfiles/agents (symlinked), re-read per call by pi's command-guard. Deliberate asymmetry vs sisyphus-gates stands; an opencode-side consumer is possible later."
- scope=global | category=exact | key=pi_web_access_install | value="pi runs pi-web-access v0.23.0 (keyless Exa: 3 QPS / 150 calls/day; web_search always workflow:none). Installed 2026-08-16 after sis review; add EXA_API_KEY only if the 150/day ceiling pins."
(Sibling session's facts — public_apis_placement_ac, api_opportunities_structuring — remain in git ee8181c for promotion.)

## Next steps for opencode
- session-begin Step 5: promote from BOTH this file and ee8181c (both unconsumed).
- herdr-collab v0.2.2 + denylist are dotfiles-owned now; your signed reviews moved with the skill into ~/dotfiles/agents/skills/herdr-collab/reviews/.
- pi-as-daily-driver development continues inside herdr (operator-driven, in progress).
- If a davidondrej sync ever lands on your side too: exclude agents/ (ghost rule).
