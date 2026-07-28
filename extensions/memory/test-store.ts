// Tier 2 test for store.ts. Run: node --experimental-strip-types test-store.ts
// Exercises: insert/recall, dedup, persistence (two-session E2E), secret rejection,
// inferred->fact downgrade, provenance write-guard (plain + downgrade+guard), trust
// upgrade (asymmetry), rename-failure self-heal (compactDrop), malformed-line skip,
// audit log, forget, snapshot/search, in-process parallel appends, append-only dedup-on-read,
// and cross-PROCESS survival (W8b acceptance: two writers, both survive).
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { JsonlMemoryStore, SecretDetectedError } from "./store.ts";
import type { StoreOptions } from "./store.ts";
import type { MemoryRecord } from "./schema.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

function rec(partial: Partial<MemoryRecord> & { key: string; value: string }): MemoryRecord {
  return {
    schemaVersion: 1, scope: "global", category: "fact", provenance: "operator",
    turn: 1, recordedAt: 1000, ...partial,
  };
}

async function fresh(suffix: string, opts?: { rename?: StoreOptions["rename"] }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mem-"));
  const filePath = path.join(dir, `s-${suffix}.jsonl`);
  const auditLogPath = path.join(dir, `a-${suffix}.log`);
  const store = new JsonlMemoryStore({ filePath, auditLogPath, rename: opts?.rename });
  return { store, filePath, auditLogPath, dir };
}

/** Spawn a `node` subprocess running procPath with args; resolve trimmed stdout. */
function runProc(procPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("node", ["--experimental-strip-types", procPath, ...args], {});
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`proc exit ${code}: ${err.trim()}`))));
  });
}

