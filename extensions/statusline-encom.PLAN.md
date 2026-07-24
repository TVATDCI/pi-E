# Implementation Plan — Strategy C: Hybrid Selective Port

**Created:** 2026-07-16
**Decision:** Port *footer-relevant* subsystems from `pi-powerline-footer` v0.7.0
(`~/developer/yt-dlp/about-pi/pi-powerline-footer`) into the current single-file
`statusline-encom.ts`. **Keep** the `setFooter` canonical surface, the `encom.json`
theme, and the lean hand-built ethos. **Exclude** the fixed-editor cluster,
bash-mode, editor stash, working-vibes, and welcome overlay (different surface,
not what this footer is for). Treat the reference as a *code library to mine*,
not a package to install.

**Why not A (install wholesale):** reference renders into the fixed-editor cluster
(`setEditorComponent` + `setWidget`), not `setFooter`; takes over the whole editor
viewport; ships an oh-my-pi dark palette that fights `encom.json`; ~3000-line
`index.ts`; version-pinned 0.74–0.81. Its default look (thin + fg-only) is already
*less* than what V3–V6 built.

---

## Target files
- `~/.pi/agent/extensions/statusline-encom.ts` — primary (all phases).
- `~/.pi/agent/themes/encom.json` — only if new theme tokens are needed (Phase 2/3).
- `~/.pi/agent/settings.json` — read/write config block (Phase 3).

## Verified capabilities (load-bearing, checked against Pi 0.80.3 dist)
- `setFooter((tui, theme, footerData) => …)` — canonical, stable.
- `footerData: ReadonlyFooterDataProvider = Pick<getGitBranch | getExtensionStatuses
  | getAvailableProviderCount | onBranchChange>` → **customItems feasible**.
- `ctx.getContextUsage()`, `ctx.model`, `ctx.cwd`, `pi.getThinkingLevel()`,
  `ctx.sessionManager.getSessionId()`, `ctx.settingsManager.getCompactionSettings().enabled`.

---

## Foundation design — unified segment model (Phase 1 output)

Today there are **two parallel render paths** (thin = themed strings joined by sep;
solid = `SolidCell[]` via `buildSolidCells`). They duplicate dir/branch/ctx/tokens/
model/tps/cost/clock logic. Unify on one neutral value both renderers consume:

```ts
type SegmentValue = {
  text: string;            // content (icon-prefixed where relevant)
  thinFg: ThemeColor;      // theme token for the thin path
  solidBg?: string;        // hex for solid block (default = encom surface)
  solidFg?: string;        // hex for solid block (default = encom text)
};
type SegmentDef = {
  id: string;
  render(s: SegmentCtx): SegmentValue | null;   // null = hide
};
type SegmentCtx = {                  // pure data bag — no globals
  ctx: ExtensionContext; footerData: ReadonlyFooterDataProvider;
  theme: Theme; icon: IconSet; pi: ExtensionAPI;
  rt: RuntimeStats;                 // cost, tps, gitDirty, cacheRead/Write, sessionStart
};
```
- Thin renderer: `theme.fg(v.thinFg, v.text)`.
- Solid renderer: `{ bg: v.solidBg ?? SURFACE, fg: v.solidFg ?? TEXT, content: v.text }`.
- Registry: `const SEGMENTS: Record<string, SegmentDef>`. Layout = ordered id list.
- Segments become pure/testable; the `SOLID` map folds into each segment's `solidBg/solidFg`.

---

## Phases (each independently shippable + reversible)

### Phase 1 — Segment registry + unified render (pure refactor, ZERO visual change)
- Introduce `SegmentValue` / `SegmentDef` / `SegmentCtx` / `SEGMENTS`.
- Migrate all 8 current segments (dir, git, ctx, tokens, model·thinking, tps, cost, clock) into the registry.
- Collapse the two render paths into one; remove the dir/branch/ctx/tokens/model/tps/cost duplication.
- Default layout = current order → look identical to V6.
- **Verify:** `/encom-style thin` + `solid` render byte-identical to today; `/encom-nerd on|off|auto` unchanged; `node --check` passes.
- **Files:** `statusline-encom.ts` only.
- **Risk:** solid palette currently hard-coded in `SOLID` map — fold into per-segment `solidBg/solidFg` carefully (test both styles).

