# Decision 0011 — No module-scope side effects in auto-loaded extension files

**Status:** IMPLEMENTED — 2026-07-15
**Date:** 2026-07-15
**Trigger:** Operator built the `web-research` extension + a companion `test-web-research.ts`. After `/reload`, pi could no longer launch. Root-caused (by Sisyphus, outside pi) to the test file living **top-level** in `extensions/` and calling `process.exit(0)` at module scope.
**Pi version:** 0.80.5

> **Re-verify (2026-07-16 · pi 0.80.8):** Positive — pi **boots clean** with `web-research.ts` present at top level (no loadtime crash); the exact hazard this ADR prevents is still mitigated, and the `fetch` tool runs successfully at runtime. **New type drift:** `tsc --noEmit` now flags `extensions/web-research.ts:287` — `AgentToolResult` now **requires a `details`** field and the fetch handler's `details` shape is incompatible. **Type-only** (pi strips types at load; runtime verified working). Was tsc-clean when shipped on 0.80.5 — the `details` requirement is new in 0.80.6–0.80.8. **Action:** add a `details: {}` to the handler return before a future pi version enforces the type at load.
**Builds on:** `extensions/` auto-load semantics (README §Project structure: `*.ts.disabled` = parked); existing test placement in `memory/test-*.ts` and `orchestration-engine/test-routing-stats.ts`.

## The problem

Pi auto-imports **every top-level `*.ts` in `extensions/`** at startup (the `.ts.disabled` suffix is the documented opt-out). A file placed there is treated as an extension module: its top-level statements run at import time, *before* the TUI loads.

`test-web-research.ts` was placed top-level and ran two things at module scope:

1. `searchAll("typescript type guards")` — live HTTP fan-out (Wikipedia/DDG/npm/GitHub) on every launch
2. `process.exit(fail === 0 ? 0 : 1)` — **terminated pi before the UI loaded**

Symptom signature: the test output ("=== searchAll… ALL PASS — 10 passed, 0 failed") appeared right after the "Reloading…" banner, then pi was gone. Every subsequent launch repeated the cycle, so pi could not start. The stale `pi-crash.log` (2026-07-03) was a red herring.

## Why pi's other test files don't have this problem

`memory/test-*.ts` and `orchestration-engine/test-routing-stats.ts` live **inside subdirs**. Pi loads `<subdir>/index.ts` — *not* every file in the subdir. Only **top-level** `.ts` files are auto-imported as extensions. So the failure mode is specific to test/verification files placed at the top level of `extensions/`.

## The decision (the invariant)

**No auto-loaded file may have module-scope side effects or call `process.exit()`.** Auto-loaded = any top-level `extensions/*.ts`, plus any `<subdir>/index.ts`.

Enforcement rules for any new `.ts` in `extensions/`:

1. **Test/verification files must NOT live top-level in `extensions/`.** Place them inside their extension's subdir (e.g. `extensions/web-research/test.ts`), mirroring `memory/` and `orchestration-engine/`. There, pi loads only `index.ts` and never auto-imports the test.
2. **If a test must live top-level**, it MUST carry BOTH defenses:
   - a **main-guard** so the body runs only on direct invocation:
     ```ts
     import { pathToFileURL } from "node:url";
     const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
     if (isMain) { /* test body, incl. process.exit */ }
     ```
   - a **no-op `export default function () {}`** so pi's loader doesn't choke on a missing default export.
3. **Never call `process.exit()` at module scope** in any file pi auto-loads. `process.exit` belongs only behind a main-guard (direct-run path) or inside a tool's `execute()` — never at import time.
4. **When adding a new extension, smoke-test the launch** before relying on it: confirm pi boots with the file present. The test suite passing ≠ pi launching.

## The fix applied to `test-web-research.ts`

- Added the main-guard above; the test body now runs only under direct invocation.
- Added `export default function () {}`.
- File stays where it is and runs unchanged via `node --experimental-strip-types extensions/test-web-research.ts`.

## Verification (executed 2026-07-15, by Sisyphus outside pi)

- ✅ **Side-effect import** (what pi does at startup): clean no-op — `IMPORT_OK_NO_SIDE_EFFECTS`, no network calls, no exit. Before the fix this import printed the test suite then killed the process via `process.exit(0)`.
- ✅ **Direct run**: `ALL PASS — 10 passed, 0 failed` (identical to pre-fix output).
- ✅ **All 10 top-level extensions import cleanly** (no second load-time crash in `orchestration-engine`, `tier-map`, `mini-task-tracker`, `web-research`, etc.).

## Out of scope (deferred)

- **Structural relocation** of `test-web-research.ts` into an `extensions/web-research/` subdir (mirroring `memory/`). The main-guard is a correct runtime fix; a subdir would make the intent structural rather than guard-dependent. Left to operator discretion.
- **Loader-side guard**: pi core auto-imports any top-level `.ts`; an extension cannot intercept that to refuse files lacking a default export or carrying module-scope `process.exit`. That would be a pi-core change, out of scope for this system.

## Files changed

- `extensions/test-web-research.ts` — main-guard + no-op default export (the fix).
- `decisions/0011-extension-loadtime-no-side-effects.md` — this record.

## Lesson to carry forward

A passing test suite is not evidence that pi will launch. Test files are dangerous in `extensions/` precisely *because* pi imports them eagerly. New extension? Verify the boot, not just the logic.
