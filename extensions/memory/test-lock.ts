// Tier 2 test for lock.ts. Run: node --experimental-strip-types test-lock.ts
// Exercises: acquire/release (lockfile lifecycle + return value), mutual exclusion
// (concurrent calls run strictly serially — the property that prevents lost updates),
// stale steal (a dead-pid lockfile is taken over), and timeout under a live lock.
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock, LockTimeoutError } from "./lock.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  // --- 1. acquire/release: lockfile exists during fn, gone after; return value propagates ---
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const target = path.join(dir, "t.txt");
    let existedDuring = false;
    await withFileLock(target, async () => {
      existedDuring = await stat(`${target}.lock`).then(() => true).catch(() => false);
    });
    check("acquire: lockfile present during fn", existedDuring);
    const existsAfter = await stat(`${target}.lock`).then(() => true).catch(() => false);
    check("release: lockfile removed after fn", !existsAfter);
    check("propagate: fn return value flows through", await withFileLock(target, async () => 42) === 42);
  }

  // --- 2. mutual exclusion: concurrent calls run SERIALLY (max overlap = 1) ---
  // This is the core property that prevents the W8 lost-update.
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const target = path.join(dir, "t.txt");
    let active = 0, maxOverlap = 0;
    const task = (id: number) =>
      withFileLock(target, async () => {
        active++;
        maxOverlap = Math.max(maxOverlap, active);
        await sleep(15);
        active--;
        return id;
      });
    const results = await Promise.all([task(1), task(2), task(3)]);
    check("mutex: all 3 completed", results.length === 3 && results.every((r) => typeof r === "number"));
    check("mutex: max concurrent holders = 1 (serialized)", maxOverlap === 1);
  }

  // --- 3. stale steal: a lockfile owned by a certainly-dead pid is taken over ---
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const target = path.join(dir, "t.txt");
    const lockPath = `${target}.lock`;
    // 99999999 > Linux pid_max (~4M), so kill(pid,0) → ESRCH → treated as dead.
    await writeFile(lockPath, "99999999\n", "utf-8");
    let ran = false;
    await withFileLock(target, async () => { ran = true; }, { pollMs: 5, timeoutMs: 1000 });
    check("stale: dead-pid lockfile stolen (fn ran)", ran);
    const remains = await stat(lockPath).then(() => true).catch(() => false);
    check("stale: lockfile released after fn", !remains);
  }

  // --- 4. timeout: a live (own-pid), recent lock blocks until timeoutMs, then throws ---
  {
    const dir = await mkdtemp(path.join(os.tmpdir(), "lock-"));
    const target = path.join(dir, "t.txt");
    const lockPath = `${target}.lock`;
    // Own pid (alive) + fresh mtime → neither dead nor stale → must not steal.
    await writeFile(lockPath, `${process.pid}\n`, "utf-8");
    let threw = false;
    const t0 = Date.now();
    try {
      await withFileLock(target, async () => {}, { pollMs: 5, timeoutMs: 40, staleMs: 60_000 });
    } catch (e) {
      threw = e instanceof LockTimeoutError;
    }
    const elapsed = Date.now() - t0;
    check("timeout: throws LockTimeoutError when live lock held", threw);
    check("timeout: waited ~>= timeoutMs before throwing (not instant)", elapsed >= 35);
    // Leftover lockfile must be untouched (we never acquired it).
    const leftover = await stat(lockPath).then(() => true).catch(() => false);
    check("timeout: did not clobber the held lockfile", leftover);
  }
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}).catch((e) => {
  console.error("TEST CRASHED:", e);
  process.exit(1);
});
