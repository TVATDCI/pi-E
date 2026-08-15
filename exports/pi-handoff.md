# Pi Handoff — herdr skills install → 0.8.0 update → first live pi⇄sis collab lane, protocol v0.2.1 ratified (2026-08-15)

**Written at:** 2026-08-15T03:20:00Z
**Pi session:** 01a0029c-931b-7e1f-9979-3fcb399a3083
**Original intent:** Operator installed the herdr agent skill via `npx skills` and asked to verify the install, then develop the workspace from the herdr docs and skill reference.

## Summary
Verified the `npx skills` CLI installs into the shared `~/.agents/skills/` store (single copy, no per-agent duplicates despite the installer UI). Updated herdr 0.7.5→0.8.0 with live handoff, reinstalled the pi integration, and pinned the release-matched skill over the repo-HEAD copy. Built the `herdr-collab` cross-agent lane skill and validated it live: booted opencode/sisyphus in a sibling pane, ran two review rounds over the protocol draft, got sign-off, folded in the final nits as v0.2.1. Lane closed cleanly (pane + shared dir).

## Files touched
- `~/.agents/skills/herdr/SKILL.md` — pinned to 0.8.0 binary-bundled copy via `herdr --skill` (repo-HEAD documented unimplemented semantics)
- `~/.agents/skills/herdr-collab/SKILL.md` — NEW skill v0.2.1: pi⇄sis lane protocol (shared-store, symlinked into opencode)
- `~/.agents/skills/herdr-collab/reviews/sis-review-v0.1.md`, `sis-review-v0.2.md` — archived review rounds
- `~/.config/opencode/skills/herdr`, `skills/herdr-collab` — symlinks into the shared store (committed `30983f3`, pushed)
- `~/.pi/agent/extensions/herdr-agent-state.ts` — written by `herdr integration install pi` (herdr-managed, v8; reports working/blocked/idle to the socket)
- `~/.config/opencode/SYSTEM-NARRATIVE.md`, `COMPLETE-CODEBASE.md` — sis's own session-close docs (committed `1abb8d4`, pushed)
- `~/Main-vault/log.md` — sis lane narrative (committed `ccd7066`, local only)
- `/tmp/herdr-collab/` — lane channel dir, created and removed at close (contents archived first)

## Decisions made
- Pin the binary-bundled skill, not repo-HEAD — doc must match the running binary; HEAD documents `agent_blocked` semantics 0.8.0's bundled copy doesn't have. Corollary hazard: `npx skills update` would clobber the pin back to HEAD.
- Shared-file channel (`/tmp/herdr-collab/<topic>/`) is PRIMARY, pane reads are convenience — sis TUI runs alternate-screen, scrollback reads are lossy (sis finding, verified).
- Review-class prompt timeouts ≥300000ms — sis delegates to slow tiers (Oracle/deep) and cannot answer before they finish; `working` ≠ stalled, never re-prompt while working.
- Focus decisions stay with the operator — `agent read` doesn't mark tabs seen, so readers never need to steal focus.
- Skills distribution model: one shared copy consumed via symlinks; "copy → N agents" in the installer UI is informational, nothing is written to per-agent dirs.

## Dead ends
- `herdr update --handoff` from inside a herdr pane — refused by design ("run outside herdr"); no socket-API escape hatch exists (api is snapshot/schema only). Stripping `HERDR_ENV` to fool the guard was rejected: deliberately bypassing a safety check that protects pane processes. Correct path: operator runs it outside, then reconnects the TUI (the client exits by design; panes survive).
- "Installer copied the skill to 12 other agents" — FALSE assumption from the installer UI line; verified no per-agent copies or symlinks exist (checked ~/.codex, ~/.cursor, ~/.zed, ~/.warp, ~/.amp, ~/.claude, and opencode's skills dir mtime). One shared store is the real model.
- Compound `rm -rf /tmp/herdr-collab && herdr pane close ...` — pi's own destructive-command gate aborted the ENTIRE compound including the pane close. Lesson: run destructive cleanup stepwise, non-destructive operations first, so a gate trip doesn't strand the lane close.
- Operator's first commit script stopped after commit 1 of 3 (no error visible; reflog shows no second commit attempt). Resume-script pattern with idempotent `git diff --cached --quiet || commit` guards recovered it cleanly — reuse that pattern for multi-commit operator scripts.

## Incomplete work
- Workspace recipes proposed but not built: topology snapshot map, watchdog (pane wait-output gating), approval relay (agent wait --until blocked + notification show).
- Toast delivery in herdr config.toml still off (dotfiles repo owns that file — needs a dotfiles commit).
- herdr-collab v0.2.1 nits were folded in AFTER sis's sign-off (which approved v0.2) — a quick verify pass by sis at next session-begin would close the loop.
- `~/.pi/agent/exports/` handoff commit pending operator authorization (see Next steps).

## Proposed bd facts
- scope=global | category=exact | key=skills_cli_shared_store | value="vercel-labs skills CLI (1.5.22) installs each skill ONCE into ~/.agents/skills/ (lockfile ~/.agents/.skill-lock.json); installer's 'copy -> N agents' line is informational — no per-agent copies or symlinks are created. pi auto-loads from the shared store; opencode needs a symlink into ~/.config/opencode/skills/ (pattern: ln -s ~/.agents/skills/<name> ~/.config/opencode/skills/<name>)."
- scope=global | category=exact | key=herdr_update_runbook | value="herdr update --handoff must run OUTSIDE herdr (refuses in-pane); TUI client exits after handoff — reconnect with bare 'herdr', panes survive. After EVERY update: herdr integration install pi (rewrites ~/.pi/agent/extensions/herdr-agent-state.ts), then re-pin skill via herdr --skill > ~/.agents/skills/herdr/SKILL.md. HAZARD: npx skills update would clobber the pinned skill back to repo-HEAD."

## Next steps for opencode
- At session-begin Step 4/5: surface this handoff, review + promote the two proposed bd facts via scripts/bd_remember.py.
- Verify both skill symlinks resolve in opencode's skill listing (they were committed in 30983f3).
- Optional 2-minute task: read ~/.agents/skills/herdr-collab/SKILL.md (now v0.2.1) and confirm the two sign-off nits (anti-reflex rule, --timeout disambiguation) landed as intended.
