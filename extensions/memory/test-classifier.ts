// Tier 1 test for classifier.ts. Pure logic, no pi runtime.
// Run: node --experimental-strip-types test-classifier.ts
import { classifyCategory } from "./classifier.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

// --- constraint keywords ---
check("constraint: never", classifyCategory("never use any") === "constraint");
check("constraint: always", classifyCategory("always run tests before commit") === "constraint");
check("constraint: must", classifyCategory("you must lint") === "constraint");
check("constraint: shall", classifyCategory("agents shall identify") === "constraint");
check("constraint: don't", classifyCategory("don't commit secrets") === "constraint");
check("constraint: avoid", classifyCategory("avoid any in types") === "constraint");

// --- decision keywords ---
check("decision: chose", classifyCategory("we chose postgres over redis") === "decision");
check("decision: decided", classifyCategory("decided to use zod") === "decision");
check("decision: picked", classifyCategory("picked option b") === "decision");
check("decision: went with", classifyCategory("went with strict mode") === "decision");
check("decision: because", classifyCategory("chose x because y") === "decision");

// --- convention keywords ---
check("convention: lives in (singular)", classifyCategory("the config lives in __tests__") === "convention");
check("convention: live in (plural)", classifyCategory("tests live in __tests__") === "convention");
check("convention: go in", classifyCategory("configs go in etc") === "convention");
check("convention: we use", classifyCategory("we use conventional commits") === "convention");
check("convention: standard", classifyCategory("standard layout per the spec") === "convention");
check("convention: by convention", classifyCategory("by convention tabs not spaces") === "convention");

// --- preference keywords ---
check("preference: prefer", classifyCategory("I prefer early returns") === "preference");
check("preference: like", classifyCategory("I like short functions") === "preference");
check("preference: want", classifyCategory("I want typed errors") === "preference");
check("preference: favor", classifyCategory("favor composition over inheritance") === "preference");

// --- fact (default) ---
check("fact: default on no keyword", classifyCategory("auth uses jwt") === "fact");
check("fact: version statement", classifyCategory("node version 22") === "fact");
check("fact: empty string", classifyCategory("") === "fact");

// --- precedence / security (Momus M2): first-match must be deterministic ---
// "always use X" contains "always" (constraint) AND "use" but NOT the phrase "we use".
// Must classify to constraint, never escape to convention.
check("precedence: 'always use' -> constraint not convention", classifyCategory("always use tabs") === "constraint");
// "must prefer" -> constraint wins over preference
check("precedence: 'must prefer' -> constraint not preference", classifyCategory("you must prefer typed errors") === "constraint");

// --- false-positive guards (word boundaries) ---
// "dislike" must NOT match "like" (no word boundary inside dislike).
check("guard: 'dislike' not preference", classifyCategory("I dislike bugs") === "fact");
// "mustard" must NOT match "must".
check("guard: 'mustard' not constraint", classifyCategory("pass the mustard") === "fact");
// "standardize" -> contains "standard" at a boundary? \bstandard\b vs "standardize": no trailing boundary, no match.
check("guard: 'standardize' not convention", classifyCategory("we standardize on x") === "fact");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