### Phase 2 — High-value missing segments
- Add to registry: `session`, `cache_read`, `cache_write`, `time_spent`, `subagents`.
- Data sources:
  - `session` ← `ctx.sessionManager.getSessionId()` (short hash).
  - `cache_read`/`cache_write` ← accumulate token counts from `message_end` usage. **Micro-verify:** current cost code reads `usage.cost.{cacheRead,cacheWrite}` as *dollars*; confirm whether top-level `usage.cacheRead/cacheWrite` are *token counts* (reference has these segments, so they exist somewhere).
  - `time_spent` ← `Date.now() - sessionStartMs` (captured at `session_start`).
  - `subagents` ← **verify data source** (session tree depth via `sessionManager.getBranch()` or a counter). Riskiest; may defer.
- Default layout: add `session` + `cache_read` (cheap, high-signal); rest available via `full` preset (Phase 3) only.
- **Files:** `statusline-encom.ts`; `encom.json` only if new tokens needed (prefer reusing `muted`/`text`/`dim`/`accent`).
- **Verify:** new segments render sensible values; hidden gracefully when data absent.

### Phase 3 — Config + presets + customItems plugin surface
- Read `~/.pi/agent/settings.json` block **`encomStatusline`** (+ project `.pi/settings.json` override).
  ```json
  "encomStatusline": {
    "preset": "default",                 // default | minimal | full
    "layout": { "left": ["dir","git",…] },   // optional order override
    "disabledSegments": ["cost"],
    "separator": "powerline-thin",
    "customItems": [{ "id": "ci", "statusKey": "ci-status", "prefix": "CI", "color": "warning" }]
  }
  ```
- Presets: `default` (current 8 + Phase 2 additions), `minimal` (dir/git/ctx), `full` (everything incl. new segments).
- `customItems`: render `footerData.getExtensionStatuses()` keys as segments (**VERIFIED available**). Other extensions can now add footer items via `ctx.ui.setStatus(key, val)` with zero edits to this file.
- Commands: `/encom-preset <name>`, `/encom` (show current config). Persist preset choice.
- **Files:** `statusline-encom.ts`; writes `settings.json`.
- **Verify:** preset switch changes layout live; a test `setStatus("demo","hi")` appears via customItems; persisted across reload.

### Phase 4 — Separator switch + render scheduler + streaming context
- Port `separators.ts` 10-style switch → `/encom-sep <powerline|powerline-thin|slash|pipe|dot|chevron|star|block|none|ascii>`. Map sensibly to thin/solid (`powerline` ≈ current solid blocks; `powerline-thin` ≈ current thin; rest = thin variants). Keep `/encom-style` as an alias or retire it.
- Replace 1s `setInterval` clock with a **debounced render scheduler** (port `render-scheduler.ts`, ~24 lines) + layout TTL cache. Clock still ticks, just coalesced.
- **Live-streaming context refresh:** on `message_update`, schedule a context re-render (today only `firstTokenMs` is captured) so %/tokens move during generation.
- **Auto-compact awareness:** read `getCompactionSettings().enabled` → show indicator; optionally suppress stale post-summary context.
- **Files:** `statusline-encom.ts`.
- **Verify:** separator styles render correctly in nerd + plain; clock smooth under scheduler; context ticks during a long generation; compaction indicator appears.

### Phase 5 — Tests
- `statusline-encom.test.ts` next to the file; run via `node --experimental-strip-types --test`.
- Cover pure functions only: `parseGitPorcelain`, `fitLines`, separator-style → glyph mapping, segment registry ordering, config/preset parsing, customItems resolution.
- **Decision:** where/how tests run — `~/.pi/agent/extensions/` isn't a package; run standalone against extracted pure helpers (no pi runtime needed).
- **Verify:** `node --test` green.

---

## Execution order & dependencies
```
Phase 1 (registry) ──► Phase 2 (segments) ──► Phase 3 (config/customItems)
        │                                          │
        └──► Phase 4 (separators + scheduler) ◄─────┘  (separators need unified render)
                        │
Phase 5 (tests) ◄───────┴─── can start after Phase 1; grows each phase
```
Linear recommendation: **1 → 2 → 3 → 4 → 5**. Stop after any phase = working footer.

## Open decisions to confirm before/during implementation
- **D1** Settings key: `encomStatusline` (proposed) vs `statusline` vs `powerline`-compatible.
- **D2** Which new segments enter `default` (propose `session` + `cache_read`; rest in `full`).
- **D3** New theme tokens in `encom.json` (propose reuse existing; add only if a segment needs a distinct hue).
- **D4** Single-file vs split into `statusline-encom/` dir (propose stay single-file until >~800 lines).
- **D5** Test runner/location (propose `node --experimental-strip-types --test` on a sibling `.test.ts`).

## Out of scope (confirmed excluded)
fixed-editor cluster · bash-mode · editor stash · working-vibes · welcome overlay ·
subscription-cost detection · chat-navigation shortcuts · drag-drop · mouse capture.
(These belong to a different surface; not a footer concern.)
