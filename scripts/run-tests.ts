// run-tests.ts — #5 unified test runner: spawn-per-file aggregator over the repo's
// two self-contained script-convention test families (test-*.ts + *.test.ts).
//
// Design (verified against the repo, 2026-08-14):
//   - 30 test files today (13 × test-*.ts + 17 × *.test.ts) across extensions/ subtrees.
//   - Every family member is a self-contained script: check() counters, process.exit(1)
//     on failure, implicit 0 on pass. NOT node:test — `node --test` discovery cannot wrap
//     them. We spawn each with cwd = its own directory (their headers say "Run from here").
//   - Sequential execution: a hung/crashing file must not poison the suite; no lock or
//     temp-dir contention between files.
//   - Per-file hard timeout (SIGTERM → 1s grace → SIGKILL): termination-at-boundary.
//   - PI_NETWORK_TESTS passes through via env inherit: network tests stay opt-in.
//   - Expect-count assertion: suite-size drift in EITHER direction is loud by default
//     (--expect N). Bump it consciously when adding/removing a test file.
//   - Exit code: 0 iff every file exited 0 within timeout AND count matches --expect.
//
// Run: node --experimental-strip-types scripts/run-tests.ts [--expect N] [--timeout ms] [pattern...]

import { spawn, execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import * as os from "node:os";

const REPO = join(os.homedir(), ".pi", "agent");
const EXT_DIR = join(REPO, "extensions");
const DEFAULT_EXPECT = 30;
const DEFAULT_TIMEOUT_MS = 60_000;
const GRACE_MS = 1_000;

interface Flags {
  expect: number | null;
  timeoutMs: number;
  pattern: string | null;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { expect: null, timeoutMs: DEFAULT_TIMEOUT_MS, pattern: null };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expect") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) throw new Error(`--expect needs a non-negative integer, got '${argv[i]}'`);
      flags.expect = v;
    } else if (a.startsWith("--expect=")) {
      const v = Number(a.slice("--expect=".length));
      if (!Number.isInteger(v) || v < 0) throw new Error(`--expect needs a non-negative integer, got '${a.slice(9)}'`);
      flags.expect = v;
    } else if (a === "--timeout") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0) throw new Error(`--timeout needs a positive integer (ms), got '${argv[i]}'`);
      flags.timeoutMs = v;
    } else if (a.startsWith("--timeout=")) {
      const v = Number(a.slice("--timeout=".length));
      if (!Number.isInteger(v) || v <= 0) throw new Error(`--timeout needs a positive integer (ms), got '${a.slice(10)}'`);
      flags.timeoutMs = v;
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) throw new Error(`at most one substring pattern allowed, got ${positional.length}`);
  flags.pattern = positional[0] ?? null;
  return flags;
}

/** Depth-first discovery of test files under a root, filtered to git-TRACKED files only.
 * Both naming conventions, deterministic order. Tracked-only closes the commit-time
 * execution surface (review security-a): an untracked file matching the glob never runs —
 * the operator's `git add` is the review. Synchronous `git ls-files` — called once per run. */
