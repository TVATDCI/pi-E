// Tier 1 test for normalizer.ts. Run: node --experimental-strip-types test-normalizer.ts
import { normalizeKey } from "./normalizer.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

// --- already-normalized (idempotent) ---
check("idempotent: lowercase_underscore", normalizeKey("strict_no_any") === "strict_no_any");

// --- spaces ---
check("spaces: 'Strict No Any' -> strict_no_any", normalizeKey("Strict No Any") === "strict_no_any");
check("spaces: leading/trailing trimmed", normalizeKey("  leading spaces ") === "leading_spaces");
check("spaces: collapse multi-space", normalizeKey("multi   space") === "multi_space");

// --- camelCase ---
check("camelCase: strictNoAny -> strict_no_any", normalizeKey("strictNoAny") === "strict_no_any");
check("camelCase: apiKey -> api_key", normalizeKey("apiKey") === "api_key");

// --- kebab and mixed punctuation ---
check("kebab: kebab-case-key -> kebab_case_key", normalizeKey("kebab-case-key") === "kebab_case_key");
check("punctuation: 'a.b,c;d' -> a_b_c_d", normalizeKey("a.b,c;d") === "a_b_c_d");

// --- edge cases ---
check("empty: '' -> ''", normalizeKey("") === "");
check("symbols-only: '---' -> ''", normalizeKey("---") === "");
check("symbols-only: '!!!@@@' -> ''", normalizeKey("!!!@@@") === "");

// --- acronym handling ---
check("acronym: ALLCAPS -> allcaps (no internal boundary)", normalizeKey("ALLCAPS") === "allcaps");

// --- length cap ---
const long = "a".repeat(80);
check("length cap: 80 chars -> 64", normalizeKey(long).length === 64);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
