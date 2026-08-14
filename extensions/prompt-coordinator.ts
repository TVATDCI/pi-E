// prompt-coordinator.ts — SOLE before_agent_start registrant for system-prompt composition.
//
// WHY THIS EXISTS: five extensions previously each registered their own before_agent_start
// handler (orchestration-engine, mini-purpose-gate, session-notes, memory, bd-bridge), all using
// the chained `event.systemPrompt += block` pattern. Section order was therefore pi's readdir
// load order — nondeterministic across machines — and memory+bd injected OVERLAPPING facts under
// two labels with no dedup (live bug, verified 2026-08-09: absorption_draft_unverified_constraint,
// bd_clean_of_agent_self_constraints, pi_skills_independent_provider_coupled each injected twice).
//
// This coordinator is the single handler. It imports PURE producer pieces from each owner (pure
// ctx/disk readers — safe across pi's per-extension module isolation; the cache-dependent memory
// store is NOT imported, see memory/reader.ts), composes sections in a hardcoded order, dedups
// memory↔bd, and applies a per-injector token allocation under one shared cap. Both fact blocks
// keep their existing tags so prompt-hash.ts stableParts() needs zero regex changes.
//
// BUDGET POLICY (operator constraint 3 — "one shared cap + per-injector allocation", NOT a single
// merged rank): memory and bd each get an allocation summing to FACT_CAP. A single merged rank
// was rejected empirically — with ~32 long constraint paragraphs, unified ranking crowded out
// ENTIRE categories (all exact-values + all decisions cut), violating MUST-FIX-5 (preserve exact)
// and regressing visible variety vs the prior per-store caps. Per-injector allocation keeps each
// store's top facts within its share, so bd's decisions/exact survive alongside constraints.
//
// Failure model (MUST-FIX-4): each producer is wrapped so one failure skips only that section;
// an outer try/catch returns the base prompt if the composition shell itself throws.
//
// POST-LANDING: prompt-hash.ts KNOWN_GOOD_HASHES must be re-seeded once (imposing a defined
// order changes the stable-parts hash vs the prior readdir order). stableParts() needs NO edit
// (both fact-block tags unchanged).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

// --- Pure producer pieces (all safe to import across module isolation) ---
import { readMemoryRecords } from "./memory/reader.ts";
import { rankForInjection } from "./memory/ranker.ts";
import { applyBudget, estimateTokens } from "./memory/budget.ts";
import { formatMemoryBlock } from "./memory/formatter.ts";
import type { MemoryRecord } from "./memory/schema.ts";
import { readBridgeExport, formatBridgeLines, checkStale, type BridgeEntry } from "./bd-bridge.ts";
import { readPurpose } from "./mini-purpose-gate.ts";
import { COST_DISCIPLINE_TEXT } from "./orchestration-engine/index.ts";
import { SESSION_NOTES_TEXT } from "./session-notes.ts";

// --- Unified category priority (Oracle MUST-FIX-5) ---
// Used for bd's INTERNAL ranking (memory uses its own ranker, which is a consistent subset).
// constraint > exact (AGENTS.md #1 loss-category) > decision > reason > convention > preference.
// bd's old order had exact BELOW decision/reason; elevating it honors "preserve exact-values".
const UNIFIED_PRIORITY: Record<string, number> = {
  constraint: 0,
  exact: 1,
  decision: 2,
  reason: 3,
  convention: 4,
  preference: 5,
  fact: 6,
};

/** Shared fact cap, split per-injector. Matches today's independent caps (~3500 total) so visible
 *  content is roughly preserved; the deltas are dedup + deterministic order + exact-elevation.
 *  Behavioral sections (Cost Discipline / purpose / Session notes, ~120 tokens) are outside this. */
const FACT_CAP = 3500;
const MEM_TOKEN_BUDGET = 2000; // == memory's old DEFAULT_TOKEN_BUDGET
const BD_TOKEN_BUDGET = FACT_CAP - MEM_TOKEN_BUDGET; // 1500 (== bd's old 6000 chars / 4)

const COORDINATOR_LOG = join(os.homedir(), ".pi", "agent", "coordinator.log");

/** Normalize a key for cross-store dedup matching. Both stores use topic-based lowercase keys by
 *  convention; this collapses trivial case/separator differences. */
function dedupKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Extract the pi-side key from a bd entry's key. Two bd key schemes coexist in the export:
 *  - Forward-bridged pi facts: key = `global:<category>:<pi_key>` (60/71 today). The pi_key suffix
 *    is what matches a memory record's key — strip the `global:category:` prefix to recover it.
 *  - sisyphus-native facts: key = `<category>-<slug>` (hyphenated, no pi counterpart). Returned
 *    as-is — different fact space, correctly never matches memory. Without this extraction,
 *  forward-bridged duplicates silently inject twice (verified live 2026-08-09). */
function bridgePiKey(bdKey: string): string {
  const m = bdKey.match(/^global:[a-z]+:(.+)$/);
  return m ? m[1].trim() : bdKey.trim();
}

/** bd entry's category, parsed from its `category:value` shape. */
function bdCategory(e: BridgeEntry): string {
  return e.value.split(":")[0];
}

/** Compose the two fact blocks: dedup across stores, then per-injector rank+budget+format.
 *  Pure w.r.t. disk (no ctx/session state). Returns "" if no facts kept. Exported for smoke tests. */
