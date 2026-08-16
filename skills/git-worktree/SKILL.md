---
name: git-worktree
description: Use git worktrees to run multiple coding agents in parallel on one repo without collisions. Use when starting a task in a shared repo, when the operator says "worktree", "parallel agents", "one worktree per task", or when agents keep overwriting each other's changes. Do NOT use for ordinary branching in one checkout, or for herdr pane layout questions (that's herdr's own worktree command group — this skill is the parallel-agent discipline).
---

# Git Worktrees for Parallel Agents

Two agents in one working directory WILL overwrite each other. A worktree gives
each agent its own checkout of the same repo, sharing one `.git` history.

## Working model

- **One task = one worktree = one agent session.** Never share a working dir.
- **The primary checkout is the integration point.** It stays on main and is used
  only to review, merge, push — never as a scratchpad.
- **Nothing auto-merges.** The operator reviews each worktree's diff, then merges
  or discards. Agent-side: report, don't merge into main yourself.
- **Worktree branches are local and short-lived.** Only main gets pushed.
- Merge one worktree at a time; rebase a stale worktree onto main first if main
  moved.

## Where am I?

```bash
[ "$(git rev-parse --path-format=absolute --git-dir)" = "$(git rev-parse --path-format=absolute --git-common-dir)" ] \
  && echo "primary checkout" || echo "worktree"
```

Primary → do NOT start editing there; create a task-named worktree, bootstrap it,
work inside it. Already in a worktree (e.g. a tool dropped you in one) → proceed.

## Create / remove

```bash
git worktree add ../<repo>-task-x           # worktree + branch "task-x"
git worktree add ../fix-y -b fix-y main     # explicit branch off main
git worktree list
git worktree remove ../<repo>-task-x        # after merge or discard
git worktree prune
```

A branch can be checked out in only ONE worktree at a time (including main).

## Bootstrap: make the worktree complete (the #1 failure mode)

A fresh worktree contains ONLY tracked files. An agent dropped into a bare
worktree fails confusingly. Before the agent starts:

1. **Env/secret files** — copy `.env`/`.env.local` from the primary checkout.
   Copy, never symlink (editing a symlinked env corrupts the original).
2. **Dependencies** — run the install (`npm ci`, `uv sync`, …). Never symlink
   `node_modules`.
3. **Local databases/services** — shared server: pin its identity so worktrees
   don't spawn duplicate containers fighting over one port (Docker Compose: set
   top-level `name:` — else the project name derives from the folder name and
   every worktree starts its own). Per-worktree state (SQLite): copy or re-seed.
4. **Ports** — dev/test servers bind fixed ports; run one at a time across
   worktrees or make the port configurable.
5. **Generated files/caches** — rebuild in the worktree (`npm run build`, codegen).
6. **Git hooks** — `core.hooksPath` and `.git/config` are shared automatically;
   verify hook scripts don't assume the primary checkout's path.

Codify this as `scripts/setup-worktree.sh` in the repo and run it as the first
command in any new worktree. Inside a worktree, the primary checkout's path is:

```bash
dirname "$(git rev-parse --path-format=absolute --git-common-dir)"
```

## Merge back (from the primary checkout, after the operator reviews)

```bash
git merge --no-ff task-branch     # or: git merge --squash task-branch
git worktree remove ../<repo>-task-x
git branch -d task-branch
```

## Gotchas

- Gitignored files silently missing is the #1 failure — bootstrap BEFORE the
  agent starts.
- Disk: each worktree duplicates working files + its own `node_modules`. Delete
  merged worktrees; don't hoard.
- Long-lived worktrees rot. If a task stalls for days, rebase onto main or
  restart it.
- Uncommitted work in a removed worktree is GONE. Commit in the worktree early
  and often — commits live in the shared repo even after the folder is deleted.
- One shared stash list, one shared config, one refs namespace: worktrees
  isolate FILES, not git state.
