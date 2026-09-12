---
name: vault-capture
description: |
  Run the gated vault-capture loop that turns finished desk-work into Main-vault
  pages — pi drafts (never writes the vault), operator approves verbatim, sis
  gate + Oracle second opinion + one arbitration round, archivist lands in a
  single write pass, zero-trust verify, dashboard verify, then optional
  cross-desk replay through the other desk's own gates. Use whenever the
  operator wants work captured/recorded/landed/preserved in Main-vault, says
  "capture this", "vault capture", "run the loop", "land it in the vault",
  mentions the vault-capture loop or runbook, or wants a capture packaged
  for the other desk's replay. Also fires for pre-flight consultation on capture timing or
  claim scope (dual-oracle precedent). Do NOT use for: reading or querying the
  vault for knowledge (main-vault-query skill), writing the vault directly
  (pi NEVER writes the vault — that is the whole point of this loop),
  session-close handoffs (session-close skill), or commit-message drafting
  (git-commit-message skill).
---

# Vault Capture — the gated loop (desk work → Main-vault pages)

The ratified mechanism for turning finished work into durable vault pages
without any agent writing the vault directly. Proven n=2 desks × 3 captures
(gap-1, gap-3, gap-2 scoped), all receipted, all cross-desk verified. The loop
is the point: it is also the evidence for the theses it captures.

## Hard rules (never skip)

1. **pi NEVER writes the vault.** The archivist lands every byte; pi's draft is a proposal.
2. **Oracle second opinion is REQUIRED** for material vault writes; operator may pre-flight dual oracles (Kimi-3 + GLM) when claim discipline matters — their converged claim map governs the draft.
3. **Operator is arbiter at every human gate.** Draft approval is a verbatim word ("yes") after full review. Nothing lands un-witnessed.
4. **Verbatim-quote guards:** PART bodies in the draft are exact proposed content. Changes route through arbitration, never silent edits.
5. **Receipts-outside-vault:** absolute filesystem paths stay PLAIN TEXT — never `[[ ]]` (zero new broken links).
6. **Non-urgent precision:** closing cleanly beats speed. Standing-ruling mode ("go and go with the changes", pre-recorded) is sanctioned only when the changes form a closed pre-ruled set — HOLD and ask on anything new.

## The steps

0. **Evidence exists.** The work must leave durable receipts (lane dirs under `~/.pi/agent/exports/`, tags, commits). The draft cites them by md5.
1. **pi drafts v0.1** — routing notes (NOT vault content: open questions, vocabulary choices, epistemics with confidence + n-counts, anchor specs) + PARTs written as vault citizens: edits with explicit insertion anchors **verified against the live file** (state exact line numbers; pages evolve — re-verify, never trust prior numbers; grep markers with **variant-tolerant patterns** — "(superseded)" vs "(now superseded)" cost a gate-round F-1 once), one PART for any NEW page (frontmatter complete; **every `sources:` path existence-checked**; avoid falsifiable counts in permanent prose), one PART for the todos/ page (Progress entry + checked task). Never include enumerable counts that drift; cite the receipt instead.
2. **Operator review** — full read; verbatim "yes" (or revise and re-review).
3. **Lane to sis** — request file (`pi-request-v0.1.md`) in a shared dir `/tmp/herdr-collab/<topic>/` (draft copied in, md5 noted): What this is · Your job (the gated route) · Evidence files · Constraints · Lane mechanics. One herdr call per bash on sis's side; short pane replies, files for substance.
4. **Gate 1 — sis review** (GO-WITH-CHANGES expected): verifies claims against reality (file counts, tags, live routes, md5s, frontmatter house style, status-value census, dedup). Findings classified: frontmatter-class (free) / archivist-mechanics (free) / verbatim-body (arbitration).
5. **Gate 2 — Oracle second opinion + one arbitration round:** Oracle rules on the open questions, packages judgment calls as A-items (recommendation vs keep-verbatim). Checklist-scoped variant (gap-2 precedent): when claims are pre-ruled, the round is a mechanical checklist — anything claiming MORE gets STRUCK, not re-reviewed. Flip conditions (missing receipts / closure pressure / unsplit claims) → HOLD the write.
6. **Gate 3 — archivist single write pass:** all ops in ONE pass (PARTs + index entry + log entry; README stats footer in-pass — TNT precedent). Execution receipt: per-PART verbatim verdicts, exact final frontmatter, deviations (target zero; REPORTED changes never silent).
7. **Zero-trust post-write verification** (sis): byte-compare vs draft, anchor checks, out-of-spec write check (git status + mtimes — only spec files in the window; `raw/` untouched; no git ops).
8. **pi dashboard verify + lane close:** restart/refresh backend if needed (index caches — hit `/api/refresh`), confirm page renders + links + counts shifted exactly as expected; archive the lane dir to `~/.pi/agent/exports/lane-<topic>-<date>/` BEFORE removing `/tmp` (command-guard blocks `rm -rf` — rename aside with `mv`), close the pane you created.

## Cross-desk replay (the convergence move)

Send the **pre-litigated package** (draft + sis review + Oracle/arbitration + archivist receipt + final report + a request file) to the other desk's `~/lane-inbox/`. Their pi runs it through **their own gates** — their Oracle rules independently (ddd rulings travel as precedent input, not answers; divergence is the point of n=2). Expected desk-truth adaptations: lifecycle dates = receiving desk's write date (N1), fork-true stats arithmetic (their disk, their numbers — never copy), log position by their convention. After their report: **cross-desk verify** — read-only probes against their disk; a clean landing diffs to exactly the N1 date fields. ddd-verify verdict file back via lane.

## Claim discipline (when the capture demonstrates a thesis)

Scoped claims, stated aloud in the page body: demonstrated-narrow vs young vs open; shared-evidence flag when one event feeds two pages (confidence rises once); analogy-level receipts split (mechanism shown ≠ instance shown); no-external-falsifier admitted when true; confidence PINNED at the honest level; the scoping sentence (one artifact class ≠ generality) is load-bearing.

---

## Precedents and receipts (reference)

- gap-1 (2026-09-09/10, first traverse): `~/.pi/agent/exports/lane-vault-capture-gap1-2026-09-10/` — base patterns, F1–F6 finding classes, A1–A5 arbitration shape
- gap-3 (2026-09-10, n=2 + cross-desk): `exports/lane-vault-capture-gap3-2026-09-10/` + `exports/lane-gap3-replay-tnt-20260910/` — byte-identical cross-desk landing, +1/+1 vs +2/+2 stats convergence
- gap-2 (2026-09-10/11, scoped + dual pre-flight): `exports/lane-vault-capture-gap2-2026-09-10/` + `exports/lane-gap2-replay-tnt-20260911/` — checklist arbitration, standing ruling, question page stays `open`
- Distilled runbook (v0.1, the source doc this skill operationalizes): `exports/vault-capture-loop-runbook-v0.1.md`
- Loop conventions absorbed from the build lane (`exports/lane-mvd-discovery-2026-09-09/pi-handoff-build-summary.md`): lane-commit duty (single-line `git add` blocks), RESTART-NEEDED protocol, process-vintage checks