function trackedFiles(root: string): Set<string> {
  try {
    const out = execSync("git ls-files", { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    return new Set(out.split("\n").filter(Boolean).map((f) => join(root, f)));
  } catch {
    return new Set(); // not a git repo (e.g. fresh export): fall through — discovery runs but expect-drift will flag
  }
}

function discover(root: string, tracked: Set<string>): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable subdir — skip, don't crash discovery
    }
    for (const name of entries.sort()) {
      if (name === "node_modules" || name === ".git" || name.endsWith(".bak")) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full); // directories aren't in git ls-files — filter applies to FILE candidates only
        continue;
      }
      if (tracked.size > 0 && !tracked.has(full)) continue; // untracked → never executed
      if (/^test-.*\.ts$/.test(name) || /\.test\.ts$/.test(name)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

interface FileResult {
  file: string; // relative to repo
  ok: boolean;
  ms: number;
  kind: "pass" | "fail" | "timeout" | "error";
  detail?: string;
}

function runOne(absPath: string, timeoutMs: number): Promise<FileResult> {
  return new Promise((resolve) => {
    const rel = relative(REPO, absPath);
    const started = Date.now();
    const child = spawn(process.execPath, ["--experimental-strip-types", absPath], {
      cwd: dirname(absPath), // each family runs from its own dir (their headers' contract)
      stdio: ["ignore", "pipe", "pipe"],
      // Whitelist, not passthrough (review security-b): a compromised test file must not
      // reach operator shell secrets (API keys, SSH_AUTH_SOCK, cloud creds) via env.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        PI_NETWORK_TESTS: process.env.PI_NETWORK_TESTS ?? "",
      },
    });

    let stderrTail = "";
    let stdoutTail = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        // NOTE: child.killed is true the moment SIGTERM is SENT, not when the child
        // dies — gating on it would never dispatch SIGKILL (review round 1 fix).
        // `settled` (set by close/error) is the authoritative exited signal.
        if (!settled) child.kill("SIGKILL");
      }, GRACE_MS);
    }, timeoutMs);

    const settle = (r: FileResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdoutTail = (stdoutTail + s).slice(-2000);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
    });
    child.on("error", (err: Error) => {
      settle({ file: rel, ok: false, ms: Date.now() - started, kind: "error", detail: `spawn error: ${err.message}` });
    });
    child.on("close", (code: number | null) => {
      const ms = Date.now() - started;
      if (timedOut) {
        settle({ file: rel, ok: false, ms, kind: "timeout", detail: `killed after ${timeoutMs}ms` });
      } else if (code === 0) {
        settle({ file: rel, ok: true, ms, kind: "pass" });
      } else {
        const tail = (stderrTail || stdoutTail || "").trim();
        settle({ file: rel, ok: false, ms, kind: "fail", detail: tail ? tail.split("\n").slice(-8).join("\n") : `exit code ${code}` });
      }
    });
  });
}

async function main(): Promise<number> {
  let flags: Flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`run-tests: ${(e as Error).message}`);
    console.error("usage: run-tests.ts [--expect N] [--timeout ms] [substring]");
    return 2;
  }

  const all = discover(EXT_DIR, trackedFiles(EXT_DIR));
  const files = flags.pattern ? all.filter((f) => f.includes(flags.pattern as string)) : all;

  if (files.length === 0) {
    console.error(`run-tests: no test files matched${flags.pattern ? ` pattern '${flags.pattern}'` : ""} under extensions/`);
    return 2;
  }

  console.log(`run-tests: ${files.length} file(s)${flags.pattern ? ` matching '${flags.pattern}'` : ""}, timeout ${flags.timeoutMs}ms/file, sequential\n`);

  const results: FileResult[] = [];
  for (const f of files) {
    const r = await runOne(f, flags.timeoutMs);
    results.push(r);
    const tag = r.kind === "pass" ? "✓" : r.kind === "timeout" ? "⏱" : "✗";
    console.log(`${tag} ${r.file} (${r.ms}ms)`);
    if (r.kind !== "pass" && r.detail) {
      const indented = r.detail.split("\n").map((l) => `    ${l}`).join("\n");
      console.log(indented);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} files passed` + (failed.length ? `, ${failed.length} FAILED: ${failed.map((f) => f.file).join(", ")}` : ""));

  // Expect-count assertion: suite-size drift must be loud (unless a pattern narrows scope).
  if (flags.expect !== null && !flags.pattern) {
    if (all.length !== flags.expect) {
      console.error(`\nrun-tests: EXPECT-DRIFT — discovered ${all.length} test files, --expect ${flags.expect}.`);
      console.error(`  New file added? Bump the default in run-tests.ts (line ~28) + this run's --expect.`);
      console.error(`  File lost? Investigate before proceeding.`);
      return 1;
    }
  }

  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
