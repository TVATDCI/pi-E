// D1 observer golden snapshot test. Run: node --experimental-strip-types tests/prompt-hash.test.ts
// The golden: a fixed canonical composed prompt → a fixed hash. Any change to the composed
// prompt (a block added/removed/reordered/edited) changes the hash → drift detected.
import { createHash } from "node:crypto";
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

// Canonical 5-block composed prompt (the 5 contributors, in some load order).
const COMPOSED =
  "BASE (AGENTS.md governance)" +
  "\n\n<purpose>\nAudit Architecture Complexity\n</purpose>" +
  "\n\n[FROM bridge, exported T]\n- constraint:x" +
  "\n\n<memory-context>\n[constraint] foo: bar\n</memory-context>" +
  "\n\n## Cost Discipline\nDelegate grunt work." +
  "\n\n## Session notes\nYou have add_note.";
const GOLDEN = hashPrompt(COMPOSED);
const INDEPENDENT = createHash("sha256").update(COMPOSED, "utf8").digest("hex").slice(0, 16);

check("hashPrompt deterministic", hashPrompt(COMPOSED) === GOLDEN);
check("hashPrompt = sha256(prompt).slice(16)", hashPrompt(COMPOSED) === INDEPENDENT);
check("hash is 16 lowercase hex", /^[0-9a-f]{16}$/.test(GOLDEN));
check("different content → different hash", hashPrompt(COMPOSED + " ") !== GOLDEN);
check(
  "reordered blocks → different hash (order is part of the content)",
  hashPrompt("BASE\n\n## Session notes\nX\n\n<purpose>Y") !== hashPrompt("BASE\n\n<purpose>Y\n\n## Session notes\nX"),
);
check("isKnownGood respects the set", isKnownGood(GOLDEN) === KNOWN_GOOD_HASHES.has(GOLDEN));
check("empty known-good set ⇒ canonical prompt is drift (until curated)", isKnownGood(GOLDEN) === false);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`golden hash for the canonical composed prompt: ${GOLDEN}`);
console.log(`(after the first live boot, seed KNOWN_GOOD_HASHES with the verified hash)`);
if (fail > 0) process.exit(1);
