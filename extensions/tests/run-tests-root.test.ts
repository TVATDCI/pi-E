// extensions/tests/run-tests-root.test.ts — regression-locks the runner's repo-root
// resolution (brain-44j0, shape (c)) and the R1.5 invariant (zero-discovery = hard error).
// The runner copy is placed OUTSIDE the scratch repo so script-location derivation and
// git-derived root genuinely diverge; the runner must follow GIT.
// Run: node --experimental-strip-types run-tests-root.test.ts   (from extensions/tests/)
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

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, "..", "..");
const RUNNER_SRC = join(REPO_ROOT, "scripts", "run-tests.ts");
const MIN_ENV = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

function git(cwd: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function canarySrc(logPath: string, marker: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(marker + "\n")});`,
  ].join("\n") + "\n";
}

function runRunner(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return spawnSync(process.execPath, ["--experimental-strip-types", ...args], {
    cwd: opts.cwd, encoding: "utf8", env: opts.env,
  });
}

const base = mkdtempSync(join(tmpdir(), "rtroot-"));
try {
  // scratch repo S1 with one canary; runner copy lives elsewhere (no extensions/ beside it)
  const s1 = join(base, "s1");
  const elsewhere = join(base, "elsewhere");
  const markers = join(base, "markers.log");
  mkdirSync(join(s1, "extensions", "tests"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  copyFileSync(RUNNER_SRC, join(elsewhere, "run-tests.ts"));
  writeFileSync(join(s1, "extensions", "tests", "s1canary.test.ts"), canarySrc(markers, "S1-RAN"));
  git(s1, ["init", "-q"]);
  git(s1, ["config", "user.email", "root@test.local"]);
  git(s1, ["config", "user.name", "root-test"]);
  git(s1, ["add", "-A"]);
  git(s1, ["commit", "-qm", "init"]);

  // A) shape (c): root follows the GIT context of cwd, not the script's location.
  //    Invoked from a SUBDIRECTORY of s1 with the runner copy outside the repo.
  const a = runRunner([join(elsewhere, "run-tests.ts")], { cwd: join(s1, "extensions", "tests"), env: MIN_ENV });
  const aOut = (a.stdout ?? "") + (a.stderr ?? "");
  check("A: runner copy outside the repo still resolves root via git (exit 0)", a.status === 0);
  check("A: discovered the scratch repo's test (non-zero discovery)", /run-tests: 1 file\(s\)/.test(aOut));
  check("A: scratch canary executed (root = git toplevel, not script dir)", readFileSync(markers, "utf8").includes("S1-RAN"));

  // B) hook-faithful env: GIT_DIR exported by git for a linked worktree must be honored
  //    (inherited, never sanitized) — mirrors exactly what the pre-commit hook receives.
  const w1 = join(base, "w1");
  git(s1, ["worktree", "add", "-q", w1, "-b", "w1-branch"]);
  mkdirSync(join(w1, "extensions", "tests"), { recursive: true });
  writeFileSync(join(w1, "extensions", "tests", "w1canary.test.ts"), canarySrc(markers, "W1-RAN"));
  git(w1, ["add", "-A"]);
  const gitdir = join(s1, ".git", "worktrees", "w1");
  const b = runRunner([join(elsewhere, "run-tests.ts")], {
    cwd: w1,
    env: { ...MIN_ENV, GIT_DIR: gitdir },
  });
  const bOut = (b.stdout ?? "") + (b.stderr ?? "");
  check("B: with hook-exported GIT_DIR the runner answers for the WORKTREE (exit 0)", b.status === 0);
  check("B: worktree index discovered (2 files: inherited + staged) and W1 canary executed", /run-tests: 2 file\(s\)/.test(bOut) && readFileSync(markers, "utf8").includes("W1-RAN"));

  // C) non-git fallback (TNT F-finding 1): scratch clone — script-location root, no git.
  const d = join(base, "scratchclone");
  mkdirSync(join(d, "extensions", "tests"), { recursive: true });
  mkdirSync(join(d, "scripts"), { recursive: true });
  copyFileSync(RUNNER_SRC, join(d, "scripts", "run-tests.ts"));
  writeFileSync(join(d, "extensions", "tests", "fbcanary.test.ts"), canarySrc(markers, "FB-RAN"));
  const c = runRunner([join(d, "scripts", "run-tests.ts")], { cwd: d, env: MIN_ENV });
  check("C: non-git context falls back to script-location root (exit 0)", c.status === 0);
  check("C: fallback root still discovers its own tests", readFileSync(markers, "utf8").includes("FB-RAN"));

  // D) R1.5 invariant: zero-discovery stays a LOUD hard error (exit 2) — real runner, live repo.
  const r15 = runRunner([RUNNER_SRC, "zzz-no-such-test-pattern"], { cwd: REPO_ROOT, env: MIN_ENV });
  check("D: zero-discovery is a hard error (exit 2)", r15.status === 2);
} finally {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort scratch cleanup */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
