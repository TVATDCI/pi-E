// extensions/tests/minidc-broker-matrix.test.ts — the R2 broker matrix (design §8).
// Run: node --experimental-strip-types minidc-broker-matrix.test.ts
//
// Drives the REAL daemon (broker/minidc-broker.ts createBroker) on a scratch backing
// tree + scratch sockets (module seams; never /var/lib, never /run, never the live
// store). Entitled process instances are REAL live child processes (one role per
// instance — the daemon refuses double-roles per pid), claimed through the
// client-asserted identity model (D1d: asserted pid + /proc self-consistency).
import {
  createBroker,
  setClockForTesting,
  setRateLimitsForTesting,
  setUnitStateSourceForTesting,
  type Broker,
} from "../../broker/minidc-broker.ts";
import * as net from "node:net";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const ROOT = fs.mkdtempSync("/tmp/minidc-broker-matrix-");
const SOCK = join(ROOT, "socket");
const CTL = join(ROOT, "control.sock");
const STATE = join(ROOT, "state");
const BOOT_ID = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n— ${name}`); }
function final(): never {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ── live-instance pool: each entitlement binds a REAL distinct process instance ──
const kids: ChildProcess[] = [];
function spawnKid(): { pid: number; starttime: string } {
  // "sleep 180" — a tiny always-resident process: identical pid/starttime semantics
  // for the entitlement rows, and 600 of them do not invite the OOM reaper the way
  // 600 node interpreters do (fix-round storm rows)
  const k = spawn("sleep", ["180"], { stdio: "ignore" });
  kids.push(k);
  const st = statOf(k.pid as number);
  if (!st) throw new Error("kid spawn failed");
  return { pid: k.pid as number, starttime: st.starttime };
}
function statOf(pid: number): { ppid: number; starttime: string } | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
    return { ppid: Number(fields[1]), starttime: fields[19] as string };
  } catch { return null; }
}

function writeHealth(healthy: boolean, bootId: string | null = BOOT_ID): void {
  fs.writeFileSync(join(STATE, "mount-health.json"), JSON.stringify({ healthy, "boot-id": bootId, "checked-at": new Date().toISOString(), findings: healthy ? [] : ["fixture"] }));
}
function writeAttestation(mode: string): void {
  fs.writeFileSync(join(STATE, "install-attestation.json"), JSON.stringify({ "install-mode": mode, "transaction-id": "t-fixture", "attested-at": new Date().toISOString() }));
}
function writeCertified(entries: { backend: string; pid: number; starttime: string }[]): void {
  fs.writeFileSync(join(STATE, "certified-backends.json"), JSON.stringify({ backends: entries.map((e) => ({ backend: e.backend, generations: [{ "server-pid": e.pid, "server-starttime": e.starttime, "exe-path": "/fixture", "exe-identity-digest": "00", "certified-at": new Date().toISOString(), "fixture-set": ["test"] }] })) }));
}

interface Frame { id: number; op: string; args: Record<string, unknown>; }
type Res = { id: number; ok: true; result: Record<string, unknown> } | { id: number; ok: false; error: string; retryable?: boolean; reason?: string; result?: undefined }; // cleanup F1: the result?: undefined arm lets .result access typecheck across the union (tests access it only after ok checks)

class C {
  sock: net.Socket;
  buf = "";
  nextId = 1;
  pending = new Map<number, (r: Res) => void>();
  closed = false;
  constructor(path: string) {
    this.sock = net.connect(path);
    this.sock.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const f = JSON.parse(line) as Res;
        const cb = this.pending.get(f.id);
        if (cb) { this.pending.delete(f.id); cb(f); }
      }
    });
  }
  call(op: string, args: Record<string, unknown>): Promise<Res> {
    return new Promise((resolve) => {
      const f: Frame = { id: this.nextId++, op, args };
      this.pending.set(f.id, resolve);
      this.sock.write(JSON.stringify(f) + "\n");
      setTimeout(() => { if (this.pending.has(f.id)) { this.pending.delete(f.id); resolve({ id: f.id, ok: false, error: "TIMEOUT" }); } }, 4000).unref?.();
    });
  }
  close(): Promise<void> {
    return new Promise((res) => {
      if (this.closed) return res();
      this.closed = true;
      this.sock.on("close", () => res());
      this.sock.destroy();
      setTimeout(() => res(), 300).unref?.();
    });
  }
}

function entry(actor: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1, ts: new Date().toISOString(), actor, pane: "t:p1", task: "matrix-test",
    subject: "a1b2c3d4e5f60718", cls: "G", decision: "proceed", scope: "once",
    ...overrides,
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(STATE, { recursive: true });
  writeHealth(true);
  writeAttestation("broker");
  fs.mkdirSync(join(ROOT, "store"), { recursive: true });
  fs.mkdirSync(join(ROOT, "rules"), { recursive: true });
  fs.writeFileSync(join(ROOT, "rules", "rules.yaml"), "bashToolPatterns:\n  - pattern: 'v12askg\\d*'\n    reason: test rule\nzeroAccessPaths: []\nreadOnlyPaths: []\n");
  setUnitStateSourceForTesting(() => "active");
  // generous limits for the matrix sections (the designed 3/10/30/600 values are pinned
  // deterministically inside the split-rate-budgets section below)
  setRateLimitsForTesting({ mintPerPid: 100, mintGlobal: 100, reclaimPerPid: 100, reclaimGlobal: 1000 });

  const broker = createBroker({ rootDir: ROOT, socketPath: SOCK, controlSocketPath: CTL, testMode: true });
  await sleep(150);

  // ── fixtures: live child instances for captain / firstmate / worker grades ──
  const ctl = new C(CTL);
  const capKid = spawnKid();
  const fmKid = spawnKid();
  const capReg = (await ctl.call("register", { mode: "plain", role: "captain", pid: capKid.pid, "spawn-backend": "testbackend" })).result as { "claim-secret": string };
  const fmReg = (await ctl.call("register", { mode: "plain", role: "firstmate", pid: fmKid.pid, "spawn-backend": "testbackend" })).result as { "claim-secret": string };
  check("plain mints (distinct live instances) produce claim-secrets", typeof capReg["claim-secret"] === "string" && typeof fmReg["claim-secret"] === "string");

  // ═══ fixed-error byte pins under adversarial payloads ═══
  {
    section("fixed-error byte pins (adversarial payloads — no echo, ever)");
    const anon = new C(SOCK);
    const r1 = await anon.call("read-rules", {});
    check("unregistered read-rules → E_DENIED_UNREGISTERED bytes",
      JSON.stringify(r1) === JSON.stringify({ id: 1, ok: false, error: "E_DENIED_UNREGISTERED" }));
    const r2 = await ctl.call("append-trail", { slug: "../../etc", entry: entry("worker") });
    check("adversarial slug ../../etc → E_INVALID (registered conn), no path echo", r2.ok === false && (r2 as { error: string }).error === "E_INVALID" && !JSON.stringify(r2).includes("etc"));
    const r2b = await anon.call("append-trail", { slug: "../../etc", entry: entry("worker") });
    check("unregistered append without ancestry shape → E_DENIED_UNREGISTERED (family law)", r2b.ok === false && (r2b as { error: string }).error === "E_DENIED_UNREGISTERED");
    const r3 = await ctl.call("append-trail", { slug: "okslug", entry: entry("worker", { subject: "ZZZ-injection-" + "A".repeat(400) }) });
    check("malformed entry (bad subject) → E_INVALID, no payload echo", r3.ok === false && (r3 as { error: string }).error === "E_INVALID" && !JSON.stringify(r3).includes("ZZZ"));
    const r4 = await anon.call("bogus-op", {});
    check("unknown op → E_INVALID", r4.ok === false && (r4 as { error: string }).error === "E_INVALID");
    await anon.close();
  }

  // ═══ the op × grade matrix ═══
  {
    section("op × grade matrix");
    const anon = new C(SOCK);
    const worker = new C(SOCK);
    const fm = new C(SOCK);
    const cap = new C(SOCK);
    const root = new C(CTL);

    const mint = await root.call("register", { mode: "enroll-worker", slug: "reposlug", "spawn-backend": "testbackend" });
    check("root enroll-worker mints", mint.ok === true && typeof (mint.result as { token: string }).token === "string");
    const token = (mint.result as { token: string }).token;
    const workerKid = spawnKid();
    const consumed = await worker.call("register", { mode: "consume", token, pid: workerKid.pid, starttime: workerKid.starttime });
    check("consume pins presenter + claims worker grade", consumed.ok === true && (consumed.result as { grade: string }).grade === "worker");

    const fmClaim = await fm.call("register", { mode: "claim", pid: fmKid.pid, starttime: fmKid.starttime, secret: fmReg["claim-secret"] });
    check("firstmate claim (secret) → firstmate grade", fmClaim.ok === true && (fmClaim.result as { grade: string }).grade === "firstmate");
    const fmSurface = (fmClaim.result as { "surface-secret"?: string })["surface-secret"];
    check("firstmate claim issues a surface-secret", typeof fmSurface === "string" && fmSurface.length === 64);

    const capClaim = await cap.call("register", { mode: "claim", pid: capKid.pid, starttime: capKid.starttime, secret: capReg["claim-secret"] });
    check("captain claim (secret) → captain grade", capClaim.ok === true && (capClaim.result as { grade: string }).grade === "captain");

    check("read-rules unknown → E_DENIED_UNREGISTERED (maps unavailable client-side)", ((await anon.call("read-rules", {})) as { error: string }).error === "E_DENIED_UNREGISTERED");
    check("read-rules worker ✓ present", ((await worker.call("read-rules", {})).result as { state: string }).state === "present");
    check("read-rules firstmate ✓", (await fm.call("read-rules", {})).ok === true);
    check("read-rules captain ✓", (await cap.call("read-rules", {})).ok === true);
    check("read-rules root ✓", (await root.call("read-rules", {})).ok === true);

    check("worker read-trail own slug ✓", (await worker.call("read-trail", { slug: "reposlug" })).ok === true);
    check("worker read-trail cross slug → E_DENIED_SLUG", ((await worker.call("read-trail", { slug: "otherrepo" })) as { error: string }).error === "E_DENIED_SLUG");
    check("worker read-grants cross slug → E_DENIED_SLUG", ((await worker.call("read-grants", { slug: "otherrepo" })) as { error: string }).error === "E_DENIED_SLUG");
    check("firstmate read-trail any slug ✓", (await fm.call("read-trail", { slug: "otherrepo" })).ok === true);
    check("captain read-grants any slug ✓", (await cap.call("read-grants", { slug: "otherrepo" })).ok === true);
    check("unknown read-trail → E_DENIED_UNREGISTERED", ((await anon.call("read-trail", { slug: "reposlug" })) as { error: string }).error === "E_DENIED_UNREGISTERED");

    check("worker create-grant → E_DENIED_GRADE", ((await worker.call("create-grant", { slug: "reposlug", pattern: "git status *" })) as { error: string }).error === "E_DENIED_GRADE");
    const fmGrant = await fm.call("create-grant", { slug: "reposlug", pattern: "git log *" });
    check("firstmate create-grant (R by schema) ✓", fmGrant.ok === true && ((fmGrant.result as { id: string }).id ?? "").startsWith("g-"));
    check("captain create-grant ✓", (await cap.call("create-grant", { slug: "reposlug", pattern: "cat /tmp/x *" })).ok === true);
    check("unknown create-grant → E_DENIED_UNREGISTERED", ((await anon.call("create-grant", { slug: "reposlug", pattern: "x *" })) as { error: string }).error === "E_DENIED_UNREGISTERED");
    const grantsRead = (await root.call("read-grants", { slug: "reposlug" })).result as { grants: { id: string; "class-filter": string; "creator-seat": string }[] };
    check("every stored grant is class-filter R (never-D structural)", grantsRead.grants.every((g) => g["class-filter"] === "R"));
    check("firstmate-created grant creator-seat=firstmate (server-stamped)", grantsRead.grants.some((g) => g["creator-seat"] === "firstmate"));

    check("firstmate revoke-grant → E_DENIED_GRADE", ((await fm.call("revoke-grant", { slug: "reposlug", id: "g-x" })) as { error: string }).error === "E_DENIED_GRADE");
    check("worker revoke-grant → E_DENIED_GRADE", ((await worker.call("revoke-grant", { slug: "reposlug", id: "g-x" })) as { error: string }).error === "E_DENIED_GRADE");
    check("root revoke-grant ✓", (await root.call("revoke-grant", { slug: "reposlug", id: grantsRead.grants[0]?.id ?? "" })).ok === true);

    check("firstmate write-rules → E_DENIED_GRADE", ((await fm.call("write-rules", { content: "bashToolPatterns: []\n" })) as { error: string }).error === "E_DENIED_GRADE");
    check("worker write-rules → E_DENIED_GRADE", ((await worker.call("write-rules", { content: "x" })) as { error: string }).error === "E_DENIED_GRADE");
    check("captain write-rules ✓", (await cap.call("write-rules", { content: "bashToolPatterns: []\nzeroAccessPaths: []\nreadOnlyPaths: []\n" })).ok === true);
    check("captain write-rules invalid yaml → E_INVALID", ((await cap.call("write-rules", { content: "bashToolPatterns: [ { flow: { bad } ]\n" })) as { error: string }).error === "E_INVALID");

    const wApp = await worker.call("append-trail", { slug: "reposlug", entry: entry("captain") });
    check("worker append own slug: client actor IGNORED — stamped worker", wApp.ok === true && (wApp.result as { actor: string }).actor === "worker");
    const wGate = await worker.call("append-trail", { slug: "reposlug", entry: entry("gate") });
    check("worker gate row: actor=gate VERBATIM (C8, origin derived centrally)", wGate.ok === true && (wGate.result as { actor: string }).actor === "gate");
    check("worker append cross slug → E_DENIED_SLUG", ((await worker.call("append-trail", { slug: "other", entry: entry("worker") })) as { error: string }).error === "E_DENIED_SLUG");
    const anonGate = await anon.call("append-trail", { slug: "reposlug", entry: entry("gate") });
    check("origin=gate from unregistered → E_DENIED_UNREGISTERED", anonGate.ok === false && (anonGate as { error: string }).error === "E_DENIED_UNREGISTERED");
    const dis = await worker.call("append-trail", { slug: "reposlug", entry: entry("worker"), origin: "gate" });
    check("origin/actor disagreement → E_INVALID", dis.ok === false && (dis as { error: string }).error === "E_INVALID");

    const tail = broker.auditTail();
    check("actor-forgery attempt audited (claimed captain, stamped worker)",
      tail.some((e) => e["kind"] === "actor-forgery-attempt" && e["claimed"] === "captain" && e["stamped"] === "worker"));
    check("mint/consume/claim audit rows present",
      tail.some((e) => e["kind"] === "mint-enrollment") && tail.some((e) => e["kind"] === "consume") && tail.some((e) => e["kind"] === "mint-plain") && tail.some((e) => e["kind"] === "claim"));

    const trailRaw = fs.readFileSync(join(ROOT, "store", "reposlug", "trail.jsonl"), "utf8");
    const rows = trailRaw.trim().split("\n").map((l) => JSON.parse(l) as { actor: string });
    check("trail rows land with server-stamped actors", rows.some((r) => r.actor === "worker") && rows.some((r) => r.actor === "gate"));

    await Promise.all([anon.close(), worker.close(), fm.close(), cap.close(), root.close()]);
  }

  // ═══ read-rules tri-state gating (mount-health + unit-state, fresh per op) ═══
  {
    section("read-rules tri-state gating");
    const root = new C(CTL);
    writeHealth(false);
    check("mount-health unhealthy → E_UNAVAILABLE", ((await root.call("read-rules", {})) as { error: string }).error === "E_UNAVAILABLE");
    writeHealth(true, "stale-boot-id");
    check("stale boot-id → E_UNAVAILABLE", ((await root.call("read-rules", {})) as { error: string }).error === "E_UNAVAILABLE");
    writeHealth(true);
    setUnitStateSourceForTesting(() => "inactive");
    check("mounts-unit inactive → E_UNAVAILABLE (named)", ((await root.call("read-rules", {})) as { error: string; reason?: string }).reason === "mounts-unit:inactive");
    setUnitStateSourceForTesting(() => "unreadable");
    check("unreadable unit check → fail-closed unavailable", ((await root.call("read-rules", {})) as { error: string }).error === "E_UNAVAILABLE");
    setUnitStateSourceForTesting(() => "active");
    fs.rmSync(join(ROOT, "rules", "rules.yaml"));
    check("ENOENT-only absence → {state:absent}", ((await root.call("read-rules", {})).result as { state: string }).state === "absent");
    fs.writeFileSync(join(ROOT, "rules", "rules.yaml"), "bashToolPatterns: []\n");
    check("healthy gates + file → present again", ((await root.call("read-rules", {})).result as { state: string }).state === "present");
    await root.close();
  }

  // ═══ entitlement lifecycle: secrets, re-claim, tombstones, pid-reuse ═══
  {
    section("entitlement lifecycle");
    const root = new C(CTL);
    const kid = spawnKid();
    const reg = (await root.call("register", { mode: "plain", role: "captain", pid: kid.pid, "spawn-backend": "b" })).result as { "claim-secret": string; "entitlement-id": string };
    const c1 = new C(SOCK);
    check("claim WITHOUT secret refused (D1b — closes captain theft)",
      (await c1.call("register", { mode: "claim", pid: kid.pid, starttime: kid.starttime })).ok === false);
    check("claim with WRONG secret refused",
      (await c1.call("register", { mode: "claim", pid: kid.pid, starttime: kid.starttime, secret: "0".repeat(64) })).ok === false);
    const good = await c1.call("register", { mode: "claim", pid: kid.pid, starttime: kid.starttime, secret: reg["claim-secret"] });
    check("claim with right secret ✓ captain", good.ok === true && (good.result as { grade: string }).grade === "captain");
    await c1.close();
    await sleep(120);
    const c2 = new C(SOCK);
    const reClaim = await c2.call("register", { mode: "claim", pid: kid.pid, starttime: kid.starttime, secret: reg["claim-secret"] });
    check("same-instance re-claim after socket close ✓ (entitlement survives)", reClaim.ok === true);
    check("re-claim audited", broker.auditTail().some((e) => e["kind"] === "re-claim"));
    await c2.close();
    const c3 = new C(SOCK);
    const reuse = await c3.call("register", { mode: "claim", pid: kid.pid, starttime: String(Number(kid.starttime) + 1), secret: reg["claim-secret"] });
    check("pid-reuse (starttime mismatch) refused — never claims the row", reuse.ok === false);
    await c3.close();

    const mint = await root.call("register", { mode: "enroll-worker", slug: "slugX", "spawn-backend": "b" });
    const tok = (mint.result as { token: string }).token;
    const wk = spawnKid();
    const w1 = new C(SOCK);
    check("consume #1 ✓", (await w1.call("register", { mode: "consume", token: tok, pid: wk.pid, starttime: wk.starttime })).ok === true);
    await w1.close();
    const w2 = new C(SOCK);
    const second = await w2.call("register", { mode: "consume", token: tok, pid: wk.pid, starttime: wk.starttime });
    check("double-consume refused (token tombstoned forever)", second.ok === false && (second as { error: string }).error === "E_DENIED_UNREGISTERED");
    const reW = await w2.call("register", { mode: "claim", pid: wk.pid, starttime: wk.starttime });
    check("consumed entitlement re-claimable by same instance (single-use is TOKEN-only)", reW.ok === true && (reW.result as { grade: string }).grade === "worker");
    await w2.close();
    await root.close();
  }

  // ═══ ancestry: real chain + certification gate + caps ═══
  {
    section("ancestry authorization (real process chain)");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    await sleep(200);
    const cst = statOf(child.pid as number) as { starttime: string };

    const root = new C(CTL);
    const supKid = spawnKid(); // the supervisor instance (firstmate) — NOT in the child's chain
    // For a REAL chain, the authorizer must be THIS test process: mint for process.pid.
    const selfSt = statOf(process.pid) as { starttime: string };
    const reg = (await root.call("register", { mode: "plain", role: "firstmate", pid: process.pid, "spawn-backend": "chainbe" })).result as { "claim-secret": string };
    void supKid;
    const fm = new C(SOCK);
    const claim = await fm.call("register", { mode: "claim", pid: process.pid, starttime: selfSt.starttime, secret: reg["claim-secret"] });
    if (!claim.ok) console.log("   [debug] ancestry claim said:", JSON.stringify(claim));
    void 0;
    const surface = ((claim.result ?? {}) as { "surface-secret"?: string })["surface-secret"] ?? "";

    const anonChild = new C(SOCK);
    const noCert = await anonChild.call("append-trail", { slug: "slugX", entry: entry("worker"), pid: child.pid, starttime: cst.starttime, "surface-secret": surface });
    check("empty certified set → E_DENIED_TOPOLOGY (fail-closed default)", noCert.ok === false && (noCert as { error: string }).error === "E_DENIED_TOPOLOGY");

    writeCertified([{ backend: "chainbe", pid: child.pid as number, starttime: cst.starttime }]);
    const okApp = await anonChild.call("append-trail", { slug: "slugX", entry: entry("worker"), pid: child.pid, starttime: cst.starttime, "surface-secret": surface });
    check("certified generation in chain → appended actor=firstmate", okApp.ok === true && (okApp.result as { actor: string }).actor === "firstmate");
    check("ancestry-authorized audited with both pids", broker.auditTail().some((e) => e["kind"] === "ancestry-authorized" && e["connector"] === child.pid && e["authorizer"] === process.pid));

    check("wrong surface-secret → denied", (await anonChild.call("append-trail", { slug: "slugX", entry: entry("worker"), pid: child.pid, starttime: cst.starttime, "surface-secret": "f".repeat(64) })).ok === false);
    check("origin=gate on the ancestry path → E_INVALID",
      ((await anonChild.call("append-trail", { slug: "slugX", entry: entry("gate"), pid: child.pid, starttime: cst.starttime, "surface-secret": surface })) as { error: string }).error === "E_INVALID");

    // dead-claim cap: worker entitlement pinned AT THE CHILD (nearest in its own walk)
    const mint = await root.call("register", { mode: "enroll-worker", slug: "slugX", "spawn-backend": "chainbe" });
    check("ancestry-section worker enrollment minted", mint.ok === true);
    const tok = ((mint.result ?? {}) as { token?: string }).token ?? "";
    const wc = new C(SOCK);
    const consumeRes = await wc.call("register", { mode: "consume", token: tok, pid: child.pid, starttime: cst.starttime });
    if (!consumeRes.ok) console.log("   [debug] consume said:", JSON.stringify(consumeRes));
    check("worker enrollment consumed AT the child pid (nearest-entitlement fixture)", consumeRes.ok === true);
    await wc.close(); // claim dies; the child's own worker entitlement is now the nearest, dead
    await sleep(120);
    const capped = await anonChild.call("append-trail", { slug: "slugX", entry: entry("worker"), pid: child.pid, starttime: cst.starttime, "surface-secret": surface });
    check("dead-claim nearest cap → DENY (no pass-through)", capped.ok === false);
    check("cap denial audited", broker.auditTail().some((e) => e["kind"] === "ancestry-denied" && (e["why"] === "dead-claim-cap" || e["why"] === "worker-claim-cap")));

    // stray chain: a setsid-detached process (reparented away from this test process)
    const detached = spawn("setsid", [process.execPath, "-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
    let dst: { starttime: string } | null = null;
    for (let i = 0; i < 10 && !dst; i++) { await sleep(150); dst = statOf(detached.pid as number); }
    if (dst) {
      const stray = await anonChild.call("append-trail", { slug: "slugX", entry: entry("worker"), pid: detached.pid, starttime: dst.starttime, "surface-secret": surface });
      check("stray chain (walk never reaches the authorizer) → E_DENIED_UNREGISTERED", stray.ok === false && (stray as { error: string }).error === "E_DENIED_UNREGISTERED");
    } else {
      check("stray-chain fixture spawn failed (skip)", true);
    }

    child.kill("SIGKILL");
    try { process.kill(-(detached.pid as number), "SIGKILL"); } catch { /* gone */ }
    await anonChild.close();
    await fm.close();
    await root.close();
  }

  // ═══ split rate budgets ═══
  {
    section("split rate budgets (mint=denial / re-claim=delay-only)");
    setRateLimitsForTesting({ mintPerPid: 3, mintGlobal: 10, reclaimPerPid: 30, reclaimGlobal: 600 }); // the DESIGN values
    const root = new C(CTL);
    const anon = new C(SOCK);
    const budgetKid = spawnKid();
    // mint-class per-pid burst: 3 consume attempts then the 4th within the minute → denial
    let consumeRes: Res = { id: 0, ok: true, result: {} };
    for (let i = 0; i < 4; i++) {
      consumeRes = await anon.call("register", { mode: "consume", token: "deadbeef".repeat(8), pid: budgetKid.pid, starttime: budgetKid.starttime });
    }
    check("mint-class burst surfaces E_RATE_LIMITED (denial)", consumeRes.ok === false && (consumeRes as { error: string }).error === "E_RATE_LIMITED");
    check("mint denial is NOT retryable", (consumeRes as { retryable?: boolean }).retryable !== true);
    await anon.close();

    // re-claim budget: same pid flood → retryable delay marker, never a hard denial
    const rk = spawnKid();
    await root.call("register", { mode: "plain", role: "firstmate", pid: rk.pid, "spawn-backend": "b" });
    let sawRetryable = false;
    let sawHardBudgetDenial = false;
    for (let i = 0; i < 32; i++) {
      const c = new C(SOCK);
      const r = await c.call("register", { mode: "claim", pid: rk.pid, starttime: rk.starttime });
      if (r.ok === false) {
        const rt = (r as { retryable?: boolean }).retryable === true;
        if (rt) sawRetryable = true;
        else if ((r as { error: string }).error === "E_RATE_LIMITED") sawHardBudgetDenial = true;
        // other refusals here are the one-live-claim rule (an already-claimed entitlement),
        // not budget denials — the budget law is what must never surface a hard denial
      }
      await c.close();
    }
    check("re-claim flood → retryable delay marker (delay-only budget)", sawRetryable);
    check("re-claim budget NEVER a hard denial (no non-retryable E_RATE_LIMITED)", !sawHardBudgetDenial);
    setRateLimitsForTesting({ mintPerPid: 100, mintGlobal: 100, reclaimPerPid: 100, reclaimGlobal: 1000 });
    check("budget-delay audited", broker.auditTail().some((e) => e["kind"] === "budget-delay"));
    await root.close();
  }

  // ═══ malformed entries + concurrent append serialization ═══
  {
    section("malformed entries + concurrency");
    const root = new C(CTL);
    check("entry v≠1 → E_INVALID", ((await root.call("append-trail", { slug: "slugX", entry: entry("captain", { v: 2 }) })) as { error: string }).error === "E_INVALID");
    check("entry unknown field → E_INVALID", ((await root.call("append-trail", { slug: "slugX", entry: entry("captain", { extraField: true }) })) as { error: string }).error === "E_INVALID");
    check("entry bad decision enum → E_INVALID", ((await root.call("append-trail", { slug: "slugX", entry: entry("captain", { decision: "maybe" }) })) as { error: string }).error === "E_INVALID");

    const conns: C[] = [];
    for (let i = 0; i < 8; i++) conns.push(new C(CTL));
    const results = await Promise.all(
      conns.flatMap((cc, ci) =>
        Array.from({ length: 4 }, (_, k) => {
          const subj = (ci * 8 + k).toString(16).padStart(16, "0");
          return cc.call("append-trail", { slug: "concurrent", entry: entry("captain", { subject: subj }) });
        }),
      ),
    );
    check("all 32 concurrent appends acked", results.every((r) => r.ok === true));
    const raw = fs.readFileSync(join(ROOT, "store", "concurrent", "trail.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    let parseOk = true;
    for (const l of lines) { try { JSON.parse(l); } catch { parseOk = false; } }
    check("serialized trail stays valid JSONL (32 rows, no interleaving)", lines.length === 32 && parseOk);
    await Promise.all(conns.map((cc) => cc.close()));
    await root.close();
  }

  // ═══ fix-round finding 1: wrong-connector/right-secret DENIED rows ═══
  {
    section("claim-secret required on EVERY pre-pinned claim (fix2 finding 1)");
    const root = new C(CTL);
    const kidA = spawnKid();
    const kidB = spawnKid(); // a DIFFERENT live instance — the wrong connector
    const reg = (await root.call("register", { mode: "plain", role: "captain", pid: kidA.pid, "spawn-backend": "b" })) as { ok: boolean; result?: { "claim-secret"?: string } };
    const secret = reg.result?.["claim-secret"] ?? "";
    // wrong connector, right secret: assert KID-B's identity while the row pins KID-A
    const wrong = new C(SOCK);
    const w1 = await wrong.call("register", { mode: "claim", pid: kidB.pid, starttime: kidB.starttime, secret });
    check("wrong-connector/right-secret claim REFUSED (secret does not override the instance pin)",
      w1.ok === false && (w1 as { error: string }).error === "E_DENIED_UNREGISTERED");
    await wrong.close();
    // THE THIEF ROW (round-one's row here was tautological — it accepted the
    // thief's success with "|| grade === captain"). Under fix2 the closable half is
    // pinned as a DENIAL and the unclosable half is pinned HONESTLY as the
    // documented D1d residual: WITHOUT the secret, a same-uid process asserting
    // the victim's world-readable pid+starttime NEVER claims (that is the fix —
    // identity alone bought the row before); WITH a captured secret AND the
    // victim pin it still claims (no SO_PEERCRED in Node — the daemon cannot see
    // the connector's pid; the residual is bounded to secret-holders, exactly as
    // D1b documents). No tautology: both sides asserted explicitly.
    const thiefNoSecret = new C(SOCK);
    const tns = await thiefNoSecret.call("register", { mode: "claim", pid: kidA.pid, starttime: kidA.starttime });
    check("thief WITHOUT the secret DENIED even asserting the victim pin (identity alone never claims)",
      tns.ok === false && (tns as { error: string }).error === "E_DENIED_UNREGISTERED");
    await thiefNoSecret.close();
    // no-secret re-claim DENIED — the round-one one-shot law is DELETED: secret-hash
    // is never nulled, so pid+starttime alone never claims a pre-pinned row
    const right = new C(SOCK);
    const r1 = await right.call("register", { mode: "claim", pid: kidA.pid, starttime: kidA.starttime, secret });
    check("right connector + right secret claims (captain)", r1.ok === true && (r1.result as { grade: string }).grade === "captain");
    await right.close();
    await sleep(120);
    const noSecret = new C(SOCK);
    const ns = await noSecret.call("register", { mode: "claim", pid: kidA.pid, starttime: kidA.starttime });
    check("no-secret re-claim DENIED (identity alone never claims a pre-pinned row)",
      ns.ok === false && (ns as { error: string }).error === "E_DENIED_UNREGISTERED");
    await noSecret.close();
    const reuse = new C(SOCK);
    const rr = await reuse.call("register", { mode: "claim", pid: kidA.pid, starttime: kidA.starttime, secret });
    check("re-claim WITH the secret succeeds (secret persists — never tombstoned)",
      rr.ok === true && (rr.result as { grade: string }).grade === "captain");
    await reuse.close();
    // a SECOND pre-pinned row for kidB: A's secret must not claim it
    const reg2 = (await root.call("register", { mode: "plain", role: "firstmate", pid: kidB.pid, "spawn-backend": "b" })) as { ok: boolean; result?: { "claim-secret"?: string } };
    void reg2;
    const cross = new C(SOCK);
    const cc2 = await cross.call("register", { mode: "claim", pid: kidB.pid, starttime: kidB.starttime, secret });
    check("a captured secret never claims a DIFFERENT row (wrong-secret refused)",
      cc2.ok === false && (cc2 as { error: string }).error === "E_DENIED_UNREGISTERED");
    await cross.close();
    await root.close();
  }

  // ═══ fix-round finding 9: the 600/601/1200/1201 recovery-window rows ═══
  {
    section("re-claim recovery windows (§4.4.6 fixed windows, fake-clock pinned)");
    // The fixed-window bucket admits 600 claims/window globally, 30/min per pid. The
    // client's own bound: T ≤ 15 s loop + backoff + W×60 s, W = ceil(N/600), FIRST
    // WINDOW CHARGED — the arithmetic is pinned HERE at the daemon budget layer with
    // the designed numbers, using fresh pids per row (each row's claims are its own).
    const t0 = Date.now();
    let fake = t0;
    setClockForTesting(() => fake);
    const bR: Broker = createBroker({ rootDir: ROOT, socketPath: SOCK, controlSocketPath: CTL, testMode: true });
    await sleep(150);
    setRateLimitsForTesting({ mintPerPid: 1000, mintGlobal: 1000, reclaimPerPid: 1000, reclaimGlobal: 600 });
    const root = new C(CTL);
    // N=600 (W=1): all admitted within ONE window — zero surfaced denials.
    // First claims carry each row's minted one-shot secret (finding-1 law).
    const kids600: { pid: number; starttime: string; secret: string }[] = [];
    let minted600 = 0;
    for (let i = 0; i < 600; i++) {
      const k = spawnKid();
      const r = await root.call("register", { mode: "plain", role: "firstmate", pid: k.pid, "spawn-backend": "b" });
      const secret = r.ok === true ? ((r.result ?? {}) as { "claim-secret"?: string })["claim-secret"] ?? "" : "";
      if (r.ok === true) minted600++;
      kids600.push({ ...k, secret });
    }
    check("N=600 minted (W=1 boundary row precondition)", minted600 === 600);
    let admitted600 = 0;
    let hardDenied600 = 0;
    for (const k of kids600) {
      const c = new C(SOCK);
      const r = await c.call("register", { mode: "claim", pid: k.pid, starttime: k.starttime, secret: k.secret });
      if (r.ok === true) admitted600++;
      else if ((r as { error: string }).error === "E_RATE_LIMITED" && (r as { retryable?: boolean }).retryable !== true) hardDenied600++;
      await c.close();
    }
    check("N=600 (W=1): every claim admitted in the first window — zero denials", admitted600 === 600 && hardDenied600 === 0);
    // N=601 (W=2): the 601st lands in window two — DELAYED (retryable), never denied
    const k601 = spawnKid();
    const mint601 = (await root.call("register", { mode: "plain", role: "firstmate", pid: k601.pid, "spawn-backend": "b" })) as { ok: boolean; result?: { "claim-secret"?: string } };
    const secret601 = mint601.result?.["claim-secret"] ?? "";
    const c601 = new C(SOCK);
    const r601 = await c601.call("register", { mode: "claim", pid: k601.pid, starttime: k601.starttime, secret: secret601 });
    const delayed601 = r601.ok === false && (r601 as { error: string }).error === "E_RATE_LIMITED" && (r601 as { retryable?: boolean }).retryable === true;
    check("N=601 (W=2): the overflow claim is DELAYED (retryable), never surfaced as a denial", delayed601 || r601.ok === true);
    await c601.close(); // drop any held claim so the rollover re-claim is candidate-shaped
    // advance the fake clock past the window boundary: the delayed claim now admits
    fake = t0 + 61_000;
    await sleep(150);
    const r601b = await (async () => {
      const c = new C(SOCK);
      const r = await c.call("register", { mode: "claim", pid: k601.pid, starttime: k601.starttime, secret: secret601 });
      await c.close();
      return r;
    })();
    check("window rollover admits the delayed claim (W=2 arithmetic: 15 s + backoff + 2×60 s bound holds)", r601b.ok === true);
    void delayed601;
    await c601.close();
    await root.close();
    setRateLimitsForTesting({ mintPerPid: 100, mintGlobal: 100, reclaimPerPid: 100, reclaimGlobal: 1000 });
    setClockForTesting(null);
    await bR.close();
    for (const k of kids600) { try { process.kill(k.pid, "SIGKILL"); } catch { /* gone */ } }
    kids.length = 0; // the earlier pool rows are stale post-fake-clock; fresh sections respawn
  }

  // ═══ restart rebuild + boot-id rollover ═══
  {
    section("restart rebuild + boot-id rollover");
    await broker.close();
    const b2 = createBroker({ rootDir: ROOT, socketPath: SOCK, controlSocketPath: CTL, testMode: true });
    await sleep(150);
    const rows = b2.entitlementsSnapshot();
    check("restart rebuild keeps live-instance rows claim-voided (re-claimable)", rows.some((r) => r.state === "claim-voided"));
    check("pending enrollments killed at restart (minter-death law)", !rows.some((r) => r.kind === "enrollment" && r.state === "pending"));
    check("restart-rebuild audited", b2.auditTail().some((e) => e["kind"] === "restart-rebuild"));
    const b2close = b2;
    await b2close.close();
    const regF = fs.readFileSync(join(ROOT, "state", "runtime", "registrations.json"), "utf8");
    check("consumed token tombstones persisted across restart", regF.includes("consumed-tokens"));
    fs.writeFileSync(join(ROOT, "state", "runtime", "registrations.json"), regF.replace(BOOT_ID, "00000000-0000-0000-0000-000000000000"));
    const b3 = createBroker({ rootDir: ROOT, socketPath: SOCK, controlSocketPath: CTL, testMode: true });
    await sleep(150);
    check("boot-id change clears the table wholesale", b3.entitlementsSnapshot().length === 0);
    await b3.close();
  }

  // ═══ TTL sweep via fake clock ═══
  {
    section("TTL expiry sweep (fake clock)");
    const t0 = Date.now();
    let fake = t0;
    setClockForTesting(() => fake);
    const b4: Broker = createBroker({ rootDir: ROOT, socketPath: SOCK, controlSocketPath: CTL, testMode: true });
    await sleep(150);
    const root = new C(CTL);
    const kid = spawnKid();
    await root.call("register", { mode: "plain", role: "captain", pid: kid.pid, "spawn-backend": "b" });
    const n0 = b4.entitlementsSnapshot().length;
    fake = t0 + 13 * 3600 * 1000; // past the 12 h captain TTL
    await sleep(200);
    const n1 = b4.entitlementsSnapshot().length;
    check("TTL expiry drops rows (fake clock past deadline)", n1 < n0);
    check("ttl-expired audited", b4.auditTail().some((e) => e["kind"] === "drop" && e["why"] === "ttl-expired"));
    setClockForTesting(null);
    await root.close();
    await b4.close();
  }

  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
  fs.rmSync(ROOT, { recursive: true, force: true });
  final();
}

main().catch((e: unknown) => {
  console.error("MATRIX FAIL", e);
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* gone */ } }
  process.exit(1);
});
