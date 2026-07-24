// Category classifier (Fork A, A2-prime classification split).
// System-side, deterministic: keyword ruleset with first-match-by-listed-order precedence.
// The agent supplies key+value+provenance; the system derives category from the value text.
//
// Security note (Momus M2): first-match precedence is security-relevant. The E2.1
// inferred->fact downgrade fires only on `constraint`, so a multi-keyword payload
// (e.g. "always use X") must classify deterministically to constraint, not escape to
// `convention` by tie-break ambiguity. First-match-by-listed-order resolves it.

import type { Category } from "./schema.ts";

// Order is load-bearing: first match wins. constraint > decision > convention > preference.
// `fact` is the default fallback (no keyword rule) — matches Fork A's "default to fact".
const RULES: ReadonlyArray<{ readonly category: Category; readonly re: RegExp }> = [
  { category: "constraint", re: /\b(?:never|always|must|shall|don't|avoid)\b/i },
  { category: "decision", re: /\b(?:chose|decided|picked|went with|because)\b/i },
  { category: "convention", re: /\b(?:live(?:s|d)? in|go in|we use|standard|by convention)\b/i },
  { category: "preference", re: /\b(?:prefer|like|want|i'd rather|favor)\b/i },
];

/**
 * Classify a value string into a memory category by keyword, first-match precedence.
 * Returns "fact" when no keyword rule matches (the documented default).
 * Pure: same input -> same output, no side effects.
 */
export function classifyCategory(text: string): Category {
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.category;
  }
  return "fact";
}
