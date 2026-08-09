# Pi Handoff — finished MODEL-DELTA ride; caught statusline mis-grounding (2026-08-09)

**Written at:** 2026-08-09T19:33:42Z
**Pi session:** 019fe7de-552f-78eb-82a1-5a824542092a
**Original intent:** "Finish the unfinished MODEL-DELTA items ride" (operator-set session purpose).

## Summary
Re-grounded each MODEL-DELTA "cheap close" before executing. The headline mode-2 finding (statusline-encom.ts claimed `.disabled`) was a **mis-grounding** — the file is LIVE (878 lines, active `encomStatusline` config); close #1 (forget the 7-fact cluster) was INVERTED and dropped, which would otherwise have deleted accurate liveness records. Executed close #2 (amended `pi_agent_install_conventions`: "14"→"15", dropped the stale "researcher missing from `all`" sentence — verified single record). Operator pasted the close #5 re-grounding correction block into MODEL-DELTA.md; closes #3 (liveness checker) retired, #4 (`ps` one-liner) handed to operator.

## Files touched
- `~/.pi/MODEL-DELTA.md` — appended "⚠️ Re-grounding" correction block (operator pasted; untracked — `~/.pi` is not a git repo).
- `~/.pi/agent/memory/store.jsonl` — amended `pi_agent_install_conventions` (`memory_forget` + `memory_remember`; verified 1 record, "0 of 15", no "MISSING").
- `~/.pi/agent/exports/pi-handoff.md` — this file (overwrites the 2026-08-09 handoff).

## Decisions made
- **MODEL-DELTA close #1 INVERTED (dropped).** statusline-encom.ts is the live, load-bearing footer; its 7 store facts are accurate. The 2026-08-09 `.disabled` assertion was a model mis-grounding (operator-confirmed: the model then was wrong, not a transient disable).
- **Close #3 (#3b liveness checker) RETIRED.** Built on the mis-grounding; the only real `.disabled` files (footer-status, hello-status) are dead early-build scaffolding the operator is removing → nothing left to scan.
- **Close #5 REVISED to a correction append** (not "leave as-is") because MODEL-DELTA's own headline went stale.
- (meta) The resolve→forget discipline (Test 1 lever #3) is the only structural rule that survived; re-grounding-before-acting is the liveness link the self-model lacks, re-proven on MODEL-DELTA itself.

## Dead ends
- **Executing MODEL-DELTA close #1 would have deleted 7 accurate facts.** The 2026-08-09 MODEL-DELTA asserted statusline-encom.ts was `.disabled` and proposed forgetting its cluster. Re-grounding (`ls extensions/` + read the 878-line file + `settings.json` `encomStatusline` block) showed it LIVE. Forgetting would have destroyed correct liveness records. Lesson: re-ground before acting on ANY model, including one authored by the same persona one pass ago — the model is a diary, not a view.
- **I misread my own toolset this session.** Concluded I was read-only (only read/grep/find/ls/write/edit) from the "Available tools:" prose, when `memory_remember`/`memory_forget`/`bash`/`task`/`dispatch` were available all along. This sent the operator on a zsh dead-end (they tried to run `memory_forget(...)` in zsh → `zsh: unknown file attribute: k`). Corrected mid-session. Lesson: the function-schema block is authoritative; the "Available tools" prose line is a subset, not the contract.
- **"Amend" = `memory_forget` THEN `memory_remember`** (`memory_remember` appends, does not upsert). Confirmed working: exactly 1 record after the amend.

## Incomplete work
- (operator) `rm -f ~/.pi/agent/extensions/hello-status.ts.disabled ~/.pi/agent/extensions/footer-status.ts.disabled` — command handed; not yet confirmed run.
- (operator) `ps -eo pid,lstart,etime,cmd | grep -i pi-coding-agent | grep -v grep` — O5-1 runtime certainty; low-stakes (single pi writer this session, so no cross-process race regardless of whether the running process predates W8b).
- (sisyphus) **`bd forget next:store_jsonl_cross_process_followup`** — the stale store.jsonl race claim is live in sisyphus's bd (`bridge/global-export.jsonl:75`, export 2026-08-05). Quarantined from pi (category `next` excluded by `bd-bridge` `BRIDGED_CATEGORIES`) but active in sisyphus's todo. Needs a sisyphus-side forget.

## Proposed bd facts
None new this session — the work was model-internal corrections + a pi store.jsonl fact amendment (already in pi's store). The prior session's proposed `pi_opencode_symbiotic_system` (decision) promotion status is unknown to pi; if sisyphus did not promote it, it still stands as a worthwhile cross-agent framing correction (see `~/.pi/MODEL.md`).

## Next steps for opencode
- **Forget** `next:store_jsonl_cross_process_followup` in bd (the store.jsonl race is FIXED — commit `fbc3433`, append-only + `withFileLock`; the entry is stale).
- (optional) Confirm whether the prior session's `pi_opencode_symbiotic_system` decision was promoted; promote if not.
- (optional, cross-pair) O4-1: neither side has a foundation-consuming planner; the prerequisite is a foundation-artifact contract (`MODEL.md` shape+home) before building a planner agent. Unchanged from prior handoff.