export async function composeFacts(): Promise<string> {
  const memRecords = await readMemoryRecords();
  const { entries: bdEntries, exportTimestamp, telemetry: bdTel } = readBridgeExport();

  // Staleness (operator SHOULD-CONSIDER): a stale bd export defers overlapping keys to memory.
  const stale = exportTimestamp ? checkStale(exportTimestamp) : null;

  // --- Dedup overlapping keys across stores (compare on the recovered pi key) ---
  const memByKey = new Map<string, MemoryRecord[]>();
  for (const r of memRecords) {
    const nk = dedupKey(r.key);
    const arr = memByKey.get(nk) ?? [];
    arr.push(r);
    memByKey.set(nk, arr);
  }
  const bdByKey = new Map<string, BridgeEntry[]>();
  for (const e of bdEntries) {
    const nk = dedupKey(bridgePiKey(e.key));
    const arr = bdByKey.get(nk) ?? [];
    arr.push(e);
    bdByKey.set(nk, arr);
  }
  const overlapKeys = [...memByKey.keys()].filter((k) => bdByKey.has(k));
  const droppedMemKeys = new Set<string>();
  const droppedBdKeys = new Set<string>();
  for (const k of overlapKeys) {
    if (stale) droppedBdKeys.add(k); // stale -> memory wins (more recent)
    else droppedMemKeys.add(k); // default -> bd wins (operator-curated cross-tool canonical)
  }
  const memDeduped = memRecords.filter((r) => !droppedMemKeys.has(dedupKey(r.key)));
  const bdDeduped = bdEntries.filter((e) => !droppedBdKeys.has(dedupKey(bridgePiKey(e.key))));

  // --- Per-injector allocation (operator constraint 3) ---
  // memory: reuse its ranker + budgeter (constraint>decision>convention>preference>fact).
  const memBudgeted = applyBudget(rankForInjection(memDeduped), MEM_TOKEN_BUDGET);
  // bd: rank by unified map (exact elevated, MUST-FIX-5), fit BD allocation.
  const bdRanked = bdDeduped
    .slice()
    .sort((a, b) => (UNIFIED_PRIORITY[bdCategory(a)] ?? 99) - (UNIFIED_PRIORITY[bdCategory(b)] ?? 99));
  let bdUsed = 0;
  const bdKept: BridgeEntry[] = [];
  for (const e of bdRanked) {
    const t = estimateTokens(`- ${e.value}`);
    if (bdUsed + t <= BD_TOKEN_BUDGET) {
      bdKept.push(e);
      bdUsed += t;
    }
  }

  // --- Format into the two existing block tags (prompt-hash stableParts unchanged) ---
  const blocks: string[] = [];
  const memBlock = formatMemoryBlock(memBudgeted.kept); // "" for empty
  if (memBlock !== "") blocks.push(memBlock);
  if (bdKept.length > 0 && exportTimestamp) {
    const header = stale
      ? `[FROM bridge, exported ${exportTimestamp} — ⚠️ STALE: bd modified after export]`
      : `[FROM bridge, exported ${exportTimestamp}]`;
    blocks.push(`<bridge-context>\n${header}\n${formatBridgeLines(bdKept)}\n</bridge-context>`);
  }

  // --- Telemetry ---
  try {
    appendFileSync(
      COORDINATOR_LOG,
      `${new Date().toISOString()} ` +
        `mem=${memRecords.length}(kept=${memBudgeted.kept.length},cut=${memBudgeted.cut.length}) ` +
        `bd=${bdEntries.length}(parsed=${bdTel.parsed},dropped=${bdTel.dropped},secret=${bdTel.secret},kept=${bdKept.length}) ` +
        `overlaps=${overlapKeys.length}(dropped_mem=${droppedMemKeys.size},dropped_bd=${droppedBdKeys.size}) ` +
        `stale=${stale ?? "fresh"}\n`,
    );
  } catch {
    /* telemetry is non-critical */
  }

  if (blocks.length === 0) return "";
  return "\n\n" + blocks.join("\n\n");
}

/** Run a producer; on any throw, log + return "" so the section is skipped without breaking the turn. */
async function tryProduce(name: string, fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[prompt-coordinator] producer "${name}" failed (skipped): ${msg}`);
    return "";
  }
}

export default function (pi: ExtensionAPI) {
  // SOLE before_agent_start registrant. The five former injectors are now libraries exporting
  // pure producers; none registers this hook anymore.
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      let prompt = event.systemPrompt;

      // 1. Cost Discipline (behavioral framing first — LLMs weight early tokens; Oracle #1)
      prompt += "\n\n" + COST_DISCIPLINE_TEXT;

      // 2. Purpose (dynamic, session-scoped)
      const purpose = await tryProduce("purpose", async () => {
        const p = readPurpose(ctx);
        return p
          ? `\n\n<purpose>\nYour singular purpose this session: ${p}\nStay focused. If a request drifts, remind the user.\n</purpose>`
          : "";
      });
      prompt += purpose;

      // 3. Session notes (behavioral)
      prompt += "\n\n" + SESSION_NOTES_TEXT;

      // 4+5. Facts: memory + bridge, coordinated (dedup + per-injector rank/budget)
      prompt += await tryProduce("facts", () => composeFacts());

      return { systemPrompt: prompt };
    } catch (e) {
      // MUST-FIX-4 outer guard: if the composition shell itself throws, return the base prompt.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[prompt-coordinator] fatal (returning base prompt): ${msg}`);
      return { systemPrompt: event.systemPrompt };
    }
  });
}
