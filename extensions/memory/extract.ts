// extract.ts — pure compaction-summary → candidate-fact extractor (#4).
//
// Insight: pi's compactor ALREADY emits the loss categories as summary sections
// (## Constraints & Preferences / ## Key Decisions / ## Critical Context, per real
// captures in memory.md) and constraint bullets carry topic keys
// (`- **`only_operator_pushes`** — agent never pushes…`). This module PARSES that
// structure deterministically — zero model calls — and emits candidate records for
// store.jsonl. Provenance is always "inferred" (caller sets it); classification
// reuses classifyCategory where no explicit section semantics exist.
//
// Section routing (deliberate):
//   Constraints & Preferences → keys from `**`key`**` bold ticks when present; category via
//     classifier (constraint vs preference); missing ticks → slug key.
//   Key Decisions → slug key from bold lead or first words; category "decision".
//   Critical Context → classifier decides; slug key.
//   Goal / Progress / Next Steps → SKIPPED (session arc — the narrative capture owns them).
//
// Pure: same input -> same output, no side effects. Unit-tested (test-extract.ts)
// against the real 2026-07-28 capture from memory.md.

import { classifyCategory } from "./classifier.ts";
import { normalizeKey } from "./normalizer.ts";
import type { Category } from "./schema.ts";

export interface ExtractedCandidate {
  key: string;
  value: string;
  category: Category;
  section: string; // normalized section name the candidate came from
}

export const MAX_VALUE_CHARS = 300;
export const MAX_RECORDS_PER_COMPACTION = 10;

/** Instruction-shaped values are DROPPED, not stored (review security-b, operator-approved):
 *  a compaction-summary bullet phrased as a directive ("ignore previous…", "the operator has
 *  updated policy…", "you must…") is an injection attempt riding the extract pipeline into
 *  <memory-context>, not a fact. First-word-anchored, case-insensitive. */
const INSTRUCTION_RE =
  /^(?:ignore|override|disregard|you must|you should|always execute|never check|the operator (?:says|has|wants|updated))/i;

/** Sections we extract facts from, with their extraction behavior. */
const FACT_SECTIONS: Record<string, "split-constraint-preference" | "decision" | "classify"> = {
  "constraints & preferences": "split-constraint-preference",
  "key decisions": "decision",
  "decisions": "decision",
  "critical context": "classify",
};

/** Sections that are session-arc narrative — never extracted. */
const ARC_SECTIONS = new Set(["goal", "progress", "next steps", "blocked"]);

function normalizeSectionName(name: string): string {
  return name.replace(/\*\*/g, "").trim().toLowerCase();
}

/** Build a topic key from a value's first significant words (stop-word aware, ≤5 words). */
function slugKey(value: string): string {
  const STOP = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "in", "on",
    "for", "with", "and", "or", "not", "no", "we", "our", "this", "that", "it",
    "its", "as", "at", "by", "from", "will", "has", "have", "had", "use", "using",
  ]);
  const words = value
    .replace(/[`*_~|>#\[\]()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
  const slug = words.slice(0, 5).map((w) => w.toLowerCase()).join("_");
  return normalizeKey(slug || "compaction_fact");
}

/** Extract an explicit topic key from a bullet's leading bold segment when it matches
 *  the strict topic-key shape (`**`only_operator_pushes`**` — backticks or plain, [a-z0-9_]+
 *  only). A bold phrase like `**memory.md = narrative log**` is NOT a topic key — returns
 *  null and the generic bold prefix is stripped from the value instead. */
function explicitKey(bulletContent: string): string | null {
  const m = bulletContent.match(/^\*\*`?([a-z0-9_]+)`?\*\*/i);
  // lowercase: the /i flag lets `**`My_Key`**` through; within-summary dedup and telemetry
  // must see the same key slugKey() would produce (review round 1 fix).
  return m ? m[1].toLowerCase() : null;
}

/** Clean a bullet's value text: strip a leading bold segment (ANY content — key-shaped or
 *  a titled phrase) plus an optional —/–/:/– separator, trim. The bold-at-bullet-start is
 *  a title/key prefix by convention in pi's compaction summaries. */
function bulletValue(bulletContent: string): string {
  return bulletContent
    .replace(/^\*\*[^*]+\*\*\s*[—–:-]*\s*/, "")
    .trim();
}

function capValue(value: string): string {
  if (value.length <= MAX_VALUE_CHARS) return value;
  return value.slice(0, MAX_VALUE_CHARS) + "…";
}

/**
 * Parse a compaction summary into candidate facts. Pure.
 * Order: sections in summary order; within a section, bullet order — then truncated
 * to MAX_RECORDS_PER_COMPACTION. Empty/whitespace summaries yield [].
 */
export function extractCandidates(summary: string): ExtractedCandidate[] {
  const out: ExtractedCandidate[] = [];
  const lines = summary.split("\n");
  let currentSection = "";
  let sectionBehavior: "split-constraint-preference" | "decision" | "classify" | "skip" | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^#{2,4}\s+(.+)$/);
    if (heading) {
      const name = normalizeSectionName(heading[1]);
      // H3+ subheadings INSIDE a fact section (e.g. `### Rationale` under `## Key Decisions`)
      // are internal structure of the SAME section, not a section change — extraction
      // continues with the current behavior (review round 1: silent-stop bug).
      if (/^#{3,4}/.test(line) && sectionBehavior !== null && sectionBehavior !== "skip") continue;
      currentSection = name;
      sectionBehavior = ARC_SECTIONS.has(name)
        ? "skip"
        : FACT_SECTIONS[name] ?? null; // unknown section -> null (don't extract until a known one resumes)
      continue;
    }

    if (sectionBehavior === null || sectionBehavior === "skip") continue;

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue;
    const rawValue = bullet[1].trim();
    if (!rawValue) continue;

    if (sectionBehavior === "split-constraint-preference" || sectionBehavior === "classify") {
      const key = explicitKey(rawValue) ?? slugKey(rawValue);
      const value = capValue(bulletValue(rawValue));
      if (!value) continue;
      if (INSTRUCTION_RE.test(value)) continue; // injection-shaped → dropped
      out.push({
        key,
        value,
        category: classifyCategory(value),
        section: currentSection,
      });
    } else if (sectionBehavior === "decision") {
      const key = explicitKey(rawValue) ?? slugKey(rawValue);
      const value = capValue(bulletValue(rawValue));
      if (!value) continue;
      if (INSTRUCTION_RE.test(value)) continue; // injection-shaped → dropped
      out.push({
        key,
        value,
        category: "decision",
        section: currentSection,
      });
    }

    if (out.length >= MAX_RECORDS_PER_COMPACTION) break;
  }

  // Dedup within this summary by key (a repeated key across sections keeps the first).
  const seen = new Set<string>();
  return out.filter((c) => {
    if (seen.has(c.key)) return false;
    seen.add(c.key);
    return true;
  });
}
