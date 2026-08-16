---
name: research-prompt
description: |
  Turn a vague research need into ONE self-contained research brief — a single
  tight paragraph a human researcher or a deep-research AI can act on with zero
  back-and-forth. Use when the operator says "research prompt", "write a brief
  for a researcher", "what should our researcher look into", or hands a research
  task to another agent/lane peer. Do NOT use for doing the research itself
  (that's pi-web-search or the research dispatch tiers), or for planning docs.
---

# Research Prompt

One paragraph. No headers, no bullet lists in the deliverable. The test: a
researcher who has never heard of the project needs nothing else to start.

## Rules

- **Prompt the job, not the topic** — search handles (timeframe, ranking, source
  type, decision logic), not just a subject.
- **Assume zero prior knowledge** — open with what the product/project is, why
  it exists, the current situation.
- **Lead with goal + decision** — right after the explainer, the single question
  the research must answer and the decision it informs.
- **Embed all context** — names, dates, prior facts, constraints. No guessing,
  no follow-up questions needed.
- **Number the sub-questions inline** (1, 2, 3…) — 3–6 max, one mission per
  prompt. Coverage must be checkable.
- **State constraints** — what to include, what to avoid.
- **Source hierarchy** — primary sources (docs, GitHub, papers, filings,
  changelogs) over forums/social; the latter are weak signal, never proof.
- **Contradiction handling** — separate confirmed facts / inference / unresolved
  uncertainty; flag low-confidence claims. No fake consensus.
- **Citation contract** — every load-bearing finding returns with provider +
  URL, so claims are spot-verifiable without re-searching (lane contract,
  sis-ratified 2026-08-17).

## Output format

The paragraph itself in a fenced block, ready to paste. Nothing else unless the
operator asks.
