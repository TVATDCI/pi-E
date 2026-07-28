# PLAN — W8b: store.jsonl cross-process (append-only redesign) — REVISED

**Status:** REVISED after Oracle review (2026-07-28). Awaiting operator re-go. **Do not implement until approved.**
**Greenlit:** operator 2026-07-28. Acceptance: two concurrent **processes** → both new facts survive in store.jsonl; test green.
**Prior art:** W8 `withFileLock` (`3e25cf2`, `extensions/memory/lock.ts`); W18 `flush()` mutex + 25-parallel test (`2b047b9`).
**Constitution:** bd read-only on pi's side. Proposed bd facts in the handoff = decision/exact only (no self-constraints, `bd_clean_of_agent_self_constraints`).

## What the review caught (BLOCKER — fixed in this revision)
The v1 plan made `appendRecord` **lockless**, relying on `O_APPEND` atomicity. That protects **append-vs-append**, but NOT **append-vs-rewrite**: `forget()`'s compaction does a locked read→tmp→rename, and a lockless `remember()` append can land *inside* that window — the rename then replaces the file with a snapshot that omits the append. Trace:
1. `A.forget(k)` → `compactDrop` acquires lock, reads file (has `k`, not `w`).
2. `B.remember(w)` → `appendFile` (lockless). `w` lands. B returns success.
3. A writes tmp (snapshot from step 1: no `k`, no `w`) → rename. **`w` is gone; B's success was a lie.**

Same data-loss class W8b exists to fix. The v1 risk claim "forget() rewrite race — Mitigated" was wrong; test #4 would have been flaky.

## Chosen approach: append-only + LOCKED writes (both append and compaction under `withFileLock`)
`remember()` appends one JSONL line **under `withFileLock(filePath)`**; `forget()` compacts **under the same lock**. Appends and compaction now mutually serialize → the append-in-forget's-window race cannot occur. Append-only content model untouched; `init()` unchanged (still dedups last-wins).

**Why locked-append over tombstone-forget (the alternative):**
- **Minimal delta, pure schema.** Every line stays a valid `MemoryRecord`; no tombstone record type, no `schemaVersion` bump, no `_deleted` flag. `init()` / `isValidRecord` / `snapshot` / `recall` unchanged. Tombstones would touch the core data model of a correctness-critical component.
- **No new growth vector.** Tombstones accumulate forever (one line per forget) until manual compaction — a slow but real unbounded-growth path. Locked-append's only "growth" is normal appends (bounded by write volume, negligible for years).
- **Consistent mental model.** All mutations go through `withFileLock` (the proven W8 lock); nothing is lockless, nothing to reason about separately.
- **Costs are acceptable.** Per-`remember` lock acquire/release ≈ 2 syscalls, µs-scale, uncontended in practice → negligible for this store's volume (dozens of writes/session). New `LockTimeoutError` failure mode on `remember()` (10s default) — practically never fires uncontended; callers tolerate it (see Risks). Cheaper than a schema change to the memory store.
- Tombstone is more elegant (fully lockless, no new failure mode) but **over-engineers for a rare-`forget` store** to avoid a negligible per-write lock cost.

## `O_APPEND` — reframed (belt-and-suspenders, no longer load-bearing)
With locked-append, the **lock** is the primary correctness guarantee. `O_APPEND` (POSIX: atomic position-at-EOF-and-write for regular files) is now **defense-in-depth** — if the lock ever failed, concurrent appends still wouldn't interleave. Kept as a second line, not relied upon. **Caveat (NFS/WSL1/non-local-fs):** `O_APPEND` atomicity is not honored across NFS clients, AND the lockfile's `O_EXCL` semantics are unreliable on NFS. **This design assumes a LOCAL filesystem** (`~/.pi/agent` is local on this machine). Under lock-on-append the NFS `O_APPEND` gap is moot; the `O_EXCL` gap is the real reason not to put the store on NFS (stated as an assumption, not a fix).

## Design — method-by-method (`extensions/memory/store.ts`)
- **`remember()`** — replace `await this.flush()` with `await this.appendRecord(finalRecord)`. Keep `this.map.set(mk, finalRecord)` (in-process `recall()` stays immediate). Defenses (E1 scan, E2.1 downgrade, B2 guard) unchanged.
- **`forget()`** — replace `await this.flush()` with `await this.compactDrop(mk)`.
- **NEW `appendRecord(rec)`** — `await withFileLock(this.filePath, async () => { mkdir -p; appendFile(JSON.stringify(rec) + "\n") })`.
- **NEW `compactDrop(dropKey)`** — `await withFileLock(this.filePath, async () => { read file → dedup keeping latest per key, skipping dropKey → write via tmp + this.rename })`. Uses the existing W8 lock + the injectable `rename` DI seam.
- **REMOVE** `flush()`, `flushOnce()`, `writeQueue` (W18 machinery — obsolete; the cross-process lock serializes within and across processes).
- **`init()` / `recall()` / `snapshot()` / `search()` / `audit()` / `rotateAuditIfNeeded()`** — unchanged.
- **Header comment** — rewrite: append-only JSONL log, dedup-on-read, all mutations under `withFileLock`; note W18 retired + W8b fixed.
- **Import** `withFileLock` from `./lock.ts`.

