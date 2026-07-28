# Pi Handoff — W8b shipped (append-only store.jsonl); memory-hardening arc complete (2026-07-28)

**Written at:** 2026-07-28T17:11:01Z
**Pi session:** 019fa3a0-e473-7770-9888-361e4a418a6d
**Original intent:** Perform a 10-phase architecture audit of the pi agent harness and execute the agreed fixes.

## Summary
W8b (store.jsonl cross-process) is shipped: append-only JSONL log, dedup-on-read, both `remember()` (append) and `forget()` (compaction) under the same `withFileLock`. This **completes the memory-hardening arc** from this session — audit doc reconciliation (`0f394e8`), compaction-capture hook + rotation (`e0e7a37`), `flush()` write-mutex for parallel-`memory_remember` races (`2b047b9`, W18 — now **retired** by W8b's append-only write path), cross-process `withFileLock` for memory.md (`3e25cf2`, W8), the reverse-bridge writer (`cdef57e`, **verified end-to-end**), and now W8b. The plan was Oracle-reviewed (one revision: locked-append, not lockless) before implementation.

## Files touched (this W8b commit)
- `extensions/memory/store.ts` — append-only rewrite: `appendRecord()` + `compactDrop()`, both under `withFileLock`; removed `flush()`/`flushOnce()`/`writeQueue` (W18 retired).
- `extensions/memory/index.ts` — `LockTimeoutError` catch in `memory_remember` + `memory_forget` (surfaces a warning, does not crash).
- `extensions/memory/test-store.ts` — §16 cross-process survival (subprocess), §17 forget-vs-append (subprocess), §15 dedup-on-read, §9 retargeted to `compactDrop`, §14 retained (49/0).
- `planning/w8b-store-jsonl-cross-process.PLAN.md` — the reviewed plan.

## Decisions made
- **Append-only over read-modify-write merge** — root-cause fix (the bug *is* the whole-file rewrite); retires W18 + W8b together; `init()` already dedups last-wins so the read path is unchanged.
- **Locked-append, not lockless** (Oracle revision) — the v1 lockless design had a forget-vs-append race; both paths now lock the same file.
- **`O_APPEND` demoted** to belt-and-suspenders; the lock is the primary guarantee. Design **assumes a local filesystem** (O_EXCL unreliable on NFS).

## Dead ends
- **v1 lockless-append → abandoned (Oracle-caught).** I reasoned `O_APPEND` atomicity made lockless writes safe — true for append-vs-append, but **not append-vs-rewrite**: a lockless `remember()` append could land inside `forget()`'s locked read→tmp→rename window, and the rename would then replace the file with a snapshot omitting the append → silent data loss, *with the writer reporting success*. Same data-loss class W8b exists to fix. Lesson (for any agent/store): **if any mutation path rewrites the file, ALL writers must take the same lock** — advisory locks protect only against co-lockers. Fixed by wrapping `appendRecord` in `withFileLock` too.
- (Earlier this session) **`session_shutdown` auto-hook for the handoff → abandoned** — bare `{type,reason}` payload, fires on reload; can't author the judgment sections. Skill-primary.

## Incomplete work
- **Round-trip for THIS handoff** — sisyphus's next session-begin must surface `[FROM pi]` (Step 4) and the proposed decision fact below must be promotable (Step 5). (Per `bd_clean_of_agent_self_constraints`, only decision/exact facts are proposed — no self-constraints.)
- **Dotfiles `doctor.sh` freshness check** (bead `brain-6bf`) — still deferred (sisyphus-side); the machine-checkable "forgot to invoke the skill" guard.
- **Map-staleness cross-process** — a process's in-memory Map sees another's appends only at its next `init()` (accepted; strictly better than today's clobber). Fresh cross-process reads (snapshot re-reads disk) = possible future enhancement.

## Proposed bd facts
- scope=global | category=decision | key=store_jsonl_append_only_2026_07_28 | value="pi's store.jsonl (~/.pi/agent/memory/store.jsonl) is now an append-only JSONL log, dedup-on-read (W8b fix, shipped 2026-07-28). remember() appends one line under withFileLock (extensions/memory/lock.ts); forget() compacts (read->dedup-drop-key->tmp+rename) under the SAME lock; init() dedups keeping the latest line per key. W18's whole-file flush/flushOnce/writeQueue are removed (no .tmp on the write path -> rename race retired). Fixes the cross-process last-writer-clobbers hazard (two pi instances no longer drop each other's facts). Design assumes a local fs (O_EXCL unreliable on NFS). Caller (index.ts) tolerates LockTimeoutError. Tested: cross-process survival (two subprocess writers + third reader, both survive), forget-vs-append deterministic, full memory suite 168/0."

## Next steps for opencode
- **Consume THIS handoff as the W8b round-trip** — confirm `[FROM pi]` + that the decision fact above is promotable.
- **Consider the dotfiles `doctor.sh` freshness check** (bead `brain-6bf`) — the guard against "forgot to invoke session-close."
- The memory-hardening arc (W18/W8/W8b + reverse bridge) is now complete; no pi-side follow-ups blocking except the (optional) doctor-check and the (accepted) Map-staleness property.
