---
name: skill-auditor
description: |
  Audits a set of skills — pi's own or another platform's — and produces a
  structured classification map covering gaps, overlaps, pi-safety, and health.
  Builds ground truth by reading every SKILL.md's frontmatter DIRECTLY, never
  trusting a delegated summary. Use when you need to know what pi has vs lacks vs
  should skip, whether any skills collide on triggers, or whether any are
  malformed or pi-unsafe. Triggers: "audit skills", "skill gap", "what skills does
  pi need", "skill overlap", "are any skills pi-unsafe", "skill health check",
  "don't duplicate skills", "gap map". Do NOT use for: creating or editing a
  single skill (use skill-creator), auditing non-skill files, or one-off codebase
  recon (use keymaker / morpheus directly).
---

# Skill Auditor (pi-native)

Systematically read a set of skills, apply criteria, and produce a structured
map. The output is a *classification* — HAS / SKIP / LACKS, or overlaps, or
pi-safety flags, or health defects — never an edit. Read-only by design.

> **pi workflow note.** This skill NEVER edits the audited skills — it reads and
> reports. Recommendations only; the operator decides what to build or cull.
> Ground truth is non-negotiable: read frontmatter yourself so you can verify any
> delegated finding against it.

## The core method (ground truth first)

1. **Inventory directly.** List the skill dirs; extract `name` + `description`
   frontmatter from every `SKILL.md` *yourself*. Do not hand the whole audit to a
   sub-agent and trust its summary — you need the raw frontmatter as the baseline
   you verify against. (A frontmatter sweep of ~45 skills is one cheap pass.)
2. **Group by domain** — planning pipeline, vault ops, research, review, dev
   domains, utility. Clustering makes the buckets obvious.
3. **Classify per the audit question** (see modes below).
4. **Delegate deep-reads ONLY for the borderline bucket.** Frontmatter settles
   ~80%; spend a `keymaker`/`morpheus` dispatch only on the skills whose body
   genuinely changes the call. Parent synthesizes.
5. **Output the map** — structured buckets + findings + (for gap audits) the
   reusable pattern the audit revealed.

## Audit modes

### Gap audit (cross-platform)
"What does pi HAVE vs LACK vs SKIP relative to platform X's skills?"
- **HAS** — pi already covers it. Note whether via an *agent* or a *skill*: pi is
  agent-first, so equivalents often live in `agents/`, not `skills/`.
- **SKIP** — the other platform's exclusive. Tag *why*: macro methodology /
  bd-or-vault dep / platform-internal / niche. The dependency tag IS the
  justification — an untagged SKIP is an unjustified one.
- **LACKS** — build candidate. Priority-rank: independence-critical (can't grow
  without it) > genuine-tool-gap (a tool, not a workflow) > optional (an agent
  already covers it; build only if a concrete need bites).

### Overlap audit (within pi)
"Do any of pi's skills cannibalize each other's triggers?"
- For each pair whose descriptions share trigger phrases, flag the collision and
  recommend `Do NOT use for:` boundary adjustments on **both** — so traffic routes
  to the right skill. (Connects to skill-creator's cannibalize-check.)

### pi-safety audit
"Which skills have forbidden dependencies?"
- Flag any skill whose body references `bd`, opencode-API/MCP, `.sisyphus`, or
  Main-vault. pi-safe skills use only pi primitives (`dispatch`, the 14 agents,
  tier-map). Output: safe / unsafe per skill + the offending reference.
  Exception: `main-vault-query`'s ratified read-only access (AGENTS.md Main-vault clause, 2026-08-17) and point-back references to it are pi-safe; flag any OTHER skill touching Main-vault.

### Health audit
"Are all skills well-formed?"
- Per skill: exactly `name`+`description` frontmatter · `name` == dirname · real
  file (not symlink) · description has `Triggers:` + `Do NOT use for:` · body lean
  · KV-cache layout: hard constraints/identity above any long examples-reference
  tail (no stable-after-volatile stranding; `---` separator when a volatile tail
  exists — see skill-creator's Layout section).
- This is the check that catches a regression — a re-introduced symlink, a
  mismatched name — before it breaks loading.

## Workflow

1. **Scope** — which directory (pi's `skills/`, another platform's, or both for a
   gap audit)? Which mode? State both before reading anything.
2. **Inventory directly** — frontmatter sweep (ground truth).
3. **Group by domain.**
4. **Classify** per the mode's criteria.
5. **Deep-read the borderline only** — `dispatch` `keymaker` (recon) or `morpheus`
   (deep trace) for the few whose body decides the call.
6. **Output the map** + findings. For a gap audit, also surface the reusable audit
   pattern — it may itself be a skill worth extracting (meta-recursion).
7. **Trigger sanity-check (if the audit ships a skill).** When a gap/overlap audit
   leads to a new or edited skill, try 2–3 real operator phrases in a fresh
   session — confirm it fires on should-trigger cases and does NOT fire on the
   Do-NOT cases. (Inherited from skill-creator step 5.)

## Discipline

- **Ground truth first** — read frontmatter yourself; verify delegated findings.
- **Read-only** — never edit audited skills; recommendations only.
- **Tag the dependency** on every SKIP — untagged = unjustified.
- **Cost discipline** — frontmatter settles most; reserve dispatches for the
  borderline. Category sets the model (tier-map is sole authority): recon =
  `quick`, deep trace = `deep`.
- **Don't smooth disagreements** — if two skills genuinely overlap with no clean
  boundary, say so and let the operator decide.

## What this deliberately is NOT

- **Not a first-class automated tool — yet.** It is *orchestration* (inventory →
  classify → report) by the parent + cheap dispatches. If the pattern proves
  mechanical, promote the inventory/classify steps to an extension later.
- **Not for single-skill authoring** — that's skill-creator. This audits *sets*.
- **Not an editor** — read-only; it never mutates the skills it inspects.
