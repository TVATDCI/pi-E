# Pi Handoff — Main-vault sharing adopted; research stack + quotas + public-apis resource shipped (2026-08-17)

**Written at:** 2026-08-17T19:05:00Z
**Pi session:** (current session, ~/.pi cwd)
**Original intent:** "This session is about to introduce you to my Main-vault — explore deep, then advise what to absorb into our global system."

## Summary
Session grew from a Main-vault exploration into the full adoption of a ratified cross-agent sharing policy (A+C: pi read-only vault QUERY + operator-arbitrated write lane), proven twice via C-path runs; then extended pi's research stack (pi-mcp-adapter + zai webSearchPrime MCP + pi-quotas with a local provider-alias patch), fixed the bd-bridge cron rot, ran an adversarial review-loop on the adoption implementation, and placed the public-apis clone as a living resource at ~/developer/public-apis with a vault discovery page.

## Files touched
- ~/.pi/agent/AGENTS.md — Main-vault clause (+ review-loop hardening: hotcache exclusion, injection guard)
- ~/.pi/agent/skills/main-vault-query/SKILL.md — NEW, the 9 Oracle conditions
- ~/.pi/agent/skills/{skill-creator,skill-auditor,session-close}/SKILL.md — KV-cache layout, pi-safety exemptions, CONTRIBUTE routing
- ~/.pi/agent/agents/archivist.md — DELETED (operator; in-graph vault-write bypass)
- ~/.pi/agent/teams.yaml — archivist entries removed
- ~/.pi/agent/bridge/export-bd-global.sh — BEADS_DIR+PATH self-sufficiency (cron-silent-failure root cause)
- ~/.pi/agent/exports/ — mainvault-adoption-2026-08-17/ (8), apis-decision-2026-08-17/ (5), public-apis-opportunities-2026-08-17.md
- ~/.config/mcp/mcp.json — zai-web-search server (key from auth.json, perms 600)
- ~/Main-vault — QUERY lane-partner note (AGENTS.md), public-apis-repository.md + index line (via C-path runs 1-2, operator committed)
- crontab — hourly bridge export (17 * * * *)

## Decisions made
- A+C Main-vault policy ratified with 9 Oracle conditions — library, not brain; pay-per-use T3
- pi-quotas opencode-go row NOT configured (cookie friction > value; dashboard suffices) — operator call
- pi-mcp-adapter over opencode-side zai wiring — optionality + bucket already paid
- public-apis: A+C placement (~/developer clone + vault page), ff-only on-demand pulls, NO cron; 5 conditions from sis+Oracle unanimous
- Runtime-state files (quotas.json, mcp-cache/onboarding) gitignored — self-seeded, machine-local

## Dead ends
- "Z.ai row will just work" in pi-quotas — FALSE: literal provider-name lookup vs custom id zai-coding-cn; patched locally (re-apply after updates; upstream-alias issue candidate)
- Blind `git add bridge/...` — bridge/ deliberately ignored; per-file carve-out applied instead (script tracked, data ignored)
- Single compound command for the clone move — command-guard blocked on rm -rf tail; split into mv + rmdir (empty shells) worked clean

## Incomplete work
- API-opportunities structuring — operator will list structure before building (ideas preserved in exports + vault page pointer)
- Permission-prompt watch-item (brain-ecf, sis-side): no prompt fired on either C-path run; mandate-in-lane remains the true authorization surface
- pi-quotas upstream issue for provider-alias config — drafted mentally, unfiled

## Proposed bd facts
- scope=global | category=decision | key=public_apis_placement_ac | value="public-apis clone at ~/developer/public-apis (living, ff-only on-demand pulls, no cron, untrusted-content doctrine, outside dotfiles ownership) + vault wiki/sources/public-apis-repository.md discovery page (C-path run 2, receipt-verified, operator committed a19d935). Ratified A+C after sis+Oracle unanimous convergence 2026-08-17."
- scope=global | category=next | key=api_opportunities_structuring | value="Operator structuring pi's 8-item API-opportunities list (MCP tool factory leads; 723 no-key APIs; pointer at ~/.pi/agent/exports/public-apis-opportunities-2026-08-17.md + vault page) before any build."

## Next steps for opencode
- Verify pi's push lands (4 commits pending operator push: 313e248..f72e25d + this session-close)
- brain-ecf permission-prompt investigation unaffected — still open
- Optional: complete-codebase timeline for research-stack additions (pi-mcp-adapter, zai MCP, pi-quotas) at sis's next session-close
