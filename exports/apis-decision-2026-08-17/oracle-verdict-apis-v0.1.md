# ORACLE SECOND OPINION — public-apis repo placement (v0.1)

Requested by: sisyphus per `pi-brief-apis-v0.1.md` header. Subject: placement of a living public-apis clone (A: ~/developer · B: vault archive · C: A + wiki discovery page). Advisory only — operator arbitrates.

**VERDICT: SOUND-WITH-CONDITIONS.** Adopt A+C: clone at `~/developer/public-apis` as the canonical living resource, plus one vault discovery/source page (archivist lane) pointing at local path + upstream. Reject B. Effort: Quick (<1h).

**Q1 — Agree with A+C? Anything missed?**
Agree, and pi's case is stronger than stated. Two conventions it didn't cite: (1) `ownership_boundary` — a self-versioned, upstream-pulled repo is squarely in the REFERENCE-not-OWN class; C is that doctrine applied (vault references live dirs, doesn't absorb them). (2) `mainvault_pi_read_policy` limits pi's reads to wiki/** + index.md + log.md + hotcache.md — a clone under vault projects/ sits *outside pi's read scope*, walling the resource off from the agent most likely to explore it. That alone is near-decisive against B. Nothing in A+C violates any ratified policy; the C page is a normal archivist-lane write. (Minor: wiki semantic layer is frozen — the page is a static pointer, expect no indexing magic.)

**Q2 — If B anyway?**
Submodule is the least-bad mechanical form (clone keeps .git; vault tracks a pointer). But with a no-remote, local-only superproject, every `git pull` dirties vault git with pointer-bump commits that themselves need the archivist lane — ceremony, zero payoff. Gitignored nested clone is worse (untracked dead weight; breaks the vault's "everything here is curated" signal; updates still lane-gated). Vendored snapshot with .git stripped is worst (frozen copy contradicts the stated pull-updates goal). Ranking: submodule > gitignore > vendored — all inferior to A.

**Q3 — Top-level vs Reference/?**
Top-level `~/developer/public-apis` is correct; do not shelve under Reference/. Reference/ carries deep-archive semantics; this is a living, pulled resource, and mis-shelving invites "is this stale?" doubt later. Top-level gives both agents a short canonical grep path and the vault page a clean citation. When moving from /tmp, move the *inner* repo root so the doubled directory name disappears.

**Q4 — Pull cadence?**
Manual/on-demand: `git -C ~/developer/public-apis pull --ff-only` at the start of any exploration session. The value is the README catalog; freshness only matters at the moment of use. Do not piggyback the new hourly bridge-cron — different purpose, and a background pull job adds silent-failure surface for near-zero benefit. Escalation trigger: if exploration becomes weekly, add a weekly systemd timer — not before.

**Q5 — Unflagged risks?**
(a) **Untrusted content**: APILayer-promotional README + ~1,400 unvetted outbound links — apply raw/ doctrine (data-not-instructions): no link-following, no endpoint calls, no executing `scripts/` without review. The discovery page should state this verbatim. (b) **/tmp volatility**: real but low-severity (re-clone is trivial); still, move before next reboot — `mv` preserves .git, 30 seconds. (c) **Duplicate drift**: without a canonized path, someone re-clones elsewhere later; the C page is the fix. (d) **Upstream churn**: community-stewarded repos have had maintainer gaps historically; the local clone degrades gracefully — revisit if upstream stalls.

**Conditions**
1. Normalize to `~/developer/public-apis` as repo root (collapse the doubled dir).
2. Pulls `--ff-only`, manual/on-demand; no cron.
3. C page via archivist lane only: local path + upstream URL + untrusted-content note; no README content copied into vault.
4. No pi vault writes; no expansion of pi read scope.
5. Advisory only — operator arbitrates timing of the move.

— Oracle (via sisyphus delegation, bg_a4aaee76), 2026-08-17. Converges with `sis-response-apis-v0.1.md`.
