# PORTABILITY.md — self-portability map for the pi agent repo

**Goal:** a fresh machine goes from `git clone` → working pi agent, checkably, with an explicit map of what travels inside git and what must travel outside it.

`~/.pi/agent` is a single-operator, single-machine agent harness: extensions, agents, skills, prompt templates, chains, and the test suite all live in this repo. The code is path-clean (every extension resolves state via `os.homedir()`-relative paths — no absolute `/home/...` in code). What is NOT in git is the state: secrets, defaults, and the agent's own memory.

## Quick restore procedure

```
# on the new machine:
git clone <repo-url> ~/.pi/agent        # (or copy the directory — same thing)
# copy state files from the old machine (list below)
cd ~/.pi/agent
bash scripts/bootstrap.sh               # checks env + repo shape + state; offers test-gate install
node --experimental-strip-types scripts/run-tests.ts --expect 30   # 30/30 = restored
```

First live model call (or `pi --list-models`) verifies `auth.json` — the bootstrap deliberately checks existence only, never parses secrets.

## What travels inside git (clone = complete)

| Path | What |
|---|---|
| `extensions/` | 80+ modules: coordinator, memory substrate, orchestration-engine, gates, bridges |
| `extensions/tests/` + `extensions/memory/test-*.ts` | 30-file test suite (runner: `scripts/run-tests.ts`) |
| `agents/` | 15 agent definitions |
| `skills/` | 6 skills |
| `prompts/` | 4 prompt templates |
| `scripts/` | `run-tests.ts`, `install-pre-commit.sh`, `bootstrap.sh`, `rotate-memory-md.ts` |
| `decisions/` | ADRs (13) — historical, appendix-only edits per policy |
| `agent-chain.yaml`, `teams.yaml`, `mini-dc-rules.yaml`, `models.json` | chains, teams, safety-gate rules, model pins |
| `themes/`, `assets/`, `tsconfig.json`, `README.md`, `AGENTS.md` | supporting set |

## What must travel outside git

| File | Why gitignored | Action on new machine |
|---|---|---|
| `auth.json` | provider API keys | copy manually (scp/rsync); NEVER commit |
| `settings.json` | local defaults | copy (30s faster than recreating: defaultProvider/model/theme/skills) |
| `memory/store.jsonl` | the agent's structured self-model — the crown jewel | copy |
| `memory.md` | narrative memory log | copy if you want the arc |
| `memory/audit.log` | write audit trail | optional copy (completes the audit story) |
| `bridge/` | read-only bd (Main-vault) projection | DON'T copy — regenerate from the Main-vault side (`export-bd-global.sh`) |
| `sessions/` | session JSONLs, ephemeral | no action |

## System dependencies

- **node ≥ 22.6** — `--experimental-strip-types` for all TypeScript (scripts + tests)
- **pi** — `npm install -g @earendil-works/pi-coding-agent` (this repo is its config dir)
- **Extension deps** — `bash scripts/bootstrap.sh` installs pinned `yaml/minimatch/typebox` from root `package.json` (Oracle condition 2026-08-30; pi bundles them only in some versions)
- **git** — repo + the pre-commit test gate
- **w3m** — only for the web-research extension (warn-only in bootstrap)

Non-default config location: pi honors `PI_CODING_AGENT_DIR` (verified in pi dist). This setup assumes the default `~/.pi/agent`; no machinery is built for relocation.

## Pre-commit test gate

`scripts/install-pre-commit.sh` (offered by bootstrap, idempotent, marked block): every `git commit` runs the 30-file suite (~6s). Escape hatch: `SKIP_TESTS=1 git commit ...`. Uninstall: `rm .git/hooks/pre-commit`.

Note: the runner discovers **git-tracked** test files only (`git ls-files`) — an untracked file matching the test globs never executes. When you add/remove a test file, bump `--expect` (default 30, in `scripts/run-tests.ts` `DEFAULT_EXPECT`).

## Secrets policy

- `auth.json` never committed, never echoed/parsed by bootstrap or any script in this repo.
- The memory store secret-scans values AND keys at the write boundary (`scanSecrets`, `extensions/memory/store.ts`) — a record containing a detected secret pattern is refused, not stored.
- `.gitignore` covers `auth.json`, `.env*`, `sessions/`, `memory/`, `bridge/`, `*.log`.

## Known limitations (honest map)

- Bootstrap cannot verify `auth.json` correctness — first model call is the real test.
- opencode-go / zai provider quotas are per-account, not per-machine — nothing to restore, but expect fallback-tier behavior on quota exhaustion (self-heals on reset).
- This doc must move if `.gitignore` changes — it is the map of that file's intent.
