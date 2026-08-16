---
name: pi-web-search
description: |
  How pi accesses the web via the pi-web-access extension — search, code search,
  URL/PDF/YouTube/GitHub fetching. Use whenever a task needs current info beyond
  the built-in keyless search gap (blogs, news, forums, prices), docs, or content
  from a specific URL. Triggers: "web search", "search the web", "look this up",
  "fetch this URL", "deep research", "extensive web research". Do NOT use for:
  questions answerable from the local repo/files (read them directly), or for
  opencode-side depth research (library docs, blocked sites, multi-source
  synthesis — route through the herdr-collab lane to sis).
---

# Pi Web Search (pi-web-access)

Installed: `pi-web-access` (npm, extension in settings.json). Keyless start =
Exa MCP tier: **3 QPS / 150 calls/day** — fine for lookups, 429s under heavy
fan-out. If the ceiling pins, the operator adds an `EXA_API_KEY` (credit-based).

## CRITICAL: always pass `workflow: "none"`

Every `web_search` call MUST include `workflow: "none"` — it skips the
interactive curator popup (nobody is there to answer it mid-task). Single query
or batched `queries`, always.

## Tools

- `web_search({ queries: [...], workflow: "none" })` — synthesized answers with
  citations. Batch related queries in one call. **Always ≥2 varied queries** —
  one-query answers are where confabulation lives.
- `code_search` — code-context search for library/API questions (use before
  generic web_search for code).
- `fetch_content` — URL(s) → markdown. PDFs extract to `~/Downloads/`
  (text-only). GitHub URLs are **cloned locally** — explore with read/bash, not
  scraping. YouTube/video needs `GEMINI_API_KEY` + ffmpeg/yt-dlp.
- `get_search_content` — pull the full stored text when a big page came back
  truncated.

## Effort tiers (count queries BEFORE answering)

- "web search" → ≥2 queries, varied keywords, then synthesize.
- "extensive web research" → ≥4 queries, different angles.
- "deep research" → ≥8 queries across 2–3 successive batches (refine angles
  between batches).

## Citation rule (lane contract, sis-ratified 2026-08-17)

Every load-bearing claim carries **provider + URL**. This lets a lane peer (or
the operator) spot-verify instead of re-searching. Separate **confirmed facts /
inference / unresolved** when sources conflict — never force fake consensus.

## Division of labor across the stack

pi = breadth (lookups, news/blogs/forums, release notes, GitHub reads).
opencode/sis = depth (library docs via Context7, cross-repo code search,
blocked/anti-bot sites, multi-source synthesis). Paid keys live in ONE stack's
config; web reads have no side effects, so the only shared resource is quota.
