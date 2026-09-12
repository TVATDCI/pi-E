/**
 * pi model-state extraction (shared spec §3) — tier-map assignments incl.
 * judging locks, plus the fixed 64-hex source digest anchor that catches
 * doctrine-edit drift (the recorded `0ce0b18` class: comment-level doctrine
 * revision with numerically identical assignments).
 *
 * Bounded read (INV-2): the extractor consumes tier-map TEXT supplied by the
 * caller; the drift check feeds it exactly one file — the model-binding source
 * of truth. Never skill bodies, prompts, or prose.
 */

import { createHash } from "node:crypto";

export type ModelState = {
  source: { path: string; sha256: string };
  assignments: Record<string, { primary: string; fallbacks: string[] }>;
  judgingLocks: { categories: string[]; chains: Record<string, string[]> };
};

export const TIER_MAP_REL = "extensions/orchestration-engine/tier-map.ts";

export const JUDGING_CATEGORIES: readonly string[] = [
  "unspecified-high",
  "deep",
  "ultrabrain",
];

const TIERS_ANCHOR = "export const TIERS";

/** Index of the `}` matching the `{` at openIdx (string-literal aware). */
function findMatchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Top-level category entries inside the TIERS literal (2-space indent). */
function splitEntries(inner: string): Map<string, string> {
  const entries = new Map<string, string>();
  const entryRe = /\n\s{2}(?:"([^"]+)"|([A-Za-z-]+)):\s*\{/g;
  const starts: { key: string; bodyStart: number; keyLineStart: number }[] = [];
  for (let m = entryRe.exec(inner); m !== null; m = entryRe.exec(inner)) {
    const key = m[1] ?? m[2];
    if (key === undefined) continue;
    starts.push({
      key,
      bodyStart: m.index + m[0].length,
      keyLineStart: m.index,
    });
  }
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i];
    const next = starts[i + 1];
    if (cur === undefined) continue;
    const bodyEnd = next === undefined
      ? inner.length
      : inner.lastIndexOf("\n", next.keyLineStart);
    entries.set(cur.key, inner.slice(cur.bodyStart, bodyEnd));
  }
  return entries;
}

function parseEntry(body: string): { primary: string; fallbacks: string[] } {
  const provider = /provider:\s*"([^"]+)"/.exec(body)?.[1] ?? "";
  const id = /id:\s*"([^"]+)"/.exec(body)?.[1] ?? "";
  const fallbacks: string[] = [];
  const fbOpen = body.indexOf("fallbackModels");
  if (fbOpen >= 0) {
    const arrOpen = body.indexOf("[", fbOpen);
    const arrClose = body.indexOf("]", arrOpen >= 0 ? arrOpen : 0);
    if (arrOpen >= 0 && arrClose > arrOpen) {
      const arrBody = body.slice(arrOpen + 1, arrClose);
      const pairRe = /\{\s*provider:\s*"([^"]+)",\s*id:\s*"([^"]+)"\s*\}/g;
      for (let m = pairRe.exec(arrBody); m !== null; m = pairRe.exec(arrBody)) {
        const p = m[1];
        const mid = m[2];
        if (p !== undefined && mid !== undefined) {
          fallbacks.push(`${p}/${mid}`);
        }
      }
    }
  }
  return { primary: `${provider}/${id}`, fallbacks };
}

export function extractModelState(
  tierMapText: string,
  relPath: string,
): ModelState {
  const anchorAt = tierMapText.indexOf(TIERS_ANCHOR);
  if (anchorAt < 0) {
    throw new Error("tier-map: TIERS literal not found");
  }
  const openIdx = tierMapText.indexOf("{", anchorAt);
  const closeIdx = openIdx >= 0 ? findMatchingBrace(tierMapText, openIdx) : -1;
  if (openIdx < 0 || closeIdx < 0) {
    throw new Error("tier-map: TIERS literal unbalanced");
  }
  const inner = tierMapText.slice(openIdx + 1, closeIdx);
  const assignments: Record<string, { primary: string; fallbacks: string[] }> =
    {};
  for (const [key, body] of splitEntries(inner)) {
    assignments[key] = parseEntry(body);
  }
  const categories = JUDGING_CATEGORIES.filter((c) => c in assignments);
  const chains: Record<string, string[]> = {};
  for (const c of categories) {
    chains[c] = assignments[c]?.fallbacks ?? [];
  }
  return {
    source: {
      path: relPath,
      sha256: createHash("sha256").update(tierMapText, "utf8").digest("hex"),
    },
    assignments,
    judgingLocks: { categories, chains },
  };
}
