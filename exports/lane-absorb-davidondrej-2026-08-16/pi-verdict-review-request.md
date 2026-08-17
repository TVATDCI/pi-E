# Review request: second opinion on a skill-absorption verdict (pi → oracle via sis)

You are reviewing a **verdict**, not a diff. Nothing has been edited yet — this is
the validate stage of a validate→absorb flow. Oracle is asked because it carries
the prior absorption precedent on this stack (acceptance-gates GO-WITH-CHANGES).

## Context

- Reviewer: pi session (operator-driven), purpose this session: "validating +
  absorbing new skills".
- Source repo (local clone, third-party, public): `/home/vladi/developer/davidondrej-skills/skills`
  — David Ondrej's agent skills (48 skills, 5 categories). Registry presence is
  real but low-volume (41–172 installs per skill). Your cwd is this repo — you may
  read any skill in it directly.
- **Boundary (hard rule):** do NOT read or write anything under `~/.pi/` — pi
  internals stay off-limits to the opencode side. Everything you need about pi's
  side is summarized below as text. Exchange happens only via this shared dir.

## pi-side constraints that govern the absorption decision

1. pi skills are lean by convention: SKILL.md frontmatter = `name` + `description`
   ONLY; one self-contained file; description is the sole trigger (Triggers +
   Do-NOT-use-for boundaries). No eval harness, no scripts/ subdirs — deliberately.
2. pi is skills-independent from opencode (real files, no symlinks, no opencode API
   deps; skills must be pi-safe: no bd, no Main-vault deps).
3. Operator doctrine: anti-over-engineering, BUT code quality/robustness/scalability
   co-equal with function for absorbed machinery (~20–30% LOC premium is correct).
4. pi's extension surface: `~/.pi/agent/extensions/` (TS). **pi currently has NO
   bash command guard** (its `security/` dir holds only yaml-merge). opencode has
   sisyphus-gates; pi has nothing equivalent for bash commands.
5. Installed herdr skill on pi side = the official herdrdev one (v0.8.0-era CLI).
   pi's model routing: tier-map is sole authority; `models.json` exists for custom
   provider/model registration.

## The verdict under review

### CANDIDATES (3)

**C1. `skills/skill-authoring/effective-agent-skills/SKILL.md` (323 lines) → MERGE
~6 extracts into pi's existing `skill-creator` skill, NOT install alongside.**
Extracts: (a) "description routes, never summarize the how" rule; (b) strictness
ladder (loose heuristics ↔ pseudocode ↔ exact scripts, matched to fragility);
(c) YAML colon gotcha (`X: Y` in unquoted description breaks strict parsers incl.
pi's; fix = single-quote + doubled apostrophes); (d) Pattern A/B taxonomy
(capability vs process primitive); (e) third-party-skill security checklist;
(f) ship checklist + trigger-vs-execution test framing.
Rejected-from-merge: eval-harness advice (pi rejects that machinery), cross-client
frontmatter fields (pi = two fields only).
Reason for merge-not-install: two authoring skills = routing collision.

**C2. `hooks/` (dangerous-patterns.txt 65 lines POSIX-ERE, deny-dangerous.sh,
test-guard.sh 197-line dual-payload harness) + `skills/ops-and-setup/global-agent-guardrails/SKILL.md`
→ adopt as MATERIAL for a pi extension (`pi.on("tool_call")` → `{block:true}`,
fail-open on adapter self-error), NOT as a skill.**
Value: well-crafted catastrophic-command denylist (rm-at-root/home, dd/mkfs,
sudo rm, fork bomb, curl-pipe-sh, force-push, remote branch/tag delete, chmod 777
on /, password-manager CLI bans) + tested harness. Honest scope in the source:
"seatbelt against accidents, not a sandbox".
Adaptation needed: Linux-ify (drop /opt/homebrew PATH, /Users tree, diskutil; add
/home tree), pi-only wiring (ignore the 9-agent wiring table). Flagged as a
GO/NO-GO security decision for the operator, not pre-approved.

**C3. `skills/agent-orchestration/herdr/SKILL.md` (third-party, 58 installs) →
extract verified sharp edges into pi-side herdr notes/collab skill; keep official
herdrdev skill canonical.**
Sharp edges worth extracting (each needs a live probe before entering a pi file,
per operator's local-evidence rule): `pane read --lines N` < viewport height
returns EMPTY (request ≥200, tail locally); `pane get .cwd` frozen vs
`.foreground_cwd` live; workspace/tab label non-uniqueness (collision hazard);
server-restart husks (agent_not_found → close-and-replace); C0 control bytes eat
typed text (U+2063 invisible separator as marker); `idle` during long foreground
tool call (corroborate with pane text). Command surface checked against herdr
0.8.0 — plausible, no drift found in the checked subset.
Discarded: Cursor CLI block (not in operator stack), yolo-launch rationale
(predicated on David's guard being installed — it is not, here).

### BORDERLINE (3, deferred to operator)

- `pi-custom-model` — mechanism verified against local pi docs (models.json,
  --list-models, silent fallback on unregistered slug). Useful for scoped-models
  work; low urgency since operator built the routing.
- `decisions` (15 lines, retrospective "which choices am I unsure of") — cheap,
  orthogonal; pairs with review loops.
- `ask-then-build` — question→build-prompt loop; collides with an existing
  pi-local plan discipline (plan_before_nontrivial_implementation) — absorbing
  both = duplicate machinery.

### REJECTS (with reasons)

- `handoff` — pi's native compactor + pi's session-close skill + structured memory
  already cover it; its best principles are already pi doctrine.
- `pi-web-search` — requires pi-web-access package (NOT installed on this machine,
  verified) + DeepAPI key (absent). Dead on arrival.
- `prompt-me` — self-marked DRAFT by the author.
- `before-building` / `next-decision` — overlap ask-then-build's turf; take at
  most one of the family (and probably none, given the plan discipline).
- Everything macOS/personal-infra/DeepAPI-coupled (anti-sleep, macbook-metrics,
  nuke-cursor-app, fireflies, prod-push, read-prod-database, ...); `cyber-audit`
  (no SKILL.md, incomplete).

## The ask

Second opinion. For each verdict call (C1–C3, borderlines, rejects):
- PROS / CONS of the call as made.
- Anything MISSED (skills in the repo that should have been candidates, or
  candidate risks not surfaced).
- Verdict per candidate: GO / NO-GO / GO-WITH-CHANGES (with the change).

Constraints to respect in your judgment: pi's lean-skill convention, the
no-symlink/no-opencode-dep doctrine, anti-over-engineering, and the co-equal
quality doctrine. Keep it concise and decision-oriented.

**Write your review to:** `/tmp/herdr-collab/absorb-davidondrej/sis-oracle-review.md`
then reply in-pane with ONLY that file path.
