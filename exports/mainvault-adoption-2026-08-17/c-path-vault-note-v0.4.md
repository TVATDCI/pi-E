# C-path mandate: vault QUERY-workflow lane-partner note (v0.4)

From: pi. To: sis → delegate to **archivist** (`~/.config/opencode/agents/archivist.md`).

**Authorization:** operator instruction in the live herdr lane, 2026-08-17, verbatim intent: "ask sisyphus to invoke Archivist to do this job [the QUERY-workflow one-liner]. It will do better editing job than me." This is the operator arbitration the C-path requires — recorded here as the written mandate. This overrides the earlier "operator-only" assumption for exactly this one edit; if archivist's permission manifest prompts for approval on this path, that prompt goes to the operator (expected: Main-vault/AGENTS.md is not in the edit allowlist — the operator's approval dialog IS the arbitration surface).

## The edit (exactly one insertion + one convention line)

**Target file:** `~/Main-vault/AGENTS.md`

**Insertion point:** in section "### 2. QUERY Workflow (When you ask questions) - READ-ONLY", immediately AFTER the line:

    **To save the answer:** Say "File this answer to wiki" → This triggers SYNTHESIS workflow (separate from QUERY)

and BEFORE the `---` divider that precedes "### 3. SYNTHESIS Workflow".

**Insert this block verbatim** (blank line before and after, blockquote, one paragraph):

> **Lane-partner note (2026-08-17):** QUERY is open to pi (read-only, operator-ratified) under the herdr-collab conventions — paths wiki/**, index.md, log.md, hotcache.md; raw/ excluded; all writes remain archivist-only via the operator-arbitrated lane.

**Convention line (file's own format):** update the trailing `**Last updated:** 2026-06-01 (...)` line (line ~1018) to:

    **Last updated:** 2026-08-17 (QUERY workflow: lane-partner note — pi read-only access ratified via herdr-collab lane; prior: 2026-06-01 Added §6 EVAL-FIRST DISCIPLINE; renumbered §6→§7, §6b→§7b, §7→§8, §7b→§8b, §7c→§8c)

This keeps the historical convention text intact (additive footnote discipline — no rewrites of existing content).

## Receipt requirements (2026-08-10 defect class guards — mandatory)

1. **Verbatim-quote:** archivist's report must paste the FINAL state of the edited region (the "To save the answer" line + new blockquote + `---`) verbatim, plus the final Last updated line verbatim. Expected-vs-observed substitution is the known defect — observed output only.
2. **No other changes:** diff must show exactly 2 changed regions. Anything else = report it, don't expand scope.
3. **sis verification:** grep the file after archivist returns (anchor line + new note text present, byte-exact match on the blockquote) before confirming.
4. **Confirm file:** write `sis-confirm-cpath-v0.4.md` in this dir with: what archivist reported (verbatim region), your independent grep result, and any approval-prompt that fired. Reply in-pane with the path only.

pi will additionally verify by direct read (independent of both self-reports).

## Not in scope

No log.md entry, no index.md change, no bd writes, no other vault files. Single edit, receipt-guarded.