## Test design (`extensions/memory/test-store.ts`) — subprocess REQUIRED for acceptance
The acceptance says "two pi **processes**." In-process `Promise.all` does not exercise cross-PID lock behavior (`pidAlive`, self-steal in `lock.ts`) — which is where correctness lives post-fix. So:

1. **Cross-PROCESS survival — THE acceptance test (REQUIRED):** spawn two `node -e` writer subprocesses, each `JsonlMemoryStore` on the **same** `filePath`, each `remember()`s a distinct fact (`z`, `w`), launched concurrently (both backgrounded, then awaited). A third `node -e` reader subprocess `init()`+`snapshot()` → asserts **both** `z` and `w` present. Exercises real cross-PID lock acquire/release + stale-steal.
2. **forget-vs-append (REQUIRED, deterministic):** one subprocess `forget(k)` (compaction, locked) **concurrent** with another `remember(w)` (append, locked); third reader → asserts `w` present AND `k` gone. Deterministic (both lock → serialized; the v1 flakiness is gone).
3. **Parallel appends in one process (retarget W18 §14):** one store, 25 parallel `remember()` via `Promise.all` → all 25 in memory + persisted after reopen. Tests in-process parallel survival via the cross-process lock.
4. **Dedup last-wins:** `remember(k,v1)` then `remember(k,v2)` → fresh `init()` keeps `v2`.
5. **Backward-compat:** existing `store.jsonl` (current format) reads fine via `init()`.
6. **§9 rename-failure → MOVE to `compactDrop`:** inject a failing `rename`; `forget()`'s compaction throws; **lock released via `finally`**, **file unchanged** (pre-forget state survives). Keep the `rename` DI seam. (Was on `remember`/flush; the rename now only lives in `compactDrop`.)

## Crash semantics (MINOR — stated, not silent)
A torn append (process killed mid-`appendFile`) leaves a partial trailing line. `init()` already skips malformed lines (`store.ts:84-91`, test §10) → **one lost fact, store intact**, no cascade. No new defensive parsing needed. Stated so it's examined, not assumed.

## Known property (accepted, not a defect): per-process Map staleness
A process's in-memory `Map` sees another process's appends only at its next `init()`. Same granularity as today; strictly better than today's *clobber/loss*. Acceptance is "both survive **in store.jsonl**" — locked-append guarantees that.

## Risks (revised)
- **forget-vs-append race** — **CLOSED** (both under `withFileLock` → mutually serialize; test #2 deterministic). ✅
- **New `LockTimeoutError` on `remember()`** — 10s default; practically never fires uncontended; the memory-extension caller catches it and surfaces a warning (does not crash the agent). Documented. (Low.)
- **NFS/non-local-fs** — `O_EXCL` lockfile unreliable on NFS; design assumes local fs (`~/.pi/agent` is local). Stated as an assumption. (Low — matches deployment.)
- **Crash mid-append** — torn trailing line skipped by `init()`; one lost fact, store intact. (Low.)
- **File growth** — negligible for years; `forget()` compacts inline per key; manual `compact()` deferred. (Low.)
- **Map staleness cross-process** — accepted (above). (Accepted.)
- **Removing `writeQueue`/`flush`** — only `remember`/`forget` called `flush` (verified). (Low.)

## Acceptance mapping
- **"Two pi processes flushing concurrently → both new facts survive"** → test #1 (two subprocess writers + third reader). ✅
- **"Test proving the above, running green"** → #1 green (+ #2 forget-vs-append deterministic, + #3 parallel). ✅

## Constraints honored
- bd: untouched (read-only). ✅
- Handoff proposed bd facts: **decision/exact only** (e.g. a `store_jsonl_append_only_2026_07_28` decision fact), no self-constraints. ✅

## Out of scope
- Fresh cross-process reads (snapshot re-reads disk) — future enhancement.
- Standalone/scheduled `compact()` — deferred; volume doesn't require it.
- `bridge/`, bd, sisyphus's reader, dotfiles doctor-check.

## Deliverables after re-go
1. `extensions/memory/store.ts` (append-only + locked writes + remove W18 machinery).
2. `extensions/memory/test-store.ts` (subprocess tests #1/#2 REQUIRED; retarget §14 + §9; add #4/#5; crash-semantics note).
3. Full memory suite green (was 150/0 pre-W8b; expect +new tests).
4. Commit (`pi:` prefix) — operator runs it.
5. Handoff via `session-close` (decision/exact proposed facts only).

**Effort:** <1h — code delta is wrapping `appendRecord`'s body in `withFileLock` + the `compactDrop` path; rest is tests + this plan text.
