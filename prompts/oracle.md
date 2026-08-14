---
description: Adversarial review — fresh observer verifies claims against files before acting
argument-hint: "<change/diff/PR/design to review>"
---
Run an adversarial review of: $@

The reviewer must be a fresh context (dispatch), not the author. Hard rules for the review:

1. **File:line or it didn't happen.** Every load-bearing claim — both the author's and the
   reviewer's own — gets verified against the actual files. No label ("greenfield",
   "unexplored", "settled", "M-vs-L") survives without a file:line check.
2. **Coverage before hooks.** Inventory what the stack already does (capabilities), not what
   surfaces are unused. Cross-reference every "new/greenfield" claim against existing modules
   before ranking.
3. **Judge the unit given.** If asked to review a survey, check the methodology AND the items.
   If asked to review a design, check the design AND its constraint resolution.
4. Output: verdict (PASS / PASS-WITH-FIXES / REVISE), each fix labeled MUST-FIX or NICE-TO-HAVE
   with exact file:line evidence, and what the author should specifically re-verify.

Both sides move on evidence. Concede what's wrong, push back only with file evidence.
