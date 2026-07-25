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
- **A persona / always-on capability** → a pi **agent** (`~/.pi/agent/agents/*.md`). pi has 14.
- **A repeatable, multi-step workflow the operator will invoke again** → a **skill**. pi has 3.

Skills are for *procedures*; agents are for *personas*. "Behave like X" → agent.
"Do these steps when Y" → skill.

## The lean format (non-negotiable)

Mirror the 3 existing skills exactly:

1. **Frontmatter = `name` + `description` ONLY.** No `compatibility`, `triggers`,
   `mode`, `inputs`, `license`, `metadata` — those are opencode fields. pi has two.
   And `name` must equal the directory name (all 3 existing skills obey this).
2. **`description` is the sole trigger.** It must carry: what the skill does, when
   to use it, a `Triggers: "…", "…"` phrase list, and a `Do NOT use for:`
   boundary. Be **pushy** — agents undertrigger; spell out the near-miss cases
   that *should* fire it.
3. **One self-contained `SKILL.md`**, imperative, explains the *why*. H1 title →
   short intro → `##` sections → code blocks / examples. No `references/`-or-
   `scripts/` subdirs (pi's convention is one file; add a sibling only if a skill
   genuinely outgrows one, loaded on demand).
4. **pi-native primitives only.** Reference `dispatch`, the 14 agents, tier-map as
   the sole model authority — never opencode's task/skill-tool/MCP.
5. **pi-safe.** No `bd`, no opencode-API, no `.sisyphus`/Main-vault deps.

## Workflow

### 1. Capture intent
What should the skill enable? When should it trigger (real operator phrases)?
Expected output? Mine the current conversation first — a skill often crystallizes
from a workflow the operator just walked through.

### 2. Overlap check (pi-native)
Skim directly — pi's roster is small (14 agents + 3 skills; cheap to read in
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
- [ ] Exactly `name` + `description` in frontmatter
- [ ] `name` equals the directory name
- [ ] Description has Triggers + Do-NOT-use-for + is pushy
- [ ] Real file (not a symlink) at `~/.pi/agent/skills/<name>/SKILL.md`
- [ ] pi-safe (no bd/opencode-API/sisyphus deps)
- [ ] Body lean, imperative, explains the why; matches the 3 skills' voice

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
- Explain *why* over rigid ALWAYS/NEVER caps.

## What this deliberately is NOT

- **No eval/benchmark machinery** — no `evals.json`, no 5-case minimum, no grading,
  no variance analysis, no HTML viewer. (opencode's; not ported.)
- **No description-optimization loop** (`run_loop.py`, train/test split) — pi tunes
  by operator judgment against real phrases.
- **No scaffold/validate scripts, no `.skill` packaging** — pi skills are plain markdown.
- **No "improvement requires variance data" rule** — qualitative review is the
  standard of evidence here.
