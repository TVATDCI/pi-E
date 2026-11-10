// D1 observer scoping test (v2 — captain's ext-drift-tripwire ruling 2026-11-10, pick (b)).
// Run: node --experimental-strip-types tests/prompt-hash.test.ts
//
// Pins BOTH directions of the ruling:
//   (i)  per-project AGENTS.md/CLAUDE.md variation (<project_instructions>) and pi
//        base-prompt changes do NOT move the hash — opening the agent in a different
//        project must not trip the drift signal (the live false positive behind the ruling);
//        this includes projects that literally embed ownership tags (audit F2) and routine
//        lane-inbox traffic (audit F1);
//   (ii) changes to extension-owned sections DO move the hash (and therefore trip it).
// Plus the emitter↔extractor protocol: wrapOwnedSections() emits the exact region
// extractExtensionOwned() extracts — single-sourced via OWNERSHIP_TAG.
// Handler-level (end-to-end) pins live in tests/prompt-chain.test.ts (audit F3).
import {
  hashPrompt,
  isKnownGood,
  KNOWN_GOOD_HASHES,
  stableParts,
  extractExtensionOwned,
  wrapOwnedSections,
  OWNERSHIP_TAG,
} from "../lib/prompt-hash.ts";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}`);
  }
}

// ── Fixture: a composed prompt shaped like the live one ─────────────────────────
// pi-owned content (base prompt + per-project instructions) — OUT of the hash.
const BASE = "pi base system prompt (model harness text — pi-owned)";
const PROJECT_A =
  '<project_instructions path="/home/x/projA/AGENTS.md">\n# Project A rules\nUse tabs. Never push to main.\n</project_instructions>';
const PROJECT_B =
  '<project_instructions path="/home/y/projB/CLAUDE.md">\n# Project B rules\nCOMPLETELY DIFFERENT CONTENT: other conventions, other length, other path.\n</project_instructions>';

// Extension-owned tail, exactly as prompt-coordinator composes it (section order + tags).
const TAIL =
  "\n\n## Cost Discipline\nDelegate grunt work." +
  "\n\n<purpose>\nShip the scoped hash.\n</purpose>" +
  "\n\n## Session notes\nYou have add_note." +
  "\n\n<lane-inbox-sentinel>\n\u{1F4E5} LANE-INBOX UNREAD (1)\n- unread.md\n</lane-inbox-sentinel>" +
  "\n\n<bridge-context>\n[FROM bridge, exported T1]\n- constraint:x\n</bridge-context>" +
  "\n\n<memory-context>\n[constraint] foo: bar\n</memory-context>";

const FULL_A = BASE + "\n\n" + PROJECT_A + "\n\n" + wrapOwnedSections(TAIL);
const GOLDEN = hashPrompt(FULL_A);
// Same TAIL minus the sentinel block — sentinel presence/absence is routine lane state.
const TAIL_NO_SENTINEL =
  "\n\n## Cost Discipline\nDelegate grunt work." +
  "\n\n<purpose>\nShip the scoped hash.\n</purpose>" +
  "\n\n## Session notes\nYou have add_note." +
  "\n\n<bridge-context>\n[FROM bridge, exported T1]\n- constraint:x\n</bridge-context>" +
  "\n\n<memory-context>\n[constraint] foo: bar\n</memory-context>";
// A project that literally embeds ownership tags inside its AGENTS.md (audit F2).
const PROJECT_EMBEDS_TAGS =
  '<project_instructions path="/home/z/projZ/AGENTS.md">\n# Project Z docs paste\n<extension-owned>note</extension-owned>\nalso an unpaired <extension-owned> open tag\n</project_instructions>';

// ── Direction (i): per-project / pi-side variation must NOT move the hash ───────
check("hashPrompt deterministic", hashPrompt(FULL_A) === GOLDEN);
check("hash is 16 lowercase hex", /^[0-9a-f]{16}$/.test(GOLDEN));
check(
  "different project's AGENTS.md/CLAUDE.md content does NOT move the hash (the ruling's false positive, pinned dead)",
  hashPrompt(BASE + "\n\n" + PROJECT_B + "\n\n" + wrapOwnedSections(TAIL)) === GOLDEN,
);
check(
  "per-project block absent entirely (project without AGENTS.md) does NOT move the hash",
  hashPrompt(BASE + "\n\n" + wrapOwnedSections(TAIL)) === GOLDEN,
);
check(
  "pi base prompt changed (pi upgrade) does NOT move the hash",
  hashPrompt("A COMPLETELY DIFFERENT base prompt." + "\n\n" + PROJECT_A + "\n\n" + wrapOwnedSections(TAIL)) === GOLDEN,
);
check(
  "pi-owned trailing content added after the wrapper does NOT move the hash",
  hashPrompt(FULL_A + '\n\n<cwd>\n/somewhere/else\n</cwd>') === GOLDEN,
);
check(
  "per-project variation does not trip the signal either (same hash ⇒ same known-good verdict)",
  isKnownGood(hashPrompt(BASE + "\n\n" + PROJECT_B + "\n\n" + wrapOwnedSections(TAIL))) === isKnownGood(GOLDEN),
);

// ── Direction (ii): extension-owned changes MUST move the hash ──────────────────
check(
  "extension-owned section edited (Cost Discipline text) DOES move the hash",
  hashPrompt(BASE + "\n\n" + PROJECT_A + "\n\n" + wrapOwnedSections(TAIL.replace("Delegate grunt work.", "Do it all yourself."))) !== GOLDEN,
);
check(
  "ownership wrapper gone (coordinator lost / shell failed) DOES move the hash — lost scaffolding trips",
  hashPrompt(BASE + "\n\n" + PROJECT_A + "\n\n" + TAIL) !== GOLDEN,
);
const HAZARD_BLOCK =
  "<hazard-tripwire>\nSESSION HAZARD ACTIVE: scaffolding failed verification.\n</hazard-tripwire>";
check(
  "hazard block present (registry-tagged, composed by its own handler) DOES move the hash",
  hashPrompt(FULL_A + "\n\n" + HAZARD_BLOCK) !== GOLDEN,
);
check(
  "hazard block content change DOES move the hash (state-bearing, extension-owned)",
  hashPrompt(FULL_A + "\n\n" + HAZARD_BLOCK) !==
    hashPrompt(FULL_A + "\n\n" + HAZARD_BLOCK.replace("scaffolding", "other wording")),
);
check(
  "lane-inbox sentinel content change does NOT move the hash (audit F1: routine lane traffic is not drift)",
  hashPrompt(BASE + "\n\n" + PROJECT_A + "\n\n" + wrapOwnedSections(TAIL.replace("unread.md", "other-message.md"))) === GOLDEN,
);
check(
  "lane-inbox sentinel present vs absent does NOT move the hash (audit F1)",
  hashPrompt(BASE + "\n\n" + PROJECT_A + "\n\n" + wrapOwnedSections(TAIL_NO_SENTINEL)) === GOLDEN,
);
check(
  "project text embedding literal owned tags (paired + unpaired) does NOT enter the hash (audit F2)",
  hashPrompt(BASE + "\n\n" + PROJECT_EMBEDS_TAGS + "\n\n" + wrapOwnedSections(TAIL)) === GOLDEN,
);
check(
  "unpaired owned tag in project text does not swallow the project tail (audit F2: extraction equals the clean-project extraction)",
  extractExtensionOwned(BASE + "\n\n" + PROJECT_EMBEDS_TAGS + "\n\n" + wrapOwnedSections(TAIL)) ===
    extractExtensionOwned(FULL_A),
);

// ── v1 guarantee preserved: volatile content INSIDE the wrapper stays free ──────
const VOLATILE_CHANGED = wrapOwnedSections(
  "\n\n## Cost Discipline\nDelegate grunt work." +
    "\n\n<purpose>\nA TOTALLY DIFFERENT purpose this session.\n</purpose>" +
    "\n\n## Session notes\nYou have add_note." +
    "\n\n<lane-inbox-sentinel>\n\u{1F4E5} LANE-INBOX UNREAD (1)\n- unread.md\n</lane-inbox-sentinel>" +
    "\n\n<bridge-context>\n[FROM bridge, exported T2 — DIFFERENT TIMESTAMP]\n- decision:y\n</bridge-context>" +
    "\n\n<memory-context>\n[decision] totally: different facts\n</memory-context>",
);
check(
  "volatile CONTENT inside owned regions (memory/bridge/purpose) does NOT move the hash",
  hashPrompt(BASE + "\n\n" + PROJECT_A + "\n\n" + VOLATILE_CHANGED) === GOLDEN,
);

// ── Emitter↔extractor protocol (single-sourced via OWNERSHIP_TAG) ──────────────
check(
  "wrapOwnedSections emits exactly what extractExtensionOwned extracts (protocol roundtrip)",
  extractExtensionOwned(wrapOwnedSections(TAIL)) === TAIL + "\n",
);
check(
  "multiple owned regions extract in document order (wrapper then hazard)",
  extractExtensionOwned(wrapOwnedSections(TAIL) + "\n\n" + HAZARD_BLOCK) ===
    TAIL + "\n" + "\n\n" + "\nSESSION HAZARD ACTIVE: scaffolding failed verification.\n",
);
check(
  "composition order flips ⇒ extraction flips (document order, not registry order)",
  extractExtensionOwned(wrapOwnedSections(TAIL) + "\n\n" + HAZARD_BLOCK) !==
    extractExtensionOwned(HAZARD_BLOCK + "\n\n" + wrapOwnedSections(TAIL)),
);
check(
  "reordered owned sections → different hash (order is content, v1 property kept)",
  hashPrompt(wrapOwnedSections("\n\nB" + "\n\nA")) !== hashPrompt(wrapOwnedSections("\n\nA" + "\n\nB")),
);
check("untagged prompt extracts nothing (hash-of-empty baseline)", extractExtensionOwned(BASE) === "");
check(
  "stableParts is byte-precise: owned regions minus all four volatile blocks (cost+notes remain, trailing wrapper newline)",
  stableParts(FULL_A) === "\n\n## Cost Discipline\nDelegate grunt work." + "\n\n## Session notes\nYou have add_note." + "\n",
);

// ── Known-good set behavior (v2 landing state: EMPTY until live re-seed) ────────
check("isKnownGood respects the set", isKnownGood(GOLDEN) === KNOWN_GOOD_HASHES.has(GOLDEN));
check("v2 lands with an empty set ⇒ drift until live-captured hash is seeded", KNOWN_GOOD_HASHES.size === 0 && isKnownGood(GOLDEN) === false);
check("OWNERSHIP_TAG is what the coordinator wrapper carries", wrapOwnedSections("").startsWith(`<${OWNERSHIP_TAG}>`));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`golden extension-owned stable-parts hash: ${GOLDEN}`);
console.log(`(v2 lands with an EMPTY known-good set: capture the live hash on first boot and seed KNOWN_GOOD_HASHES)`);
if (fail > 0) process.exit(1);
