---
name: pi-web-search
description: |
  How pi accesses the web — the zai GLM Coding Plan MCP servers (Web Search /
  Web Reader / Zread — dedicated monthly quota ~1,000 calls/month on Pro, shared
  across the three, included in the plan) plus the pi-web-access package and the
  keyless built-in search. Use whenever a task
  needs current info (blogs, news, forums, prices), docs, or content from a
  specific URL. Triggers: "web search", "search the web", "look this up",
  "fetch this URL", "deep research", "extensive web research". Do NOT use for:
  questions answerable from the local repo/files (read them directly), or for
  opencode-side depth research (Context7, blocked sites, multi-source synthesis
  — route through the herdr-collab lane to sis).
---

# Pi Web Access — routing (zai plan MCP first for general web)

## Decision tree (which tool for which need)

1. **General free-text web** (blogs, news, forums, prices, current events) →
   zai **Web Search MCP** (`web-search-prime` server, tool
   `web-search-prime_web_search_prime`, param `search_query`). Included in the
   GLM Coding Plan on its dedicated monthly quota (~1,000 calls/month, shared
   with Web Reader + Zread) — no provider keys. This is the PRIMARY general-web
   path; it consumes plan quota that is otherwise wasted (operator design
   intent, 2026-09-07).
2. **Reading a specific URL fully** (docs pages, articles) → zai **Web Reader
   MCP** (`web-reader`, tool `webReader`) — same shared monthly quota. Fallback:
   `fetch_content`.
3. **Understanding a GitHub repo** (docs, structure, issues, file contents) →
   zai **Zread MCP** (`zread`, tools `search_doc` / `get_repo_structure` /
   `read_file`) — same shared monthly quota. For full local exploration, prefer
   `fetch_content` (GitHub URLs are cloned locally).
4. **Images/screenshots/videos** → zai **Vision MCP** (`zai-vision`, stdio —
   `ui_to_artifact`, `diagnose_error_screenshot`, `understand_technical_diagram`,
   `analyze_data_visualization`, `video_analysis`, …) — billed at GLM-5.3-Flash
   rates. Point it at LOCAL file paths (best practice per docs).
5. **Keyless quick lookups** (Wikipedia/DDG-instant/npm/GitHub) → the built-in
   `search` tool (zero cost, zero config) — fine for package/concept checks.
6. **Multi-provider synthesized research** → `web_search` (pi-web-access
   package; Exa keyless tier 3 QPS/150 calls-day). CRITICAL: always pass
   `workflow: "none"` — skips the interactive curator popup. Batch ≥2 varied
   queries in one call; single-query answers are where confabulation lives.
   Use when the zai search result is thin or a second source is needed.

MCP config lives at `~/.config/mcp/mcp.json` (all four servers, key from
auth.json, never committed). Discover via `mcp({ server: ... })` or the
mcpScript skill; servers only start on first use.

## Effort tiers (count queries BEFORE answering)

- "web search" → 1 zai MCP call (or ≥2 `web_search` queries), varied keywords,
  then synthesize.
- "extensive web research" → ≥4 queries, different angles.
- "deep research" → ≥8 queries across 2–3 successive batches (refine angles
  between batches).

## Citation rule (lane contract, sis-ratified 2026-08-17)

Every load-bearing claim carries **provider + URL**. This lets a lane peer (or
the operator) spot-verify instead of re-searching. Separate **confirmed facts /
inference / unresolved** when sources conflict — never force fake consensus.

## Division of labor across the stack

pi = breadth (lookups, news/blogs/forums, release notes, GitHub reads) — zai
plan MCP carries this now. opencode/sis = depth (library docs via Context7,
cross-repo code search, blocked/anti-bot sites, multi-source synthesis). Web
reads have no side effects; the shared resources are plan credits and quota —
zai credits are consumed ONLY by pi (sis uses its own tools).

## MCP meter watch (V2 dedicated pool — operator discipline, no automation)

On Legacy V2 the MCP quota is a DEDICATED monthly pool (dashboard meter,
resets monthly — 2026-10-07 as of 2026-09-08); size unknown (3 calls ≈ 1%).
The z.ai dashboard is login-only — no local API to poll, so the watch is a
human glance, not a script. Rule for pi sessions:

- After a heavy-research session (≥10 MCP calls), remind the operator to
  glance at the MCP meter.
- If the meter passes ~50% before month-end: read the absolute number once,
  then downshift — route general-web searches to `web_search` (Exa keyless)
  FIRST until reset; keep zai MCP for Web Reader / Zread (URL-specific reads
  have no keyless equivalent of equal quality).
- At V2→credits conversion (quarterly cycle end): MCP billing becomes
  1.2-credits-per-call from the shared pool — revisit this rule entirely then.
