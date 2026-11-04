// extensions/tests/tier-map-comment-hygiene.test.ts — self-enforcing guard against era-comment
// regrowth in tier-map.ts (captain ruling 2026-11-04: the file carries LIVE CONSTRAINTS only,
// tightened; dated/era-shaped history belongs in the root CHANGELOG.md, never back in the file).
//
// Run: node --experimental-strip-types tier-map-comment-hygiene.test.ts   (from extensions/tests/)
//
// Detector class (catches the SHAPE, not just the swept instances) — a comment body fails if it:
//   D1 carries a dated stamp:         YYYY-MM or YYYY-MM-DD     ("revised 2026-09-08 …")
//   D2 carries a bare calendar year:  19xx / 20xx               ("since 2025 …")
//   D3 narrates a past change:        replaced / superseded / demoted / rerouted / revised /
//                                     revision / previously / formerly / ex-primary
// Constraint comments state invariants without dates or change-narration — they pass by
// construction. String VALUES (rationale fields, error messages) are behavior surface and are
// stripped before scanning: only comment bloat is policed here.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(import.meta.dirname, "..", "orchestration-engine", "tier-map.ts");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

/** Extract comment bodies from TS source, skipping string/template literal contents so a dated
 *  rationale VALUE never masquerades as a comment (and a `//` inside a string never starts one). */
function commentBodies(src: string): { body: string; line: number }[] {
  const out: { body: string; line: number }[] = [];
  let i = 0;
  let line = 1;
  let startLine = 1;
  let kind: "" | "line" | "block" | "quote" = "";
  let buf = "";
  let open = "";
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "\n") line++;
    if (kind === "") {
      if (c === "/" && n === "/") {
        kind = "line";
        startLine = line;
        buf = "";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        kind = "block";
        startLine = line;
        buf = "";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        kind = "quote";
        open = c;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (kind === "line") {
      if (c === "\n") {
        out.push({ body: buf, line: startLine });
        kind = "";
        buf = "";
      } else buf += c;
      i++;
      continue;
    }
    if (kind === "block") {
      if (c === "*" && n === "/") {
        out.push({ body: buf, line: startLine });
        kind = "";
        buf = "";
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    // quote: literal contents are skipped; escapes hide the next char.
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === open) {
      kind = "";
      open = "";
    }
    i++;
  }
  if (buf && (kind === "line" || kind === "block")) out.push({ body: buf, line: startLine });
  return out;
}

const D1 = /\b\d{4}-\d{2}(?:-\d{2})?\b/; // 2026-09 / 2026-09-18
const D2 = /\b(?:19|20)\d{2}\b/; // bare year
const D3 =
  /\b(?:replaced|superseded|demoted|rerouted|revised|revision|previously|formerly|ex-primary)\b/i;

const bodies = commentBodies(readFileSync(FILE, "utf8"));
const violations = bodies
  .map((c) => {
    const rules: string[] = [];
    if (D1.test(c.body)) rules.push("D1 dated-stamp");
    if (D2.test(c.body)) rules.push("D2 bare-year");
    if (D3.test(c.body)) rules.push("D3 change-narration");
    return rules.length ? { line: c.line, rules, body: c.body.trim().replace(/\s+/g, " ").slice(0, 120) } : null;
  })
  .filter((v): v is { line: number; rules: string[]; body: string } => v !== null);

check("tier-map.ts exists and yields comment bodies to scan", bodies.length > 0);
check(
  violations.length === 0
    ? "no dated/era-shaped comments in tier-map.ts (constraints-only surface holds)"
    : `no dated/era-shaped comments in tier-map.ts — ${violations.length} violation(s)`,
  violations.length === 0,
);
for (const v of violations.slice(0, 20)) {
  console.log(`    ↳ L${v.line} [${v.rules.join(", ")}]: ${v.body}…`);
}
if (violations.length > 20) console.log(`    … ${violations.length - 20} more`);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail > 0 ? 1 : 0);
