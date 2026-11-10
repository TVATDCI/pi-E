// prompt-hash.ts — D1 OBSERVER util (v2 — ext-drift-tripwire ruling, captain's word 2026-11-10).
//
// WHAT CHANGED (v1 → v2): v1 hashed the FULL composed prompt minus volatile XML blocks —
// which included pi's base prompt and per-project AGENTS.md/CLAUDE.md content, so merely
// opening the agent in a different project tripped the drift signal. Captain's ruling
// (pick (b)): the tripwire guards drift in what the EXTENSIONS inject; per-project
// AGENTS.md variation is intended, not drift. v2 therefore hashes ONLY extension-owned
// prompt sections, identified POSITIVELY by in-band ownership tags:
//
//   - `<extension-owned>` — everything prompt-coordinator.ts (the sole before_agent_start
//     compositor) appends. The tag constant is single-sourced HERE (OWNERSHIP_TAG); the
//     coordinator calls wrapOwnedSections() below, so emitter and extractor are the same
//     protocol by construction.
//   - `<hazard-tripwire>` — hazard-tripwire.ts composes this block via its own chained
//     handler when a hazard is active (state-bearing, but extension-owned).
//
// Everything else is out of the hash BY CONSTRUCTION — never stripped, never extracted:
// pi's base prompt, `<project_instructions path="…">` blocks (per-project AGENTS.md /
// CLAUDE.md content, wrapped that way by pi core), cwd blocks, future pi-owned sections.
// New extension sections are hashed only if their emitter lands them inside an owned tag;
// the default for untagged content is OUT, so pi-side additions can never false-trip.
//
// Volatility stripping (v1) survives INSIDE the extracted regions: <memory-context>,
// <bridge-context>, <purpose> content changes by design (memory growth, bridge re-exports,
// per-session purpose) — not drift.
//
// Lost-scaffolding signal preserved: if prompt-coordinator fails to load (or its shell
// throws → base prompt returned without the wrapper), no owned region is extracted and
// the hash collapses to hash-of-empty — not in the known-good set → drift trips. The D1
// intent (composition corruption made loud) is intact.
//
// Pure (node:crypto only) → unit-testable in isolation.

import { createHash } from "node:crypto";

/** Ownership marker emitted by prompt-coordinator.ts around everything it composes.
 * Single-sourced here (the extractor side); the coordinator imports the wrap helper
 * (the emitter side) — the boundary cannot drift apart from composition. */
export const OWNERSHIP_TAG = "extension-owned";

/** XML tags whose regions are extension-owned — the ONLY input to the drift hash.
 * `extension-owned` is the coordinator wrapper (OWNERSHIP_TAG); `hazard-tripwire` is the
 * hazard block composed by hazard-tripwire.ts's chained handler. Nested section tags
 * (purpose / lane-inbox-sentinel / memory / bridge) live INSIDE the wrapper and need no
 * entry. Add a tag ONLY when a new extension starts composing system-prompt sections. */
export const EXTENSION_OWNED_TAGS: readonly string[] = [OWNERSHIP_TAG, "hazard-tripwire"];

const OWNED_REGION_RE = new RegExp(`<(${EXTENSION_OWNED_TAGS.join("|")})>([\\s\\S]*?)</\\1>`, "g");

/** Compose the extension-owned region the coordinator emits: the composed tail wrapped in
 * the ownership tag. The EMITTER (prompt-coordinator.ts) calls this directly, so what is
 * emitted and what extractExtensionOwned() extracts are one protocol, not two copies.
 * (No newline after the open tag — the coordinator's tail carries its own leading separator;
 * one newline before the close tag so it sits on its own line.) */
export function wrapOwnedSections(tail: string): string {
  return `<${OWNERSHIP_TAG}>${tail}\n</${OWNERSHIP_TAG}>`;
}

/** Extract extension-owned regions, concatenated in document (composition) order.
 * Untagged content — pi base prompt, <project_instructions>, cwd blocks — is never
 * returned. No owned region at all ⇒ "" (hash-of-empty ⇒ drift: lost scaffolding). */
export function extractExtensionOwned(prompt: string): string {
  const regions: string[] = [];
  for (const m of prompt.matchAll(OWNED_REGION_RE)) regions.push(m[2]);
  return regions.join("\n\n");
}

/** Strip volatile, by-design-changing blocks INSIDE the extracted owned regions, so
 * drift fires on structural composition changes — not memory growth, bridge re-exports,
 * or per-session purpose. Absent tags ⇒ no-op (safe). Non-greedy + multiline. */
export function stripVolatile(owned: string): string {
  return owned
    .replace(/<memory-context>[\s\S]*?<\/memory-context>/g, "")
    .replace(/<bridge-context>[\s\S]*?<\/bridge-context>/g, "")
    .replace(/<purpose>[\s\S]*?<\/purpose>/g, "");
}

/** STABLE parts of a composed prompt = extension-owned regions minus volatile blocks.
 * (v1 hashed the full prompt minus volatile blocks; v2 scopes to extension-owned only.) */
export function stableParts(prompt: string): string {
  return stripVolatile(extractExtensionOwned(prompt));
}

/** 16-hex sha256 of the STABLE parts (extension-owned sections, volatile blocks stripped). */
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(stableParts(prompt), "utf8").digest("hex").slice(0, 16);
}

/**
 * Known-good STABLE-parts hashes (curated). A hash NOT in this set = drift — an unintended
 * change in extension-owned sections (investigate) or a legit one (add the hash here,
 * reviewed).
 *
 * v2 RE-SEED REQUIRED: v2 changed the hash input (extension-owned sections only), so every
 * v1 hash is DEAD — kept below as commented historical markers. The set is EMPTY at
 * landing by design, mirroring the v1.3 landing flow: the first live boot after this
 * lands trips the drift warning ONCE — capture the hash from the prompt-composition entry
 * (or /routing-stats) and seed it here. States that legitimately differ (unread
 * lane-inbox sentinel present, hazard block active) have their own hashes: either capture
 * those variants too, or accept a one-time warning on them.
 */
export const KNOWN_GOOD_HASHES: Set<string> = new Set<string>([
  // v1 hashes (FULL-prompt stable parts) — DEAD under v2, history only:
  // "c2bfe1b57f74616f" — v1 stable-parts, pi 0.82.1, captured 2026-07-30 [pre-<purpose>-strip]
  // "7f21df25f4181676" — v1 stable-parts, pi 0.83.0, captured 2026-07-30 [pre-<purpose>-strip]
  // "41ecd366ca2476dd" — v1 3-strip, purpose-insensitive, post-prompt-coordinator order
  // "2ee214da6b2a34c3" — v1 3-strip, purpose-insensitive, pi 0.87.0 baseline (2026-09-22)
]);

export function isKnownGood(hash: string): boolean {
  return KNOWN_GOOD_HASHES.has(hash);
}
