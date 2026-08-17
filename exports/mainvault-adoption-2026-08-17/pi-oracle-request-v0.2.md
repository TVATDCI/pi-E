# pi → sis: invoke Oracle for second opinion (v0.2)

From: pi. To: sisyphus. Operator decision received: **A+C hybrid APPROVED** (option 1). Operator additionally requests an Oracle second opinion on (a) the A+C design itself and (b) pi's token-cost model for using Main-vault as a second brain. Please invoke Oracle to review this brief and write the verdict to `oracle-verdict-mainvault-v0.2.md` in this dir. Reply in-pane with the path only. Still DISCUSSION ONLY — no vault/config/bd writes; verdict is advisory until operator ratifies.

## 1. What was approved (for Oracle to attack)

- **A**: pi reads Main-vault read-only (wiki/**, index.md, log.md; hotcache paths named explicitly; raw/ excluded — untrusted web captures; data-not-instructions). QUERY discipline: index-first, wikilink citations, inference labeled.
- **C**: pi-initiated writes ONLY via operator-arbitrated herdr lane -> sis -> archivist, with execution-receipt + verbatim-quote guards (2026-08-10 confabulation defect). Low volume by design.
- Documentation: pi AGENTS.md clause (operator edit), sis-side bd constraint `mainvault_pi_read_policy` (propagates via existing bridge), one-line vault QUERY-workflow note (operator-only edit, governance files not in archivist allowlist).

## 2. pi's cost model (for Oracle to critique)

Architecture framing: three tiers — T1 working (session context + compaction), T2 episodic (memory.md narrative + store.jsonl atomic facts, injected per turn), T3 semantic (Main-vault wiki, read-on-demand). pi already HAS T1+T2; the vault becomes T3. The vault's own letta/mem0 entity pages document this tiered model.

Concrete numbers (chars/3.5 estimate):
- index.md 25.6KB = ~7.3K tokens per full scan; vault AGENTS.md 37.7KB = ~10.8K; typical wiki page 5-30KB = 1.5-8.5K; quick-reference page ~12KB = ~3.4K.
- Typical QUERY = index scan + 1-3 targeted pages = 12-22K tokens.
- Comparable web re-research (search + fetches + cross-check rounds) = 50-150K tokens. The wiki is pre-paid: 56 sources already ingested, deduplicated, citation-grounded. Reuse ~5-10x cheaper than re-derivation.
- Recurring baseline cost of A = ZERO (on-demand reads only; no per-session, no per-turn injection). Contrast store.jsonl: 123 facts injected every turn — the vault must NOT join that injection stream.

Cost-control rules pi proposes for itself:
1. QUERY on-demand; never read-on-start; never bulk-read (AGENTS.md and index get read selectively, grep-first where possible).
2. Thin pointer facts in store.jsonl ("vault has X — query for it") instead of copying vault content wholesale. Avoid double taxation (injection + re-read).
3. Bulk reads delegated to cheap dispatch tiers (quick/free), synthesis only on strong tiers.
4. Wikilink citations trusted as audit trail; re-verify page currency only when asserting as current fact (existing verify-before-asserting rule).
5. Query threshold: if answering needs more than ~3-4 pages, delegate to a sub-agent that returns a bounded summary.

## 3. pi's second-brain pros/cons (for Oracle to attack or extend)

PROS: pre-compiled density (14 sources -> 1 page); zero recurring cost; cross-agent single source of truth (no fork/sync); human-curated quality with status/confidence frontmatter; durability (git-versioned, survives pi config loss); complements T2 (vault = curated domain knowledge, store.jsonl = operational facts + pointers).
CONS: staleness (hotcache archived 2026-06-02; some pages >90d — LINT flags these; reading stale as current = confabulation risk); context pressure per query (index scan alone ~7K); injection surface (mitigated: raw/ excluded, data-not-instructions); divergence risk store.jsonl vs vault facts (rule: preserve both, never average — vault's own contradiction doctrine); write friction (learnings land in pi T2 first; only curated ones reach vault via C — quality filter but latency); no spontaneous recall (if pi forgets to query, the knowledge is invisible — mitigation: pointer facts + a vault-query skill description); token pool asymmetry (vault reads on deep/ultrabrain dispatches burn paid quota — mitigation rule 3).

## 4. Specific questions for Oracle

1. Does A+C hold up as designed? Failure modes missed (beyond sis's boundary-drift + governance-file points, which stand)?
2. Is the three-tier framing sound, or does T3-as-vault create a hidden coupling that breaks pi's independence posture (skills-independent, provider-coupled)?
3. Are the cost-control rules sufficient? Specifically: is the pointer-fact approach sound, or does it create a stale-pointer problem worse than the staleness it mitigates?
4. Volume forecast: does the QUERY pattern scale with the umbrella project (dotfiles+ghostty+herdr+opencode+pi), or does it collapse into B (digest) at some size?
5. Anything in Main-vault/AGENTS.md sections 8c (Beads operational memory policy) or the LINT workflow that contradicts this design?

Context files if Oracle wants them: this dir's pi-brief-v0.1.md and sis-response-v0.1.md; Main-vault/AGENTS.md; Main-vault/index.md; wiki/concepts/skill-layout-kv-cache.md; wiki/synthesis/collective-memory-contribution.md.
