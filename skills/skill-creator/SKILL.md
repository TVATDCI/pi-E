---
name: skill-creator
description: |
  Creates new pi skills and improves existing ones, following pi's lean SKILL.md
  convention. Use when: (1) the user has a skill idea or wants to draft a new
  SKILL.md from scratch, (2) editing/optimizing/improving an existing pi skill,
  (3) tuning a skill's description for better auto-triggering. Triggers: "skill
  idea", "draft skill", "create a skill", "new skill", "improve this skill",
  "optimize skill description", "skill is undertriggering", "write a SKILL.md".
  Do NOT use for: creating pi agents (those live in ~/.pi/agent/agents/*.md — a
  different vehicle), general code generation, one-off scripts, or anything that
  isn't a REPEATABLE workflow.
---

# Skill Creator (pi-native)

Author and improve pi skills following the lean convention shared by
`git-commit-message`, `review-loop`, and `shell-safety`. pi skills are *workflow
docs that auto-load by description match* — not code, not eval'd artifacts. Keep
them lean.

> **pi workflow note.** Draft read-only first; the **operator approves before any
> file is written** to `~/.pi/agent/skills/<name>/SKILL.md`. Skills are REAL files
> (never symlinks to opencode). Never `git push` — that is operator-only.

## Skill vs agent vs one-off

Before drafting, pick the right vehicle — most "skill ideas" are better as an
agent or a direct task:

- **One-off task** → just do it (parent + `trinity`). Don't make a skill.
- **A persona / always-on capability** → a pi **agent** (`~/.pi/agent/agents/*.md`). pi has 15.
- **A repeatable, multi-step workflow the operator will invoke again** → a **skill**. pi has 8.

Skills are for *procedures*; agents are for *personas*. "Behave like X" → agent.
"Do these steps when Y" → skill.

Two skill species — pick before drafting, it sets the body's shape:
- **Capability primitive** — thin wrapper over a deterministic CLI/script; logic
  lives in code; body is 30–80 lines of command examples.
- **Process primitive** — a methodology; pure prompt; checklists and validation
  loops carry the reliability.

## The lean format (non-negotiable)

Mirror the existing skills exactly:

1. **Frontmatter = `name` + `description` ONLY.** pi's parser also accepts
   `license`, `compatibility`, `metadata`, `allowed-tools`, and
   `disable-model-invocation`, and ignores unknown fields (docs/skills.md) — but
   lean is this repo's CONVENTION, not a parser limit. One exception worth using:
   `disable-model-invocation: true` for manual-only skills (e.g. `decisions`).
   pi does NOT require `name` to match the directory (unlike the Agent Skills
   standard) — keep them equal anyway; every skill here obeys this.

   **Colon gotcha (verified, pi 0.84.2 `yaml` parser):** an unquoted
   `description: X: Y` fails with "Nested mappings are not allowed in compact
   mappings" even though lenient parsers accept it. If a description needs a
   mid-sentence colon, single-quote the whole value and double inner apostrophes
   (`'X: finds gaps in someone''s setup'`).
2. **`description` is the sole trigger.** It must carry: what the skill does, when
   to use it, a `Triggers: "…", "…"` phrase list, and a `Do NOT use for:`
   boundary. Be **pushy** — agents undertrigger; spell out the near-miss cases
   that *should* fire it.
3. **One self-contained `SKILL.md`**, imperative, explains the *why*. H1 title →
   short intro → `##` sections → code blocks / examples. No `references/`-or-
   `scripts/` subdirs (pi's convention is one file; add a sibling only if a skill
   genuinely outgrows one, loaded on demand).
4. **pi-native primitives only.** Reference `dispatch`, the 15 agents, tier-map as
   the sole model authority — never opencode's task/skill-tool/MCP.
5. **pi-safe.** No `bd`, no opencode-API, no `.sisyphus`/Main-vault deps.

Match instruction rigidity to fragility: loose heuristics when many approaches
are valid; pseudocode/templates when there's a preferred pattern; exact scripts
and strict step lists when the workflow is fragile or consistency-critical
(migrations, config patching).

## Layout: stable-top, volatile-tail (KV-cache)

Order the body for cache reuse: **stable shared content first, volatile
reference last.** Identity, hard NEVER/MUST rules, and the core workflow go
ABOVE a `---` separator; long examples, tables, and per-task reference go BELOW
it. Constraints in roughly the first 20% of the body; separator near the 30–40%
mark when the file has a long tail. Never strand stable rules *after* a large
volatile block — every edit there re-caches everything after it. Basis: measured
~1.47× per-file saving with this split; the ~10× figure only materializes with
system-prompt-level prefix sharing. (Vault-grounded via `main-vault-query`
pointer → `wiki/concepts/skill-layout-kv-cache.md`.)

## Workflow

### 1. Capture intent
What should the skill enable? When should it trigger (real operator phrases)?
Expected output? Mine the current conversation first — a skill often crystallizes
from a workflow the operator just walked through.

### 2. Overlap check (pi-native)
Skim directly — pi's roster is small (15 agents + 8 skills; cheap to read in
context). Does a pi **agent** already cover this? Does an existing **skill**?
Peaceful overlap is fine if the skill adds workflow value a persona doesn't — but
document *why*. The skill-vs-agent judgment needs conversation context a dispatched
agent wouldn't have, so make it yourself. `dispatch` `researcher` ONLY for
external-context overlap questions (e.g., "is there a known pattern for X in the
wider ecosystem?").

Verify the new description doesn't cannibalize an existing skill's triggers — if
it does, adjust the `Do NOT use for:` boundaries on **both** skills so traffic
routes to the right one.

### 3. Draft the SKILL.md
Two-field frontmatter first — invest most of the effort in the **description**
(trigger accuracy is the whole game). Then a lean body. Write it, then re-read as
a stranger: would you know when to fire it?

### 4. Validate against the convention
- [ ] Exactly `name` + `description` in frontmatter (plus `disable-model-invocation: true` for manual-only)
- [ ] `name` equals the directory name
- [ ] Description has Triggers + Do-NOT-use-for + is pushy
- [ ] Real file (not a symlink) at `~/.pi/agent/skills/<name>/SKILL.md`
- [ ] pi-safe (no bd/opencode-API/sisyphus deps)
- [ ] Trigger/execution tested separately (routing fail → description; execution fail → body)
- [ ] Sanity-checked on the weakest model that will run it (strong models forgive vague skills)
- [ ] Body lean, imperative, explains the why; matches the existing skills' voice
- [ ] KV-cache layout: identity + constraints above any long examples/reference
      tail; `---` separator present when a volatile tail exists

### 5. Iterate — qualitatively, with the operator
Present the draft; the operator reviews. Refine the description against real
trigger phrases the operator would actually type. **No eval harness, no benchmark
viewer, no quantitative loop** — that machinery is opencode's and is deliberately
not ported. pi trusts operator judgment + real use to validate a skill. If it
undertriggers in practice, make the description pushier and add near-miss triggers.

**Trigger sanity-check:** after writing, try 2–3 real operator phrases in a fresh
session — confirm the skill fires on the should-trigger cases AND does NOT fire on
the Do-NOT cases. This is the cheap, manual replacement for a quantitative eval loop.

### Retiring a skill
Deleting a skill = `rm -rf` its directory (it's a real file, no symlink cleanup).
Then re-check the **remaining** skills' `Do NOT use for:` boundaries — they may
have been routing traffic to the deleted one, and those boundaries may now be stale.

## Description tuning (the one thing worth sweating)

The description decides whether the skill ever fires. To combat undertriggering:
- Name the job **and** the contexts that imply it, even when the user doesn't say
  the skill's name.
- List concrete trigger phrases (casual + formal).
- Add `Do NOT use for:` with the nearest adjacent domains, so it doesn't fire on
  lookalikes that belong elsewhere.
- **Never summarize the how in the description.** A step-by-step summary makes
  agents follow the summary and skip loading the body. The description answers
  "should I open this skill?" — what + when, never how.
- Explain *why* over rigid ALWAYS/NEVER caps.

## Installing third-party skills

Skills can execute arbitrary code — treat them as untrusted code, not docs. Read
every file; audit `scripts/` for network calls, out-of-scope file access, and
exec; check references for injected instructions; verify the name isn't
typosquatting a popular skill; pin to a specific commit, never `latest`.

## What this deliberately is NOT

- **No eval/benchmark machinery** — no `evals.json`, no 5-case minimum, no grading,
  no variance analysis, no HTML viewer. (opencode's; not ported.)
- **No description-optimization loop** (`run_loop.py`, train/test split) — pi tunes
  by operator judgment against real phrases.
- **No scaffold/validate scripts, no `.skill` packaging** — pi skills are plain markdown.
- **No "improvement requires variance data" rule** — qualitative review is the
  standard of evidence here.
