// D1 observer golden snapshot test. Run: node --experimental-strip-types tests/prompt-hash.test.ts
// The golden: a fixed canonical composed prompt → a fixed hash. Any change to the composed
// prompt (a block added/removed/reordered/edited) changes the hash → drift detected.
import { hashPrompt, isKnownGood, KNOWN_GOOD_HASHES } from "../lib/prompt-hash.ts";

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

// Canonical composed prompt. STABLE parts (BASE + <purpose> + the ## sections) plus the two
// XML-tagged VOLATILE blocks (<bridge-context>, <memory-context>). hashPrompt() strips the
// volatile blocks, so their content MUST NOT move the hash — only stable changes do.
const STABLE =
  "BASE (AGENTS.md governance)" +
  "\n\n<purpose>\nAudit Architecture Complexity\n</purpose>" +
  "\n\n## Cost Discipline\nDelegate grunt work." +
  "\n\n## Session notes\nYou have add_note.";
const FULL =
  STABLE +
  "\n\n<bridge-context>\n[FROM bridge, exported T1]\n- constraint:x\n</bridge-context>" +
  "\n\n<memory-context>\n[constraint] foo: bar\n</memory-context>";
// Same STABLE parts, but the volatile blocks carry DIFFERENT content (new timestamp, more
// bridge entries, different memory facts) — must hash identically to FULL.
const VOLATILE_CHANGED =
  STABLE +
  "\n\n<bridge-context>\n[FROM bridge, exported T2 — DIFFERENT TIMESTAMP]\n- decision:y\n- exact:z\n</bridge-context>" +
  "\n\n<memory-context>\n[decision] totally: different facts\n</memory-context>";
// GOLDEN = hash of the structured prompt (stable parts + the volatile tags). The key property:
// volatile CONTENT inside the tagged blocks does NOT move the hash (only stable changes do).
const GOLDEN = hashPrompt(FULL);

check("hashPrompt deterministic", hashPrompt(FULL) === hashPrompt(FULL));
check("hash is 16 lowercase hex", /^[0-9a-f]{16}$/.test(GOLDEN));
check("changing volatile CONTENT does not move the hash (the fix)", hashPrompt(VOLATILE_CHANGED) === GOLDEN);
check("stable content change DOES move the hash", hashPrompt(STABLE + " ") !== GOLDEN);
check(
  "reordered STABLE blocks → different hash (order is content)",
  hashPrompt("BASE\n\n## Session notes\nX\n\n<purpose>Y") !== hashPrompt("BASE\n\n<purpose>Y\n\n## Session notes\nX"),
);
check("isKnownGood respects the set", isKnownGood(GOLDEN) === KNOWN_GOOD_HASHES.has(GOLDEN));
check("empty known-good set ⇒ drift until curated", isKnownGood(GOLDEN) === false);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`golden stable-parts hash: ${GOLDEN}`);
console.log(`(after the next live boot, seed KNOWN_GOOD_HASHES with the verified stable hash)`);
if (fail > 0) process.exit(1);
