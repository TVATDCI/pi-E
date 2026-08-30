---
name: omarchy-migration
description: 'Migrate a machine to Omarchy (Arch+Hyprland) and onboard it as a two-desk sibling: flash, install, mirror the agent stack via shared git repos, fork identity, wire the SSH lane. Use when the operator mentions switching a laptop to Omarchy or Linux, flashing an Omarchy ISO, building a second synced machine, or duo Omarchy. Triggers: "omarchy", "switch to omarchy", "flash omarchy", "new machine", "second laptop", "os switch", "mirror this machine". Do NOT use for: general Arch/Linux installs without the Omarchy distro, WSL setup, syncing phones, or day-to-day work on an already-migrated machine.'
---

# Omarchy — machine migration + two-desk onboarding

Codifies the 2026-08-28/30 migration (Win11+WSL → TNT/Omarchy) and the Oracle-ratified
sync doctrine. Ground-truth artifacts: `~/omarchy-migration-plan.md`,
`~/omarchy-reboot-runbook.md`, receipts in `~/.pi/agent/exports/lane-twodesk-sync-2026-08-30/`.
Reference: https://omarchy.org/manual/

## Hard rules

1. **Gates before wipes.** No full-disk install until the backup is verified (digest +
   listing + second copy on a second machine) AND the stick has booted to its wizard
   once. Disconnect every other drive during install.
2. **Identity fork never travels.** auth.json, sessions/, memory*, settings.json,
   bridge data stay per-machine; the .gitignore IS the boundary. Pre-push audit =
   tracked filenames + full git history + content scan for key patterns.
3. **Sync via git-remote + bootstrap ONLY** (Oracle verdict 2026-08-30). No USB
   wholesale copies. node_modules are safer rebuilt; pins in package.json,
   package-lock.json is the record.
4. **Never force-push shared main.** New desk rebases onto origin/main. Conflicts:
   remote wins EXCEPT the replayed commit's own subject; both-intent conflicts abort
   to a lane, operator tiebreaks.
5. **One variable at a time.** No upgrades mid-migration; version parity between
   desks before deep sync; the test gate must pass on both.
6. **Ordering traps.** sshd enabled+tested BEFORE ufw rules. Quote CIDR subnets in
   zsh. Command-guard blocks `rm -r` substrings — use
   `git ls-files -z | xargs -0 git update-index --force-remove`; long commit
   messages via `git commit -F <file>`.

## Core workflow (phase-gated)

**P Recon:** vendor BIOS keys (Lenovo F1/F12, HP F10/F9, Dell F2/F12), SecureBoot+TPM
OFF, wired/2.4G keyboard for the LUKS passphrase, GPU vendor noted.
**B Backup (Gate A):** full-fidelity home tar (minus caches/node_modules) + package
lists + non-git state; digests; test-restore sample; second copy; disconnect drive.
**M Media:** ISO + .sha256 sibling, verify, dd. Stick compatibility is real: a
bit-perfect cheap stick can still never enumerate (VFS panic unknown-block(0,0)) —
if verbose boot loops on the marker search with modprobe blocked, swap the STICK
before debugging anything else.
**I Install:** runbook discipline; AX-family wifi invisible at first boot (probe
-110) → COLD drain (poweroff, unplug AC, hold power 20s) before touching drivers.
Post-install: `sudo pacman -S --needed zsh ghostty`, `chsh -s /usr/bin/zsh`,
`gh auth login`, `opencode auth login` — the new desk's OWN accounts.
**R Restore:** dotfiles clone (or tar-pipe if private repo + no auth yet) →
`install.sh` → repos pull → `bash scripts/bootstrap.sh` → omo.jsonc ships per-machine
(live-test with one real `opencode run`). Identity files come from the BACKUP tar,
never from git.
**V Verify:** omo doctor exit 0 (fallback_models deprecations = cosmetic), suite
green on BOTH desks, one live round-trip per agent, fresh-clone rehearsal in a
scratch dir — the gate that proves the rebuild path.

## Lane onboarding (machine communication)

ssh keypair per direction + Host aliases; ufw allows 22 from LAN only;
`~/lane-inbox/` + `~/lane-check.sh` + systemd user timer (2-min notify) both desks.
Agent engagement across the lane: herdr `agent prompt` by name, or `pane send-text` +
`pane send-keys enter` for nameless agents — verify via state_change_seq bump.
Inbox protocol: durable files, `read/` subdir, replies via scp, session-start inbox
check persisted to memory.

---

## Reference tail (volatile)

- Oracle protocol v1 (sections A–F, executable): `oracle-sync-protocol-v1.md` in the
  lane receipts dir; TNT's execution report + F5 ALL PASS in the same dir
- Hardware log: HP EliteBook 840 G6 (F10/F9, AX200 cold-drain quirk, cheap-stick
  incompatibility) · Lenovo ThinkPad 21EB (F1/F12, MediaTek MT7921 — no AX quirk)
- Pins at authoring: pi-tui@0.84.4, yaml@2.9.0, minimatch@10.2.6, typebox@1.3.22,
  oh-my-openagent 4.19.4 exact, suite = 31 files
- Desktop OS-switch preconditions (Oracle round 1): soak on the sibling incl. cold
  boots (operator may accept organic usage as soak), backup test-restore sample,
  runbook consolidated, non-git state exported, install media + ethernet/tether at
  desk, LUKS recovery key off-machine
