// extensions/tests/precommit-worktree.test.ts — worktree-safety acceptance for the
// pre-commit test gate (brain-44j0, shape (a) + R1.4 canary). Self-contained: builds a
// scratch git repo whose pre-commit hook is the FIXED form, then lands a commit in a
// linked WORKTREE with a canary test staged ONLY there — and proves the gate actually
// executed the committed tree (canary ran, discovery non-zero, exit 0, no SKIP_TESTS).
// Run: node --experimental-strip-types precommit-worktree.test.ts   (from extensions/tests/)
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

const HERE = import.meta.dirname;                 // extensions/tests
const REPO_ROOT = join(HERE, "..", "..");         // this repo's root
const RUNNER_SRC = join(REPO_ROOT, "scripts", "run-tests.ts");

// FIXED hook form (verbatim contract — keep in sync with the live hook the Operator lands):
// SKIP_TESTS guard → cd to the tree being committed → relative runner invocation.
const FIXED_HOOK = [
  "#!/bin/bash",
  "# pi-agent test gate — worktree-safe form (brain-44j0)",
  '[ "$SKIP_TESTS" = "1" ] && exit 0',
  'cd "$(git rev-parse --show-toplevel)" || exit 1',
  "node --experimental-strip-types scripts/run-tests.ts",
  "exit $?",
].join("\n") + "\n";

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function canarySrc(logPath: string, marker: string): string {
  // dep-free test file: appends its marker to the log when the gate executes it
  return [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(marker + "\n")});`,
  ].join("\n") + "\n";
}

const base = mkdtempSync(join(tmpdir(), "pcwt-"));
// Node 26 needs a package.json above ESM-syntax .ts or it CJS-parses and dies; this base
// covers repo, linked worktree, runner copy, and canaries via nearest-package lookup.
writeFileSync(join(base, "package.json"), '{"type":"module"}\n');
const repo = join(base, "repo");
const wt = join(base, "wt");
const log = join(base, "gate.log");
let commitOut = "";

try {
  // ── build the scratch repo: REAL runner (post-fix copy) + baseline canary ──
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, "extensions", "tests"), { recursive: true });
  copyFileSync(RUNNER_SRC, join(repo, "scripts", "run-tests.ts"));
  writeFileSync(join(repo, "extensions", "tests", "base-canary.test.ts"), canarySrc(log, "BASE-CANARY-RAN"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "gate@test.local"]);
  git(repo, ["config", "user.name", "gate-test"]);
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  writeFileSync(join(repo, ".git", "hooks", "pre-commit"), FIXED_HOOK);
  const HOOKS = join(repo, ".git", "hooks");
  spawnSync("chmod", ["+x", join(HOOKS, "pre-commit")]);

  // ── negative control: PRIMARY-checkout commit through the fixed hook ──
  git(repo, ["add", "-A"]);
  const primary = git(repo, ["-c", "core.hooksPath=" + HOOKS, "commit", "-qm", "init"]);
  commitOut = (primary.stdout ?? "") + (primary.stderr ?? "");
  check("primary checkout: git commit exits 0 through the fixed hook", primary.status === 0);
  check("primary checkout: discovery is non-zero (1 file)", /run-tests: 1 file\(s\)/.test(commitOut));
  check("primary checkout: baseline canary executed", readFileSync(log, "utf8").includes("BASE-CANARY-RAN"));

  // ── the scenario that used to break: linked worktree + canary staged ONLY there ──
  git(repo, ["worktree", "add", "-q", wt, "-b", "wt-branch"]);
  mkdirSync(join(wt, "extensions", "tests"), { recursive: true });
  writeFileSync(join(wt, "extensions", "tests", "wt-canary.test.ts"), canarySrc(log, "WT-CANARY-RAN"));
  git(wt, ["add", "-A"]);
  const wtCommit = git(wt, ["-c", "core.hooksPath=" + HOOKS, "commit", "-qm", "worktree change"]);
  const wtOut = (wtCommit.stdout ?? "") + (wtCommit.stderr ?? "");
  check("worktree: git commit exits 0 with hooks active and NO SKIP_TESTS", wtCommit.status === 0);
  check("worktree: discovery is non-zero (2 files)", /run-tests: 2 file\(s\)/.test(wtOut));
  check("worktree: gate tested the COMMITTED tree (wt canary executed)", readFileSync(log, "utf8").includes("WT-CANARY-RAN"));
  check("worktree: gate ran the worktree's runner (cwd anchored via rev-parse)", /wt-canary.test.ts/.test(wtOut));
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
