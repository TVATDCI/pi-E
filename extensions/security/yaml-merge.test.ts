// D5 security-boundary invariant tests for yaml-merge.ts.
// Run: node --experimental-strip-types yaml-merge.test.ts
//
// Proves the containment CONTRACT with a minimal schema ({ denied: string[] }):
//   - project can ADD denies; the global set is always present (cannot be removed at the
//     primitive level — global is folded first and the primitive never drops it);
//   - parse-error in a layer ⇒ that layer is null (fail-closed), the other still applies;
//   - source labeling + schemaVersion are correct.
// Per-schema correctness (teams member-dedup, chains add-only) is tested at rewire time.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denyAdditiveMerge, MERGE_SCHEMA_VERSION } from "./yaml-merge.ts";

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

interface DenyLayer {
  denied: string[];
}

const parse = (raw: unknown): DenyLayer | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.denied)) return null;
  return { denied: r.denied.map((s) => String(s)) };
};
// append-only fold: union, global order preserved, dedup.
const addInto = (acc: DenyLayer, layer: DenyLayer): void => {
  for (const d of layer.denied) if (!acc.denied.includes(d)) acc.denied.push(d);
};
const empty = (): DenyLayer => ({ denied: [] });

let dir: string;
function setup(globalYaml: string | null, projectYaml: string | null) {
  dir = mkdtempSync(join(tmpdir(), "yaml-merge-"));
  const g = join(dir, "global.yaml");
  const p = join(dir, "project.yaml");
  if (globalYaml !== null) writeFileSync(g, globalYaml);
  if (projectYaml !== null) writeFileSync(p, projectYaml);
  return { globalPath: g, projectPath: p };
}

// 1. both present: project adds; global preserved; order global-first.
{
  const o = setup("denied: [rm, git-push]\n", "denied: [aws-s3-rm]\n");
  const r = denyAdditiveMerge({ ...o, parse, empty: empty(), addInto });
  check("merged: global + project denies present", r.data?.denied.join(",") === "rm,git-push,aws-s3-rm");
  check("merged: source = merged", r.source === "merged");
  check("merged: schemaVersion set", r.schemaVersion === MERGE_SCHEMA_VERSION);
}

// 2. project parse-error ⇒ project null ⇒ result = global (fail-closed; global preserved).
{
  const o = setup("denied: [rm]\n", "this: is: not: valid: yaml: [\n");
  const r = denyAdditiveMerge({ ...o, parse, empty: empty(), addInto });
  check("project parse-error ⇒ fail-closed to global", r.data?.denied.join(",") === "rm");
  check("project parse-error ⇒ source = global", r.source === "global");
}

// 3. global parse-error ⇒ global null ⇒ result = project.
{
  const o = setup("denied: [oops\n", "denied: [aws-s3-rm]\n");
  const r = denyAdditiveMerge({ ...o, parse, empty: empty(), addInto });
  check("global parse-error ⇒ fail-closed to project", r.data?.denied.join(",") === "aws-s3-rm");
  check("global parse-error ⇒ source = project", r.source === "project");
}

// 4. INVARIANT: a project layer that LISTS fewer entries cannot shrink the global set.
//    (Proves the primitive folds global unconditionally; addInto is append-only.)
{
  const o = setup("denied: [rm, git-push, mkfs]\n", "denied: [only-this]\n");
  const r = denyAdditiveMerge({ ...o, parse, empty: empty(), addInto });
  check("invariant: project cannot remove global denies", r.data?.denied.includes("rm") && r.data?.denied.includes("git-push") && r.data?.denied.includes("mkfs"));
  check("invariant: project deny added", r.data?.denied.includes("only-this"));
}

// 5. both missing ⇒ null, source none.
{
  const o = setup(null, null);
  const r = denyAdditiveMerge({ ...o, parse, empty: empty(), addInto });
  check("both missing ⇒ data null", r.data === null);
  check("both missing ⇒ source none", r.source === "none");
}

// 6. wrong-shape layer (parse returns null) ⇒ fail-closed like a parse error.
{
  const o = setup("denied: [rm]\n", "not-denied: [x]\n"); // project missing `denied`
  const r = denyAdditiveMerge({ ...o, parse, empty: empty(), addInto });
  check("wrong-shape project ⇒ fail-closed to global", r.data?.denied.join(",") === "rm");
}

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  /* best-effort cleanup */
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
