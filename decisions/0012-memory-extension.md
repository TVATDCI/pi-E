# Decision 0012 — Structured memory extension (two-substrate model)

**Status:** IMPLEMENTED (retroactively recorded 2026-07-16; extension shipped 2026-07-13)
**Date recorded:** 2026-07-16 · **Extension built:** 2026-07-13
**Trigger:** The memory extension (`extensions/memory/`) shipped without an ADR. Recorded here so its design decisions survive doc drift.
**Pi version:** 0.80.5

> **Re-verify (2026-07-16 · pi 0.80.8):** Positive — memory extension **loads + `memory_remember` executes** at runtime on 0.80.8 (wrote a probe fact, read it back, truncation/budget logic ran). **New type drift:** `tsc --noEmit` now flags `extensions/memory/index.ts:85` — `AgentToolResult` now **requires a `details`** field, which the `memory_remember` handler omits. **Type-only** (runtime verified working). Was tsc-clean when shipped on 0.80.5 — the `details` requirement is new in 0.80.6–0.80.8. **Action:** add `details: {}` (or a structured payload) to the handler return.
**Builds on:** ADR 0001 (Layer-4 substrate = sisyphus-opaque; file-contract memory preferred over session-resume). This extension is the *structured* half of that file-contract model.

## The decision

**Two durable memory substrates, different roles, both file-based + auditable:**

1. **`~/.pi/agent/memory.md`** — freeform narrative handoff + compaction-preserve (the substrate since ADR 0001). Human-readable; the "story."
2. **`~/.pi/agent/memory/store.jsonl`** — structured facts via the `memory_remember` tool (`extensions/memory/`). Classified, ranked, auto-injected each turn as a `<memory-context>` block. The "database." Owns `audit.log`.

**NOT beads + SQLite** (OpenCode/sisyphus's choice). The divergence is deliberate: file-based = auditable, crash-safe, no version-lock, grep-able. SQLite is a v1.1 scale option, not a v1 requirement.

## Design (the load-bearing decisions)

### Dedup + update-in-place
- Map key = `${scope}:${category}:${key}` (same shape as OpenCode beads, for cross-system ergonomics).
- In-memory `Map<string, MemoryRecord>` hydrated at `init()`; every mutation updates the Map THEN flushes (write-through). Same key → update-in-place (no append-only duplicates). Flush is atomic: write `${path}.tmp` then `fs.rename` (crash leaves complete-old or complete-new, never a hybrid).

### Hard delete only — NO soft-delete
- `forget()` does a hard `Map.delete` + flush. **No soft-delete sentinel.** Rationale: pi's store has **no auto-import** from an external source (unlike beads, which auto-imports from `issues.jsonl` and can clobber dolt-db updates, silently restoring "deleted" values). With no auto-import there is no clobber risk, so a sentinel is unnecessary complexity. Deleted records cease to exist → cannot pollute the recency-ranked top-K injection.

### Write-boundary defenses (enforced in `store.remember()`, NOT trusted to the agent)
- **E1 — secret scan** (`scanner.ts`): concrete patterns (AWS/GitHub/OpenAI keys, private-key blocks, `api_key=`/`password=`/`token=` assignments) + Shannon-entropy on 20+ char runs (threshold 4.5 — above hex-hash ~4.0, below random base62 ~6.0; UUIDs allowlisted). On hit: throw `SecretDetectedError` (refuse + surface). Backstop, not license — secrets must be redacted before storing.
- **B2 — provenance write-guard** (asymmetric): an `inferred` record CANNOT overwrite an `operator` record. Operator facts are immutable to agent inference.
- **E2.1 — inferred-constraint downgrade**: an `inferred` record classified `constraint` is downgraded to `fact` (defense-in-depth — the agent cannot elevate its own inference to a hard constraint).

### Category auto-classification (`classifier.ts`)
System-side, deterministic keyword ruleset, first-match precedence (constraint > decision > convention > preference; `fact` is the default fallback). The agent supplies key+value+provenance; the system derives category. First-match is security-relevant (E2.1 fires only on `constraint`, so a multi-keyword payload must classify deterministically).

### Injection pipeline (`injection.ts`, pure)
`ranker → budgeter → formatter`, no Pi deps → fully unit-testable. Ranked by category → provenance → recency; trimmed to a token budget; emitted as the `<memory-context>` block appended to the system prompt every `before_agent_start` (per-turn re-read so mid-session writes surface next turn).

## Scope (v1)
- `scope = "global"` only (no per-bead scoping yet).
- `turn` field is vestigial (ranking uses `recordedAt` epoch-ms for cross-session recency).
- `schemaVersion: 1` stamped for forward-compat.

## Roadmap (not v1)
- **v1.1:** SQLite backing when JSONL scale demands it; per-scope (bead-scoped) records.
- **Phase 2 (AGENTS.md L35):** a `session_before_compact` hook auto-extracts the 5 loss categories into the store. Not yet built.

## Verification
- Unit tests across `memory/test-*.ts` + smoke — all green (147 assertions; enumerated in the README extensions table).
- Defenses E1/B2/E2.1 verified via `test-store.ts` / `test-scanner.ts`.
- Live: the store holds the system's durable facts; `<memory-context>` injects each turn (visible in this session's system prompt).

## What this is NOT
- NOT a replacement for `memory.md` (narrative handoff stays).
- NOT OpenCode's hotcache/handoff/turn-counter machinery (rejected per `AGENTS.md` — pi's native compactor emits a structured near-superset).
- NOT session-resume memory (ADR 0001 chose file-contract over session-resume).