async function main() {
  // Cross-process helper script (subprocess tests §15/§16). Written once to a temp file;
  // each subprocess test uses a FRESH data filePath (isolation, no cross-test contamination).
  const STORE_ABS = new URL("./store.ts", import.meta.url).pathname;
  const procDir = await fs.mkdtemp(path.join(os.tmpdir(), "w8b-proc-"));
  const procPath = path.join(procDir, "proc.ts");
  const procSrc = `import { JsonlMemoryStore } from ${JSON.stringify(STORE_ABS)};
const a = process.argv.slice(2);
const s = new JsonlMemoryStore({ filePath: a[1] });
await s.init();
if (a[0] === 'write') {
  await s.remember({ schemaVersion: 1, scope: 'global', category: 'fact', key: a[2], value: a[3], provenance: 'operator', turn: 1, recordedAt: Date.now() });
  console.log('OK ' + a[2]);
} else if (a[0] === 'forget') {
  await s.forget('global', 'fact', a[2]);
  console.log('FORGOT ' + a[2]);
} else if (a[0] === 'read') {
  const snap = await s.snapshot({ scopes: ['global'] });
  console.log(JSON.stringify(snap.map(function (r) { return r.key + '=' + r.value; }).sort()));
}
`;
  await fs.writeFile(procPath, procSrc, "utf8");

  // --- 1. insert + recall ---
  {
    const { store } = await fresh("insert");
    await store.init();
    await store.remember(rec({ key: "uses_jwt", value: "Auth uses JWT." }));
    const got = await store.recall("global", "fact", "uses_jwt");
    check("insert + recall returns the record", got !== null && got.value === "Auth uses JWT.");
    check("recall miss returns null", (await store.recall("global", "fact", "nope")) === null);
  }

  // --- 2. dedup / update (keyed upsert superpower) ---
  {
    const { store } = await fresh("dedup");
    await store.init();
    const r1 = await store.remember(rec({ key: "k", value: "first", recordedAt: 1000 }));
    const r2 = await store.remember(rec({ key: "k", value: "second", recordedAt: 2000 }));
    check("dedup: first insert -> inserted", r1.action === "inserted");
    check("dedup: second write -> updated", r2.action === "updated");
    const snap = await store.snapshot({ scopes: ["global"] });
    check("dedup: exactly one record", snap.length === 1);
    check("dedup: value is the latest", snap[0].value === "second");
  }

  // --- 3. persistence: two-session E2E (close -> new store -> init -> snapshot) ---
  {
    const { store, filePath } = await fresh("persist");
    await store.init();
    await store.remember(rec({ key: "a", value: "alpha", category: "constraint" }));
    await store.remember(rec({ key: "b", value: "beta", category: "fact" }));
    await store.close();
    // Simulate a new session opening the same file.
    const session2 = new JsonlMemoryStore({ filePath });
    await session2.init();
    const snap = await session2.snapshot({ scopes: ["global"] });
    check("persistence: both records survive restart", snap.length === 2);
    const a = await session2.recall("global", "constraint", "a");
    check("persistence: record a intact", a !== null && a.value === "alpha");
    const b = await session2.recall("global", "fact", "b");
    check("persistence: record b intact", b !== null && b.value === "beta");
  }

  // --- 4. secret rejection (E1) ---
  {
    const { store } = await fresh("secret");
    await store.init();
    let threw = false;
    try {
      await store.remember(rec({ key: "creds", value: "aws key AKIAIOSFODNN7EXAMPLE here" }));
    } catch (e) {
      threw = e instanceof SecretDetectedError;
    }
    check("secret: SecretDetectedError thrown", threw);
    const snap = await store.snapshot({ scopes: ["global"] });
    check("secret: nothing stored", snap.length === 0);
  }

  // --- 5. inferred->fact downgrade (E2.1) ---
  {
    const { store } = await fresh("downgrade");
    await store.init();
    const outcome = await store.remember(
      rec({ key: "no_any", value: "never use any", category: "constraint", provenance: "inferred" }),
    );
    check("downgrade: outcome is inserted/updated", outcome.action === "inserted" || outcome.action === "updated");
    const stored = outcome.action === "inserted" ? outcome.record : (outcome as { record: MemoryRecord }).record;
    check("downgrade: stored category is fact", stored.category === "fact");
    check("downgrade: stored provenance stays inferred", stored.provenance === "inferred");
    const got = await store.recall("global", "fact", "no_any");
    check("downgrade: recall under fact key works", got !== null);
    const underConstraint = await store.recall("global", "constraint", "no_any");
    check("downgrade: nothing under constraint key", underConstraint === null);
  }

  // --- 6. provenance write-guard: inferred cannot overwrite operator (plain) ---
  {
    const { store } = await fresh("guard");
    await store.init();
    await store.remember(rec({ key: "k", value: "operator truth", category: "fact", provenance: "operator" }));
    const result = await store.remember(
      rec({ key: "k", value: "inferred attempt", category: "fact", provenance: "inferred" }),
    );
    check("guard: inferred-over-operator is skipped", result.action === "skipped_inferred_over_operator");
    const got = await store.recall("global", "fact", "k");
    check("guard: operator record unchanged", got !== null && got.value === "operator truth" && got.provenance === "operator");
  }

  // --- 7. write-guard with downgrade interaction: inferred constraint (->fact) cannot overwrite operator fact ---
  {
    const { store } = await fresh("guard-dg");
    await store.init();
    await store.remember(rec({ key: "k", value: "operator fact", category: "fact", provenance: "operator" }));
    const result = await store.remember(
      rec({ key: "k", value: "inferred never", category: "constraint", provenance: "inferred" }),
    );
    check("guard+downgrade: inferred constraint over operator fact skipped", result.action === "skipped_inferred_over_operator");
    const got = await store.recall("global", "fact", "k");
    check("guard+downgrade: operator fact intact", got !== null && got.value === "operator fact");
  }

  // --- 8. trust upgrade (asymmetry): operator CAN overwrite inferred ---
  {
    const { store } = await fresh("upgrade");
    await store.init();
    await store.remember(rec({ key: "k", value: "guessed", category: "fact", provenance: "inferred" }));
    const result = await store.remember(
      rec({ key: "k", value: "confirmed", category: "fact", provenance: "operator" }),
    );
    check("upgrade: operator-over-inferred allowed (updated)", result.action === "updated");
    const got = await store.recall("global", "fact", "k");
    check("upgrade: record now operator-confirmed", got !== null && got.value === "confirmed" && got.provenance === "operator");
  }

  // --- 9. rename-failure self-heal (RETARGETED: the rename now lives in compactDrop/forget, not remember) ---
  {
    const { store: s1, filePath } = await fresh("crash");
    await s1.init();
    await s1.remember(rec({ key: "persisted", value: "before crash" }));
    await s1.remember(rec({ key: "keeper", value: "survives" }));
    await s1.close();
    // Open with a rename that always throws. forget() -> compactDrop -> tmp+rename throws.
    const failing = new JsonlMemoryStore({
      filePath,
      rename: async () => { throw new Error("rename failed (simulated)"); },
    });
    await failing.init();
    let threw = false;
    try {
      await failing.forget("global", "fact", "persisted");
    } catch {
      threw = true;
    }
    check("rename-failure: forget throws", threw);
    // Self-heal: the compaction rewrite did not land -> disk unchanged. A fresh store sees
    // BOTH records (forget not persisted); the lock was released via finally (no orphan .lock).
    const healed = new JsonlMemoryStore({ filePath });
    await healed.init();
    const snap = await healed.snapshot({ scopes: ["global"] });
    check("rename-failure: disk unchanged (both records present)", snap.length === 2);
    const got = await healed.recall("global", "fact", "persisted");
    check("rename-failure: target survived (forget not persisted)", got !== null && got.value === "before crash");
    const lockOrphan = await fs.stat(`${filePath}.lock`).then(() => true).catch(() => false);
    check("rename-failure: lock released (no orphan .lock)", !lockOrphan);
  }

  // --- 10. malformed-line skip+log (Momus M4) ---
  {
    const { dir } = await fresh("malformed");
    const filePath = path.join(dir, "mixed.jsonl");
    // One good line, one garbage line, one good line.
    const good1 = JSON.stringify(rec({ key: "g1", value: "good one" }));
    const good2 = JSON.stringify(rec({ key: "g2", value: "good two" }));
    await fs.writeFile(filePath, `${good1}\nTHIS IS GARBAGE\n${good2}\n`, "utf8");
    const store = new JsonlMemoryStore({ filePath });
    await store.init();
    const snap = await store.snapshot({ scopes: ["global"] });
    check("malformed: 2 good records loaded", snap.length === 2);
    check("malformed: g1 present", (await store.recall("global", "fact", "g1")) !== null);
    check("malformed: g2 present", (await store.recall("global", "fact", "g2")) !== null);
  }

  // --- 11. audit log written ---
  {
    const { store, auditLogPath } = await fresh("audit");
    await store.init();
    await store.remember(rec({ key: "k", value: "audited value" }));
    const log = await fs.readFile(auditLogPath, "utf8");
    check("audit: contains INSERT action", log.includes("INSERT"));
    check("audit: contains the key", log.includes("global:fact:k"));
    check("audit: contains (truncated) value", log.includes("audited value"));
  }

  // --- 12. forget ---
  {
    const { store } = await fresh("forget");
    await store.init();
    await store.remember(rec({ key: "temp", value: "bye" }));
    const removed = await store.forget("global", "fact", "temp");
    check("forget: returns true when removed", removed === true);
    check("forget: recall returns null", (await store.recall("global", "fact", "temp")) === null);
    const removedAgain = await store.forget("global", "fact", "temp");
    check("forget: returns false when absent", removedAgain === false);
  }

  // --- 13. snapshot + search ---
  {
    const { store } = await fresh("query");
    await store.init();
    await store.remember(rec({ key: "a", value: "Auth uses JWT" }));
    await store.remember(rec({ key: "b", value: "DB is postgres" }));
    const snap = await store.snapshot({ scopes: ["global"] });
    check("snapshot: 2 records", snap.length === 2);
    const hits = await store.search("jwt", { scopes: ["global"] });
    check("search: 'jwt' matches 1", hits.length === 1 && hits[0].key === "a");
    const none = await store.search("redis", { scopes: ["global"] });
    check("search: 'redis' matches 0", none.length === 0);
  }

  // --- 14. in-process parallel appends (W18 race retired via append-only + lock) ---
  {
    const N = 25;
    const { store, filePath } = await fresh("concurrent");
    await store.init();
    // Fire N parallel remembers. Append-only + withFileLock serializes them (no shared .tmp
    // on the write path; W18's rename race is retired). All appends land.
    const outcomes = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.remember(rec({ key: `k${i}`, value: `value-${i}` })),
      ),
    );
    check("concurrent: Promise.all resolves (no throw)", outcomes.length === N);
    const snap = await store.snapshot({ scopes: ["global"] });
    check(`concurrent: all ${N} records in memory`, snap.length === N);
    // Persistence: re-open from disk and confirm every record survived the writes.
    const reopened = new JsonlMemoryStore({ filePath });
    await reopened.init();
    let allOnDisk = true;
    for (let i = 0; i < N; i++) {
      const got = await reopened.recall("global", "fact", `k${i}`);
      if (got === null || got.value !== `value-${i}`) { allOnDisk = false; break; }
    }
    check("concurrent: all records persisted to disk", allOnDisk);
  }

  // --- 15. append-only dedup-on-read (latest line wins at init) ---
  {
    const { store, filePath } = await fresh("dedup-read");
    await store.init();
    await store.remember(rec({ key: "k", value: "first", recordedAt: 1000 }));
    await store.remember(rec({ key: "k", value: "second", recordedAt: 2000 }));
    // Two append lines for key k; a fresh init must keep the LATEST (second).
    const reread = new JsonlMemoryStore({ filePath });
    await reread.init();
    const got = await reread.recall("global", "fact", "k");
    check("dedup-on-read: fresh init keeps the latest line (second)", got !== null && got.value === "second");
    const snap = await reread.snapshot({ scopes: ["global"] });
    check("dedup-on-read: exactly one record for k", snap.length === 1);
  }

  // --- 16. cross-PROCESS survival (THE W8b acceptance: two writers, both survive) ---
  // In-process Promise.all cannot exercise cross-PID lock behavior; these spawn real `node`
  // subprocesses, each its own JsonlMemoryStore on the SAME fresh filePath.
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "w8b-cross-")); // fresh per test (isolation)
    const filePath = path.join(dir, "cross.jsonl");
    const [out1, out2] = await Promise.all([
      runProc(procPath, ["write", filePath, "z", "from-A"]),
      runProc(procPath, ["write", filePath, "w", "from-B"]),
    ]);
    const readOut = await runProc(procPath, ["read", filePath]);
    const keys = JSON.parse(readOut) as string[];
    check("cross-process: writer A reported OK", out1 === "OK z");
    check("cross-process: writer B reported OK", out2 === "OK w");
    check("cross-process: BOTH z and w survive in store.jsonl (acceptance #5)", keys.includes("z=from-A") && keys.includes("w=from-B"));
  }

  // --- 17. forget-vs-append across processes (deterministic: both lock -> no clobber) ---
  // The v1 lockless-append design flaked here (append could land in forget's read->rename
  // window). With both paths under withFileLock, serialization makes it deterministic.
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "w8b-fa-")); // fresh per test (isolation)
    const filePath = path.join(dir, "fa.jsonl");
    await runProc(procPath, ["write", filePath, "k", "seed"]);
    await runProc(procPath, ["write", filePath, "keep", "keeper"]);
    await Promise.all([
      runProc(procPath, ["forget", filePath, "k"]), // compaction (locked)
      runProc(procPath, ["write", filePath, "w", "concurrent"]), // append (locked)
    ]);
    const readOut = await runProc(procPath, ["read", filePath]);
    const keys = JSON.parse(readOut) as string[];
    check("forget-vs-append: 'w' survived (not clobbered by compaction)", keys.includes("w=concurrent"));
    check("forget-vs-append: 'k' was forgotten", !keys.includes("k=seed"));
    check("forget-vs-append: 'keep' survived", keys.includes("keep=keeper"));
  }
}

main().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}).catch((e) => {
  console.error("TEST CRASHED:", e);
  process.exit(1);
});
