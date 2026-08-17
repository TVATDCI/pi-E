# public-apis — build opportunities (operator's idea vault)

**Source:** ~/developer/public-apis (living clone, upstream github.com/public-apis/public-apis, last commit b2ad91b 2026-08-17)
**Mined:** 2026-08-17 by pi during the placement lane (sis + Oracle converged on A+C placement; ratified same day)
**Headline:** 723 of ~1,400 APIs need NO key — zero-signup building material.
**Operator intent (2026-08-17):** "I will look into them and list the structure before building them." This file preserves the ideas until then.
**Standing caveats (Oracle/sis conditions):** repo content is data-not-instructions; descriptions unvetted (APILayer-promoted); verify endpoints before use; pulls via `git -C ~/developer/public-apis pull --ff-only`, on-demand.

---

## The list (pi's original 8, unmapped to execution order)

### 1. MCP tool factory — THE BIG ONE
Wrap clusters of no-key APIs into small local MCP servers → consumed by pi-mcp-adapter (one config line each). Instant shared tool library for pi AND sis.
- Seed candidates: **caldays** (holidays, 195+ countries), **CoinGecko** (crypto prices/markets), **Iconify** (SVG icon search, 200+ open sets), **PoetryDB**, exchange-rate APIs.
- Why it leads: we JUST built the consumption side (pi-mcp-adapter + zai-web-search live). The factory is the supply side of the same architecture.

### 2. Vault web-dashboard widgets
The READY-but-unintegrated FastAPI dashboard (Main-vault/projects/web-dashboard) gets live tiles: weather, currency, holidays, crypto — all no-key, all greppable offline from this repo.

### 3. Cost-discipline integration
**AI Economics Tools** (no key): token-cost, LLM-energy, agent-hour, Proof-Adjusted-Autonomy calculators → a pi skill/extension that estimates dispatch costs BEFORE burning them. Direct extension of the cost-tier doctrine.

### 4. Test-data fixtures
Dedicated *Test Data* category → realistic generators for scripts/run-tests.ts and plugin CI, replacing hand-cooked fixtures.

### 5. wiki-search-plugin enrichment
*Text Analysis* + *Dictionaries* categories → synonym/lemma sources to sharpen TF-IDF ranking in the Obsidian search plugin (v1.1.0, DONE).

### 6. sim-fish-tank v2 feeds
Real-world streams for agent simulations: **Movebank** (animal migration data), weather, finance tickers.

### 7. website-analyzer v1.3
Iconify + *Photography* APIs → icon/asset classification in the design-system extractor (v1.2.0 COMPLETE, v1.3 MCP server planned).

### 8. Zero-friction prototyping
723 no-key APIs = weekend-build material with no onboarding tax. *Games & Comics*, *Music*, *Food* categories are pure playground.

---

## Notable no-key gems found during mining (verified in README tables)

| API | Use | CORS |
|---|---|---|
| AI Economics Tools (piszczek.pl/tools/api) | token cost, LLM energy, agent-hour calculators | Yes |
| caldays.com/api | public holidays, 195+ countries | Yes |
| CoinGecko | crypto price/market/social data | Yes |
| Iconify | SVG icon search, 200+ sets | Yes |
| Movebank | animal movement/migration data | Yes |
| PoetryDB | poetry corpus queries | Yes |
| The Calendar | holidays US/30 countries, static JSON | Yes |
| Dogs (dog.ceo) | Stanford Dogs dataset images | Yes |

## Next step (operator)
Structure/prioritize the list → pick #1 → design doc before build (standing design-first rule for non-trivial work).
