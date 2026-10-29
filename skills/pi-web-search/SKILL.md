---
name: pi-web-search
description: |
  How pi accesses the web — the zai GLM Coding Plan MCP servers (Web Search /
  Web Reader / Zread — dedicated monthly quota 4000 calls/month on the Max
  plan, shared across the three, verified 2026-10-29 via /zai:quotas; Vision
  tools billed at GLM-5.3-Flash rates) plus the pi-web-access package and the
  keyless built-in search. Use whenever a task needs current info (blogs,
  news, forums, prices), docs, or content from a specific URL. Triggers:
  "web search", "search the web", "look this up", "fetch this URL",
  "deep research", "extensive web research". Do NOT use for: questions
  answerable from the local repo/files (read them directly), or for
  opencode-side depth research (Context7, blocked sites, multi-source
  synthesis — route through the herdr-collab lane to sis).
---

# Pi Web Access — routing (zai plan MCP first for general web)

> Mechanics re-anchored to pi 1.x NATIVE MCP (2026-10-29, live-proven):
> servers live in `~/.pi/agent/mcp.json`, connect at session start, and their
> tools are named `mcp__<server>__<tool>` with every non `[A-Za-z0-9_]`
> character in the server name replaced by `_` (so `web-search-prime` →
> `web_search_prime`). Proven end-to-end same day: search + reader both
> returned real results through the plan quota.

## Decision tree (which tool for which need)

1. **General free-text web** (blogs, news, forums, prices, current events) →
   zai **Web Search MCP**: tool `mcp__web_search_prime__web_search_prime`,
   param `search_query`. Included in the GLM Coding Plan on its dedicated
   monthly quota (**4000/month on Max, verified 2026-10-29; shared with Web
   Reader + Zread**) — no provider keys. This is the PRIMARY general-web
   path; it consumes plan quota that is otherwise wasted (operator design
   intent, 2026-09-07).
2. **Reading a specific URL fully** (docs pages, articles) → zai **Web Reader
   MCP**: tool `mcp__web_reader__webReader`, param `url` — same shared
   monthly quota. Fallback: `fetch_content`.
3. **Understanding a GitHub repo** (docs, structure, issues, file contents) →
   zai **Zread MCP**: tools `mcp__zread__search_doc`,
   `mcp__zread__get_repo_structure`, `mcp__zread__read_file` — same shared
   monthly quota. For full local exploration, prefer `fetch_content` (GitHub
   URLs are cloned locally).
4. **Images/screenshots/videos** → zai **Vision MCP** (stdio server
   `zai-vision`): tools `mcp__zai_vision__ui_to_artifact`,
   `mcp__zai_vision__diagnose_error_screenshot`,
   `mcp__zai_vision__understand_technical_diagram`,
   `mcp__zai_vision__analyze_data_visualization`,
   `mcp__zai_vision__analyze_video`, … — billed at GLM-5.3-Flash rates (NOT
   the 4000 web pool). Point it at LOCAL file paths (best practice per docs).
5. **Keyless quick lookups** (Wikipedia/DDG-instant/npm/GitHub) → the built-in
   `search` tool (zero cost, zero config) — fine for package/concept checks.
6. **Multi-provider synthesized research** → `web_search` (pi-web-access
   package; Exa keyless tier 3 QPS/150 calls-day). CRITICAL: always pass
   `workflow: "none"` — skips the interactive curator popup. Batch ≥2 varied
   queries in one call; single-query answers are where confabulation lives.
   Use when the zai search result is thin or a second source is needed.

## Invocation mechanics (pi 1.x native, live-proven 2026-10-29)

MCP config lives at `~/.pi/agent/mcp.json` (user-level; the four zai servers
are configured there). pi connects every enabled server at session start —
no adapter, no extension, no "first use" startup. Inspect with `/mcp` in a
session or `pi mcp list` in a shell (prints state, tools, errors).

Call the tools from a **codemode script** (they are codemode-exposed):

```js
// @options: {"timeout_ms": 90000}
const r = await tools["mcp__web_search_prime__web_search_prime"]({
  search_query: "your query"
});
// Result shape: JSON content array; the payload is content[0].text, itself a
// JSON string of [{title, link, content, refer}, ...] — parse it:
const hits = JSON.parse(JSON.parse(JSON.stringify(r)).content[0].text);
```

Reader is the same shape: `tools["mcp__web_reader__webReader"]({ url: "…" })`.
Dash-to-underscore is the one naming trap (see header note).

## Effort tiers (count queries BEFORE answering)

- "web search" → 1 zai MCP call (or ≥2 `web_search` queries), varied keywords,
  then synthesize.
- "extensive web research" → ≥4 queries, different angles.
- "deep research" → ≥8 queries across 2–3 successive batches (refine angles
  between batches).

**Quota-awareness habit (operator-ruled 2026-10-29):** before a deep-research
batch, glance at the Web/month line via `/zai:quotas` (the operator command —
ask or remind if you cannot read it) so the batch is sized against what is
actually left.

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

## MCP meter watch (dedicated 4000/month pool — operator discipline, no automation)

The MCP web quota is a DEDICATED monthly pool, **4000 calls/month on the Max
plan** (verified 2026-10-29 via `/zai:quotas`: "Web / month: 4000/4000 left",
resets monthly). `/zai:quotas` is the glance — readable in any pi session
(quota-axi is the CLI equivalent surface). Rule for pi sessions:

- After a heavy-research session (≥10 MCP calls), remind the operator to
  glance at `/zai:quotas`.
- If the meter passes ~50% before month-end (≈2000 of 4000), downshift —
  route general-web searches to `web_search` (Exa keyless) FIRST until
  reset; keep zai MCP for Web Reader / Zread (URL-specific reads have no
  keyless equivalent of equal quality).
- If the plan tier ever changes, re-verify the pool size from `/zai:quotas`
  and update this section in the same breath.
