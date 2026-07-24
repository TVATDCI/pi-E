# Decision 0013 — Tool handlers must return `details` (AgentToolResult contract change, 0.80.6–0.80.8)

**Status:** IMPLEMENTED — 2026-07-16
**Date:** 2026-07-16
**Trigger:** pi 0.80.5 → 0.80.8 update re-verify. `tsc --noEmit` broke: the `AgentToolResult<T>` type now **requires** a `details: T` field on every tool-handler return (previously optional).
**Pi version:** 0.80.8
**Builds on:** ADR 0011 (web-research loadtime), ADR 0012 (memory extension) — both 2026-07-16 re-verify notes flagged this exact drift.

## The problem

pi 0.80.6–0.80.8 changed the `AgentToolResult<T>` contract: the `details` field moved from optional to **required**. Two custom tool handlers stopped type-checking:

- `extensions/memory/index.ts:85` — `memory_remember`: three returns, none carried `details`.
- `extensions/web-research.ts:287` — `fetch`: three returns carrying a *union* of `{error}` and `{url,bytes}` shapes that TypeScript could not unify into a single `TDetails`.

**Runtime was unaffected** — pi loads `.ts` by stripping types without enforcing them, so both tools executed correctly on 0.80.8 (verified before the fix). The break was type-only, but latent: a future pi version that type-checks extensions at load would refuse to load them.

## The decision

**Every custom tool handler must return a `details` field, and all return branches within one handler must share a single `details` type.**

Fix applied 2026-07-16:

- **`memory_remember`** — added `details: {}` to all three returns (single empty-object shape; `TDetails` inferred as `{}`). No metadata to expose, so an empty object is sufficient and keeps the three branches type-identical.
- **`fetch`** — replaced the per-branch `details` literals with one shared, typed object:

  ```ts
  const details: { url?: string; bytes?: number; error?: string } = {};
  ```

  mutated across branches, so every return references the same `AgentToolResult<T>`. No new imports; no change to the `content` the LLM sees (runtime behavior preserved).

## Why a shared typed object (not per-branch literals or a return-type annotation)

Per-branch object literals each infer their own shape; differing keys produce a union that `AgentToolResult<T>` then fails to pin to one `T` (the `error: string` vs `error: undefined` clash that broke `fetch`). A single typed `details` variable gives all branches one declared type, collapsing the union cleanly. It needs no import of `AgentToolResult` and no explicit return annotation — minimal surface, maximal robustness.

## Verification (2026-07-16, pi 0.80.8)

- `tsc --noEmit` → **clean** (exit 0); both errors resolved.
- `memory_remember` runtime → persists to `memory/store.jsonl` (verified by direct read of the new record, not self-report).
- `fetch` runtime → returns extracted text (example.com) on 0.80.8.

## Convention (forward-looking)

When adding a `registerTool` handler:

- If the tool has no structured metadata, return `details: {}`.
- If it has multiple branches, build **one** typed `details` object mutated across branches rather than per-branch literals — this avoids the union-inference trap entirely.
- The built-in `search` tool in `web-research.ts` (single consistent `details: { source }`) is the reference shape for the simple case.
