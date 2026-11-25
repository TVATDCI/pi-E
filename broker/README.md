# minidc-broker

## Post-activation checkout state of a live mirror

The repo root doubles as the live agent home on an installed desk. After
`broker/install.sh` runs install/activation, `git status` on a live mirror
shows exactly:

```
 D mini-dc-rules.yaml
```

plus (before this repo's `.gitignore` covered them) two untracked runtime
paths, `mini-dc-install-mode` and `mini-dc-rules/`. This is the expected
activated state, not damage:

- **`mini-dc-rules.yaml` (deleted in the worktree)** — the rules *source*
  remains tracked repo content at `mini-dc-rules.yaml`; the installer
  migrates it into the protected view at `mini-dc-rules/rules.yaml`,
  which is root:`minidc-broker`-owned and never committed.
- **`mini-dc-install-mode`** — advisory marker written by
  `broker/install.sh`; repair-mode runs re-create it, so hand-deleting
  the marker does not persist.
- **`mini-dc-rules/`** — the protected-view migration destination
  itself; broker-owned runtime state, never committed.

Both untracked paths are gitignored as broker runtime state.
