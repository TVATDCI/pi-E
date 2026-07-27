// extensions/memory/lock.ts — cross-process advisory file lock (W8).
//
// memory.md is mutated by TWO writers in DIFFERENT processes:
//   - compaction-capture.ts (the pi process, on `session_compact`)
//   - scripts/rotate-memory-md.ts (a separate operator-run process)
// Both do read-modify-write, so without coordination their windows overlap and the
// later writer clobbers the earlier one's change (lost update — e.g. a compaction
// capture appended during a rotation's read→write window vanishes). This serializes
// them via a cooperative lockfile so each read→write window is exclusive.
//
// No external deps (only node:fs/promises + node:timers/promises). Pattern
// (lockfile = `${target}.lock`):
//   - Acquire: open O_EXCL ('wx'), write `${pid}\n`.
//   - On EEXIST: stat the lockfile. Steal iff the holder PID is dead
//     (process.kill(pid,0) → ESRCH/EPERM) OR the lockfile mtime is older than
//     staleMs (holder presumed crashed — also covers a crash between the O_EXCL
//     create and the pid write, which leaves an empty file). Otherwise back off
//     for pollMs, retry until timeoutMs → throw LockTimeoutError.
//   - Release (finally): unlink, best-effort.
//
// Advisory/cooperative: protects only against callers that ALSO use withFileLock.
// memory.md's writer set is closed (exactly these two), so coverage is complete.

import { open, unlink, readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

export class LockTimeoutError extends Error {
  lockPath: string;
  constructor(lockPath: string, ms: number) {
    super(`withFileLock: timed out after ${ms}ms waiting for ${lockPath}`);
    this.name = "LockTimeoutError";
    this.lockPath = lockPath;
  }
}

export interface LockOptions {
  /** Max total wait before throwing LockTimeoutError. Default 10000. */
  timeoutMs?: number;
  /** Poll interval while contended. Default 25. */
  pollMs?: number;
  /** A lock whose file mtime is older than this (holder presumed crashed) is stealable. Default 60000. */
  staleMs?: number;
}

const DEFAULTS: Required<LockOptions> = {
  timeoutMs: 10_000,
  pollMs: 25,
  staleMs: 60_000,
};

/** True iff a process with this PID is alive and reachable via signal 0. */
function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return true;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe; throws ESRCH if dead, EPERM if not ours
    return true;
  } catch {
    return false;
  }
}

/** One acquisition attempt. Returns true if THIS caller now owns the lock. */
async function tryAcquire(lockPath: string, staleMs: number): Promise<boolean> {
  // Fast path: exclusive create.
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(`${process.pid}\n`);
    await fh.close();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // unexpected I/O error — surface it
  }
  // Exists — decide steal vs back-off.
  let mtimeMs = 0;
  let holderPid = 0;
  try {
    const st = await stat(lockPath);
    mtimeMs = st.mtimeMs;
    const txt = await readFile(lockPath, "utf-8");
    holderPid = Number(txt.split("\n")[0]);
  } catch {
    return false; // raced away or unreadable — back off, retry
  }
  const lockIsOld = Date.now() - mtimeMs > staleMs;
  const holderIsDead = holderPid > 0 && !pidAlive(holderPid);
  if (!lockIsOld && !holderIsDead) return false;
  // Steal: unlink then O_EXCL recreate. If another process grabbed it in the gap,
  // our O_EXCL fails (EEXIST) and we return false — no double-ownership.
  try {
    await unlink(lockPath);
  } catch {
    /* raced; fine */
  }
  try {
    const fh = await open(lockPath, "wx");
    await fh.writeFile(`${process.pid}\n`);
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding an exclusive cross-process lock on `targetPath`.
 * The lockfile is `${targetPath}.lock`. Always releases on settle (resolve or reject).
 * `fn`'s return value (or rejection) propagates to the caller.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const o = { ...DEFAULTS, ...opts };
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + o.timeoutMs;
  while (true) {
    if (await tryAcquire(lockPath, o.staleMs)) break;
    if (Date.now() >= deadline) throw new LockTimeoutError(lockPath, o.timeoutMs);
    await sleep(o.pollMs);
  }
  try {
    return await fn();
  } finally {
    try {
      await unlink(lockPath);
    } catch {
      /* best-effort; a concurrent steal may have already removed it */
    }
  }
}
