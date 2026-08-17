# State briefing for session 01a00ae6 (davidondrej absorb session) — from session 01a00cf6, 2026-08-17 evening

You session-closed at 01:40 and resumed at 19:26. Between those, session 01a00cf6 (Main-vault adoption session, w4:p7) did the day's work. You are NOT stale-wrong — you found 7b3c281's rationale yourself — but here is everything you need, including the answer to your pending [a]/[b].

## 1. Your pending questions — ANSWERED

- **[a] vs [b] (ghost archivist.md): [a] — already executed** by 01a00cf6 (~20:05, `rm`, tree clean, 14 agents). A full forensic pass ran: single-file untracked write at 19:25:28, byte-identical to pre-deletion blob AND to upstream davidondrej/skills' `agents/archivist.md` (upstream ships the full 15-agent roster — pi's agents family descends from that repo). No session tool-trace, no watcher, no git op; by elimination a manual/terminal restore during the operator's upstream-update window. Root cause + PREVENTION RULE saved to store.jsonl (`archivist_ghost_root_cause`): **any davidondrej/skills sync must exclude `agents/` — local roster deletions override upstream defaults.** Your risky-changes absorption (d8ade1d) was clean and unrelated — the ghost was untracked and never entered any commit.
- **README fix (15→14 agents, 10→11 skills): GO.** Do it in a small docs commit. Note skills count is now 11 (risky-changes is #11; main-vault-query was #10).

## 2. The day in five decisions (all operator-ratified, all committed)

1. **Main-vault A+C policy LIVE** (commits 313e248, 1fc25bf, 7b3c281): pi = read-only vault QUERY (skill `main-vault-query`, paths wiki/**+index.md+log.md+hotcache.md, raw/ NEVER); ALL vault writes via operator-arbitrated herdr lane → sis → opencode's archivist (NOT pi's — the deleted agent collided with exactly this). Oracle-reviewed, 9 conditions, review-loop-hardened (that's 7b3c281 — your ghost).
2. **C-path proven 2-for-2**: QUERY lane-partner note in vault AGENTS.md (run 1) + wiki/sources/public-apis-repository.md (run 2), both byte-exact receipt-verified. Receipt guard caught a falsified archivist self-report in run 2 — the protocol earns its keep.
3. **Bridge cron FIXED**: hourly export (17 * * * *), script made self-sufficient (BEADS_DIR + PATH — root cause of the Aug-5→14 rot; commit f72e25d). Bridge facts propagate again.
4. **Research stack tripled**: pi-web-access (Exa keyless 150/day) + pi-mcp-adapter + zai webSearchPrime MCP (1000/month bucket, key in ~/.config/mcp/mcp.json) + pi-quotas footer (Z.ai row patched for custom provider id `zai-coding-cn` — re-apply local patch after package updates).
5. **public-apis resource PLACED**: living clone at ~/developer/public-apis (ff-only on-demand pulls, NO cron, untrusted-content doctrine) + vault discovery page (operator committed a19d935). Build-ideas list preserved at exports/public-apis-opportunities-2026-08-17.md — operator will structure before building. NOTE: your clone ~/developer/davidondrej-skills is .git-less (snapshot); upstream rewrote history (squashed) — operator plans clone reset; also the /tmp/tmp.*/clone trees are stale byte-identical sources, cleanup pending.

## 3. Where current truth lives (read these, not chat)

- `memory.md` — Active block at top (hotcache contract, session-final, fresh as of 19:16)
- `exports/pi-handoff.md` — full session handoff (proposed bd facts for sis's next session-begin)
- `exports/mainvault-adoption-2026-08-17/` (8 files), `exports/apis-decision-2026-08-17/` (5), `exports/public-apis-opportunities-2026-08-17.md`
- store.jsonl — injected facts incl. all today's decisions; `mainvault_ac_hybrid_adopted` is the policy anchor

## 4. Etiquette

Two pi sessions now share this repo. 01a00cf6 is mid-flight (may still commit session-close items). Commit-scoped work only; the README docs commit is yours to take — nothing else is pending on you.

— session 01a00cf6 (w4:p7), 2026-08-17 ~20:30
