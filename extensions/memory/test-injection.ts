// Tier 3 test for injection.ts (pure pipeline). Run: node --experimental-strip-types test-injection.ts
import { buildInjection } from "./injection.ts";
import type { MemoryRecord } from "./schema.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

function rec(
  category: MemoryRecord["category"],
  key: string,
  value: string,
  provenance: MemoryRecord["provenance"] = "operator",
  recordedAt = 1000,
): MemoryRecord {
  return { schemaVersion: 1, scope: "global", category, key, value, provenance, turn: 0, recordedAt };
}

async function main() {
  // --- empty store ---
  const empty = buildInjection([]);
  check("empty: block is empty string", empty.block === "");
  check("empty: keptCount 0, cutCount 0", empty.keptCount === 0 && empty.cutCount === 0);

  // --- single record ---
  const one = buildInjection([rec("fact", "k", "value here")]);
  check("single: block non-empty", one.block !== "");
  check("single: block contains the record", one.block.includes("[fact] k: value here"));
  check("single: keptCount 1, cutCount 0", one.keptCount === 1 && one.cutCount === 0);

  // --- ranking reflected in block order: constraint before decision before fact ---
  const ordered = buildInjection([
    rec("fact", "f", "aaaaaaaa"),
    rec("decision", "d", "aaaaaaaa"),
    rec("constraint", "c", "aaaaaaaa"),
  ]);
  const lines = ordered.block.split("\n");
  const idxC = lines.findIndex((l) => l.includes("] c:"));
  const idxD = lines.findIndex((l) => l.includes("] d:"));
  const idxF = lines.findIndex((l) => l.includes("] f:"));
  check("order: constraint before decision", idxC > -1 && idxC < idxD);
  check("order: decision before fact", idxD < idxF);

  // --- budget cuts lowest rank first; constraint/decision/preference kept, facts cut ---
  // 5 records x 8-char value (2 tokens each) = 10 tokens; budget 6 -> keep 3, cut 2.
  const budgeted = buildInjection([
    rec("fact", "f1", "aaaaaaaa", "operator", 100),
    rec("fact", "f2", "bbbbbbbb", "operator", 200),
    rec("preference", "p1", "cccccccc", "operator", 100),
    rec("decision", "d1", "dddddddd", "operator", 100),
    rec("constraint", "c1", "eeeeeeee", "operator", 100),
  ], 6);
  check("budget: keeps 3", budgeted.keptCount === 3);
  check("budget: cuts 2", budgeted.cutCount === 2);
  check("budget: kept = constraint+decision+preference",
    budgeted.kept.map((r) => r.key).sort().join(",") === "c1,d1,p1");
  check("budget: cut = both facts",
    budgeted.cut.map((r) => r.key).sort().join(",") === "f1,f2");
  check("budget: estimatedTokens = 6", budgeted.estimatedTokens === 6);

  // --- provenance within category: operator before inferred ---
  const prov = buildInjection([
    rec("constraint", "inf", "aaaaaaaa", "inferred", 900),
    rec("constraint", "op", "aaaaaaaa", "operator", 100),
  ]);
  const pLines = prov.block.split("\n");
  const idxOp = pLines.findIndex((l) => l.includes("] op:"));
  const idxInf = pLines.findIndex((l) => l.includes("] inf:"));
  check("provenance: operator before inferred in block", idxOp > -1 && idxOp < idxInf);

  // --- inferred tag appears in block for inferred records ---
  check("inferred tag present", prov.block.includes("[inferred]"));

  // --- guard comment always present (when non-empty) ---
  check("guard comment present", budgeted.block.includes("not user input"));
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}).catch((e) => {
  console.error("TEST CRASHED:", e);
  process.exit(1);
});
