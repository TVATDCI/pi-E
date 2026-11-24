// extensions/tests/minidc-broker-matrix.test.ts — the R2 broker matrix (design §8;
// presenter/certification layer per r2-design-spec-sol-draft-2026-11-24 v2).
// Run: node --experimental-strip-types minidc-broker-matrix.test.ts
//
// Drives the REAL daemon (broker/minidc-broker.ts createBroker) on a scratch backing
// tree + scratch sockets (module seams; never /var/lib, never /run, never the live
// store). Entitled process instances are REAL live child processes (one role per
// instance — the daemon refuses double-roles per pid), claimed through the
// client-asserted identity model (D1d: asserted pid + /proc self-consistency).
//
// The ATTRIBUTION section (R2 v2) drives the presenter family exactly as production
// uses it: the compiled SO_PEERCRED helper (real C, compiled into scratch), the real
// certify flow (broker/minidc-certify.ts — the sole-writer law exercised on the real
// module), REAL external presenter processes (their kernel pid/uid is what the
// broker must stamp), the four deterministic delegation red cases (wrong claim,
// wrong instance, replay, expired), deleted-artifact rejection, installation-ID
// binding, revocation, restart persistence, and the canary CLI end-to-end.
import {
  createBroker,
  setClockForTesting,
  setRateLimitsForTesting,
  setUnitStateSourceForTesting,
  type Broker,
} from "../../broker/minidc-broker.ts";
import {
  certifyBackend,
  revokeBackend,
  sha256File,
  readInstallationId,
} from "../../broker/minidc-certify.ts";
import * as net from "node:net";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = fs.mkdtempSync("/tmp/minidc-broker-matrix-");
const SOCK = join(ROOT, "socket");
const CTL = join(ROOT, "control.sock");
const STATE = join(ROOT, "state");
const BOOT_ID = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
// the R2 v2 kernel-identity leg: compile the REAL SO_PEERCRED helper into scratch
// (same C the installer compiles; a missing compiler is a hard fail — this is the
// load-bearing identity primitive, never skipped)
const PEERCRED_HELPER = join(ROOT, "peercred-helper");
execFileSync("cc", ["-O2", "-Wall", "-o", PEERCRED_HELPER, join(import.meta.dirname, "..", "..", "broker", "minidc-peercred-helper.c")]);
// the certify fixtures: this suite's own node binary is the certified artifact class
// (children spawn from process.execPath ⇒ /proc/<pid>/exe digests match), and a
// scratch adapter file stands in for the installed protocol adapter
const NODE_EXE = process.execPath;
const NODE_DIGEST = sha256File(NODE_EXE);
const ADAPTER_FIXTURE = join(ROOT, "adapter-fixture.ts");
fs.writeFileSync(ADAPTER_FIXTURE, "// r2 matrix adapter fixture — digest-measured, not executed\n");
const ADAPTER_DIGEST = sha256File(ADAPTER_FIXTURE);
const INSTALL_ID = randomHex32();
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(join(STATE, "installation-id"), INSTALL_ID);
function randomHex32(): string {
  // local (not imported) so this file stays a self-contained script
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}
const APPROVED = join(ROOT, "approved-backends.json");
function writeApproved(exeDigests: string[], adapterDigests: string[], protocolRevision: number): void {
  fs.writeFileSync(APPROVED, JSON.stringify({
    version: 1,
    backends: [{
      backend: "matrixbe",
      "exe-digests": exeDigests,
      "adapter-digests": adapterDigests,
      "protocol-revision": protocolRevision,
    }],
  }));
}
function certifyOpts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    backend: "matrixbe",
    exePath: NODE_EXE,
    adapterPath: ADAPTER_FIXTURE,
    stateDir: STATE,
    approvedListPath: APPROVED,
    socketPath: SOCK,
    requireRoot: false, // the harness IS the scratch operator; the euid gate is
                        // pinned separately via the real CLI subprocess below
    ...overrides,
  };
}

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

// ── the R2 v2 presenter driver: a REAL external process speaking the claim family ──
// Each Driver child is a live node process whose /proc/<pid>/exe IS the certified
// artifact — the broker's SO_PEERCRED pid/uid and live /proc measurements run against
// THIS process, exactly as against a production backend.
const DRIVER_SOURCE = `
const net = require("node:net");
const readline = require("node:readline");
const SOCK = process.argv[1];
const c = net.connect(SOCK, () => { process.stderr.write("D:ready\\n"); });
let buf = "";
let nextId = 1;
const pending = new Map();
c.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let f; try { f = JSON.parse(line); } catch (e) { continue; }
    const cb = pending.get(f.id);
    if (cb) { pending.delete(f.id); cb(f); }
  }
});
c.on("error", () => {});
function call(op, args) {
  return new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    c.write(JSON.stringify({ id, op, args }) + "\\n");
  });
}
function entry(subject) {
  return {
    v: 1, ts: new Date().toISOString(), actor: "worker", pane: null,
    task: "matrix-attribution", subject: subject, cls: "G", decision: "proceed", scope: "once",
  };
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let cmd; try { cmd = JSON.parse(line); } catch (e) { return; }
  if (cmd.do === "open") {
    const r = await call("open-claim", { backend: cmd.backend, slug: cmd.slug });
    process.stdout.write("R:" + JSON.stringify(r) + "\\n");
  } else if (cmd.do === "append") {
    const args = { slug: cmd.slug, entry: entry(cmd.subject), "claim-id": cmd.claimId };
    if (cmd.token) args["delegation-token"] = cmd.token;
    const r = await call("append-trail", args);
    process.stdout.write("R:" + JSON.stringify(r) + "\\n");
  } else if (cmd.do === "delegate") {
    const r = await call("delegate-claim", {
      "claim-id": cmd.claimId, "delegate-pid": cmd.delegatePid,
      "delegate-starttime": cmd.delegateStarttime, "ttl-minutes": cmd.ttlMinutes ?? 5,
      ...(cmd.deliverFile ? { "deliver-file": true } : {}),
    });
    process.stdout.write("R:" + JSON.stringify(r) + "\\n");
  } else if (cmd.do === "raw") {
    const r = await call(cmd.op, cmd.args);
    process.stdout.write("R:" + JSON.stringify(r) + "\\n");
  }
});
`;

class Driver {
  child: ChildProcess;
  private queue: ((r: Res) => void)[] = [];
  ready: Promise<void>;
  constructor(exe: string = NODE_EXE) {
    this.child = spawn(exe, ["-e", DRIVER_SOURCE, SOCK], { stdio: ["pipe", "pipe", "pipe"] });
    kids.push(this.child);
    // the R: response pump — one queued resolver per R: line, in order
    let out = "";
    this.child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      let i: number;
      while ((i = out.indexOf("\n")) >= 0) {
        const l = out.slice(0, i);
        out = out.slice(i + 1);
        if (!l.startsWith("R:")) continue;
        const cb = this.queue.shift();
        if (cb) {
          try { cb(JSON.parse(l.slice(2)) as Res); } catch { cb({ id: -1, ok: false, error: "DRIVER-MALFORMED" }); }
        }
      }
    });
    this.ready = new Promise((res) => {
      let err = "";
      this.child.stderr?.on("data", (d: Buffer) => {
        err += d.toString();
        if (err.includes("D:ready")) res();
      });
      setTimeout(() => res(), 2500); // fall through — sends will time out loudly anyway
    });
  }
  pid(): number { return this.child.pid as number; }
  starttime(): string {
    const st = statOf(this.child.pid as number);
    if (!st) throw new Error("driver stat failed");
    return st.starttime;
  }
  send(cmd: Record<string, unknown>): Promise<Res> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.child.stdin?.write(JSON.stringify(cmd) + "\n");
      setTimeout(() => {
        const idx = this.queue.indexOf(resolve);
        if (idx >= 0) { this.queue.splice(idx, 1); resolve({ id: -1, ok: false, error: "DRIVER-TIMEOUT" }); }
      }, 6000).unref?.();
    });
  }
  async open(backend = "matrixbe", slug = "slugX"): Promise<Res> { await this.ready; return this.send({ do: "open", backend, slug }); }
  async append(claimId: string, subject: string, slug = "slugX", token?: string): Promise<Res> {
    await this.ready;
    return this.send({ do: "append", claimId, subject, slug, ...(token ? { token } : {}) });
  }
  async delegate(claimId: string, delegatePid: number, delegateStarttime: string, ttlMinutes = 5, deliverFile = false): Promise<Res> {
    await this.ready;
    return this.send({ do: "delegate", claimId, delegatePid, delegateStarttime, ttlMinutes, deliverFile });
  }
  kill(): void { try { this.child.kill("SIGKILL"); } catch { /* gone */ } }
}

function trailLines(slug: string): unknown[] {
  const p = join(ROOT, "store", slug, "trail.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
}
function createHashOf(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
function issuedSnapshot(b: Broker): string[] {
  return b.issuedDelegationsSnapshot();
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

  let broker: Broker = createBroker({ rootDir: ROOT, socketPath: SOCK, controlSocketPath: CTL, peercredHelperPath: PEERCRED_HELPER, testMode: true });
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

  // ═══ R2 v2: certification + presenter attribution (spec §2.1–§2.2, R1–R5) ═══
  {
    section("certification + presenter attribution (kernel identity, real certify)");
    // fixtures: approved list matching THIS node binary + adapter, install ID written
    writeApproved([NODE_DIGEST], [ADAPTER_DIGEST], 2);
    const storePath = join(STATE, "certified-backends.json");
    const A = new Driver();
    const B = new Driver();
    const Cc = new Driver(); // the unrelated presenter
    const A2 = new Driver(); // the post-owner-death owner instance for later rows
    await Promise.all([A.ready, B.ready, Cc.ready, A2.ready]);

    // — uncertified generation: the fail-closed default every claim hits pre-certify —
    const n0 = trailLines("slugX").length;
    const preCert = await A.open();
    check("uncertified generation → E_DENIED_TOPOLOGY/uncertified-generation (fail-closed)",
      preCert.ok === false && (preCert as { error: string }).error === "E_DENIED_TOPOLOGY" && (preCert as { reason?: string }).reason === "uncertified-generation");
    check("denial committed no append", trailLines("slugX").length === n0);
    check("presenter-denied audited (uncertified-generation)",
      broker.auditTail().some((e) => e["kind"] === "presenter-denied" && e["why"] === "uncertified-generation"));

    // — certify refusals FIRST (failing-first: each leaves the store untouched) —
    const badProto = join(ROOT, "approved-badproto.json");
    fs.writeFileSync(badProto, JSON.stringify({ version: 1, backends: [{ backend: "matrixbe", "exe-digests": [NODE_DIGEST], "adapter-digests": [ADAPTER_DIGEST], "protocol-revision": 99 }] }));
    const rBadProto = await certifyBackend(certifyOpts({ approvedListPath: badProto }) as Parameters<typeof certifyBackend>[0]);
    check("certify refused: protocol revision mismatch (entry 99 vs daemon 2)", rBadProto.ok === false);
    const rBadDigest = await certifyBackend(certifyOpts({ exePath: ADAPTER_FIXTURE }) as Parameters<typeof certifyBackend>[0]);
    check("certify refused: unapproved exe digest", rBadDigest.ok === false);
    const rNoDaemon = await certifyBackend(certifyOpts({ socketPath: join(ROOT, "nope.sock") }) as Parameters<typeof certifyBackend>[0]);
    check("certify refused: daemon unreachable (compatibility unproven)", rNoDaemon.ok === false);
    const rUnknownBackend = await certifyBackend(certifyOpts({ backend: "not-approved" }) as Parameters<typeof certifyBackend>[0]);
    check("certify refused: backend absent from the approved list", rUnknownBackend.ok === false);
    check("no refusal wrote a store (R2: no partial grant)", !fs.existsSync(storePath));

    // — the real CLI's euid gate: non-root certify writes nothing (R1 captain channel) —
    const cli = spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "..", "..", "broker", "minidc-brokerctl.ts"),
      "certify", "--backend", "matrixbe", "--exe", NODE_EXE, "--adapter", ADAPTER_FIXTURE,
      "--root", ROOT, "--approved", APPROVED, "--socket", SOCK], { encoding: "utf8" });
    check("brokerctl certify as non-root → exit≠0, euid message", cli.status !== 0 && /requires root/.test(cli.stderr));
    check("non-root CLI wrote no store", !fs.existsSync(storePath));

    // — the happy certify (the sole-writer path, real module) —
    const cert = await certifyBackend(certifyOpts() as Parameters<typeof certifyBackend>[0]);
    check("certify OK: full receipt with install-ID binding", cert.ok === true
      && (cert.ok === true && cert.receipt["installation-id"] === INSTALL_ID && cert.receipt["exe-digest"] === NODE_DIGEST && cert.receipt["protocol-revision"] === 2));
    const storeRaw = fs.readFileSync(storePath, "utf8");
    const store1 = JSON.parse(storeRaw) as { version: number; backends: { backend: string; revoked: boolean }[] };
    check("store is v2 with the live generation", store1.version === 2 && store1.backends.length === 1 && store1.backends[0]?.backend === "matrixbe" && store1.backends[0]?.revoked === false);
    check("store mode 0640 (root-owned state entry discipline)", (fs.statSync(storePath).mode & 0o777) === 0o640);

    // — direct presentation: kernel pid/uid + running-artifact digest —
    const claim1 = await A.open();
    check("open-claim certified → broker-issued authorization", claim1.ok === true);
    if (claim1.ok === true) {
      const r = claim1.result as { "claim-id": string; generation: { "generation-id": string; backend: string }; presenter: { pid: number; starttime: string; uid: number; "exe-digest": string } };
      check("presenter tuple is KERNEL truth: pid=A.pid, uid=real uid, exe=certified digest",
        r.presenter.pid === A.pid() && r.presenter.starttime === A.starttime()
        && r.presenter.uid === process.getuid() && r.presenter["exe-digest"] === NODE_DIGEST);
      check("generation binding matches the certified record", r.generation["generation-id"] === (cert.ok === true ? cert.receipt["generation-id"] : "") && r.generation.backend === "matrixbe");
      const app1 = await A.append(r["claim-id"], "a1b2c3d4e5f60718");
      check("direct append by the owner commits", app1.ok === true && (app1.result as { actor: string }).actor === "backend");
      const rows = trailLines("slugX") as { actor: string; claim?: string; generation?: string; delegated?: boolean; presenter?: { pid: number; starttime: string; uid: number } }[];
      const stamped = rows.find((x) => x.claim === r["claim-id"]);
      check("entry binds claim + generation + ACTUAL presenter (attribution invariant)",
        stamped !== undefined && stamped.generation === r.generation["generation-id"]
        && stamped.presenter?.pid === A.pid() && stamped.presenter?.starttime === A.starttime()
        && stamped.presenter?.uid === process.getuid() && stamped.delegated === false && stamped.actor === "backend");
      const replayOwner = await A.append(r["claim-id"], "ffffffffffffffff");
      check("one-claim-one-append: owner re-presenting the consumed claim → denied",
        replayOwner.ok === false && (replayOwner as { reason?: string }).reason === "no-live-claim");
      check("the denied re-present committed nothing (no row for its subject)",
        !trailLines("slugX").some((x) => (x as { subject?: string }).subject === "ffffffffffffffff"));
    }

    // — unrelated presenter: a different live instance gains nothing (R5) —
    {
      const claimU = await A.open();
      const cu = claimU.result as { "claim-id": string };
      const stray = await Cc.append(cu["claim-id"], "1111111111111111");
      check("unrelated presenter (not owner, no token) → not-claim-owner, no append",
        stray.ok === false && (stray as { reason?: string }).reason === "not-claim-owner"
        && !trailLines("slugX").some((x) => (x as { subject?: string }).subject === "1111111111111111"));
      // owner death: after A dies nobody can present A's claim — instance identity is
      // kernel-derived, and a recycled pid carries a different starttime (R4)
      const claimD = await A.open();
      const cd = claimD.result as { "claim-id": string };
      A.kill();
      await sleep(150);
      const orphan = await Cc.append(cd["claim-id"], "2222222222222222");
      check("dead owner's claim unusable by any other live process", orphan.ok === false && (orphan as { reason?: string }).reason === "not-claim-owner");
      void cu;
    }

    // — delegation: the four deterministic red cases + the happy path (R5) —
    {
      // happy path with 0600 file delivery (never env)
      const claimH = await A2.open();
      const ch = claimH.result as { "claim-id": string };
      const mintF = await A2.delegate(ch["claim-id"], B.pid(), B.starttime(), 5, true);
      check("delegate-claim by the owner mints a one-time token + 0600 delivery file",
        mintF.ok === true && typeof (mintF.result as { token: string }).token === "string" && typeof (mintF.result as { "delivered-file": string })["delivered-file"] === "string");
      const tokFile = (mintF.result as { "delivered-file": string })["delivered-file"];
      check("delivery file is 0600 and owned by the delegate uid",
        (fs.statSync(tokFile).mode & 0o777) === 0o600 && fs.statSync(tokFile).uid === process.getuid());
      check("delivery file carries the token bytes", fs.readFileSync(tokFile, "utf8") === (mintF.result as { token: string }).token);
      const delApp = await B.append(ch["claim-id"], "b1b2c3d4e5f60718", "slugX", (mintF.result as { token: string }).token);
      check("delegated append commits with the DELEGATE as actual presenter",
        delApp.ok === true && (trailLines("slugX") as { claim?: string; delegated?: boolean; presenter?: { pid: number } }[]).some(
          (x) => x.claim === ch["claim-id"] && x.delegated === true && x.presenter?.pid === B.pid()));
      fs.rmSync(tokFile, { force: true });

      // RED 1 — wrong claim: token bound to claim X presented for claim Y
      const claimX = await A2.open();
      const claimY = await A2.open();
      const cx = claimX.result as { "claim-id": string };
      const cy = claimY.result as { "claim-id": string };
      const mintX = await A2.delegate(cx["claim-id"], B.pid(), B.starttime(), 5);
      const tokX = (mintX.result as { token: string }).token;
      const red1 = await B.append(cy["claim-id"], "3333333333333333", "slugX", tokX);
      check("RED wrong-claim token → delegation-wrong-claim, no append",
        red1.ok === false && (red1 as { reason?: string }).reason === "delegation-wrong-claim"
        && !trailLines("slugX").some((x) => (x as { subject?: string }).subject === "3333333333333333"));

      // RED 2 — wrong instance: token bound to B presented by Cc
      const red2 = await Cc.append(cx["claim-id"], "4444444444444444", "slugX", tokX);
      check("RED wrong-instance token → delegation-wrong-instance, no append",
        red2.ok === false && (red2 as { reason?: string }).reason === "delegation-wrong-instance"
        && !trailLines("slugX").some((x) => (x as { subject?: string }).subject === "4444444444444444"));

      // RED 3 — replay: the consumed token no longer exists in the issued-set
      const claimR = await A2.open();
      const cr = claimR.result as { "claim-id": string };
      const mintR = await A2.delegate(cr["claim-id"], B.pid(), B.starttime(), 5);
      const tokR = (mintR.result as { token: string }).token;
      const okR = await B.append(cr["claim-id"], "5555555555555555", "slugX", tokR);
      check("replay precondition: first use of the token commits", okR.ok === true);
      const claimR2 = await A2.open();
      const cr2 = claimR2.result as { "claim-id": string };
      const red3 = await B.append(cr2["claim-id"], "6666666666666666", "slugX", tokR);
      check("RED replayed token → delegation-unknown, no append",
        red3.ok === false && (red3 as { reason?: string }).reason === "delegation-unknown"
        && !trailLines("slugX").some((x) => (x as { subject?: string }).subject === "6666666666666666"));

      // RED 4 — expired: minutes-scale TTL passed (fake clock; the on-access check is
      // the deterministic authority — the sweep does not touch delegations)
      const claimE = await A2.open();
      const ce = claimE.result as { "claim-id": string };
      const mintE = await A2.delegate(ce["claim-id"], B.pid(), B.starttime(), 1);
      const tokE = (mintE.result as { token: string }).token;
      const t0 = Date.now();
      let fake = t0;
      setClockForTesting(() => fake);
      fake = t0 + 2 * 60_000;
      await sleep(150);
      const red4 = await B.append(ce["claim-id"], "7777777777777777", "slugX", tokE);
      check("RED expired token → delegation-expired, no append",
        red4.ok === false && (red4 as { reason?: string }).reason === "delegation-expired"
        && !trailLines("slugX").some((x) => (x as { subject?: string }).subject === "7777777777777777"));
      setClockForTesting(null);

      // the issued-set stores HASHES only — never the nonce (R5)
      const anyTokens = JSON.stringify([...issuedSnapshot(broker)]);
      check("issued-set stores hashes only (no token material in memory)", !anyTokens.includes(tokR) && !anyTokens.includes(tokX));
    }

    // — running-artifact law: deleted exe targets never certify a claim (R4) —
    {
      const nodeCopy = join(ROOT, "nodecopy");
      fs.copyFileSync(NODE_EXE, nodeCopy);
      fs.chmodSync(nodeCopy, 0o755);
      const D = new Driver(nodeCopy);
      await D.ready;
      fs.rmSync(nodeCopy, { force: true }); // the running binary's origin is unlinked
      const claimD = await D.open();
      check("running artifact with (deleted) target → E_DENIED (deleted), no cert path",
        claimD.ok === false && (claimD as { reason?: string }).reason === "running-artifact-deleted");
      D.kill();
    }

    // — installation-ID binding + revocation (R3) —
    {
      const goodStore = fs.readFileSync(storePath, "utf8");
      const crossed = JSON.parse(goodStore) as { version: 2; backends: { "installation-id": string }[] };
      crossed.backends[0]!["installation-id"] = "f".repeat(32); // a copied-to-other-desk record
      fs.writeFileSync(storePath, JSON.stringify(crossed, null, 2) + "\n");
      const crossClaim = await A2.open();
      check("install-ID mismatch (cross-desk copy) → uncertified-generation", crossClaim.ok === false && (crossClaim as { reason?: string }).reason === "uncertified-generation");
      fs.writeFileSync(storePath, goodStore); // restore
      const rev = await revokeBackend({ backend: "matrixbe", stateDir: STATE, requireRoot: false });
      check("revoke tombstones the live generation", rev.ok === true && (rev.ok === true && rev.revoked === 1));
      const postRev = await A2.open();
      check("revoked generation authorizes nothing", postRev.ok === false && (postRev as { reason?: string }).reason === "uncertified-generation");
      const reCert = await certifyBackend(certifyOpts() as Parameters<typeof certifyBackend>[0]);
      check("re-certify after revoke restores a fresh live generation", reCert.ok === true);

      // R2 interruption leg: a store write that cannot complete leaves the previous
      // grant byte-identical (atomic whole-file replace — no partial grant, ever)
      const before = fs.readFileSync(storePath, "utf8");
      fs.chmodSync(STATE, 0o500); // block temp creation + rename
      const brokenWrite = await certifyBackend(certifyOpts() as Parameters<typeof certifyBackend>[0]);
      fs.chmodSync(STATE, 0o755);
      check("interrupted/unwritable certify refuses, previous grant intact byte-for-byte",
        brokenWrite.ok === false && fs.readFileSync(storePath, "utf8") === before);
      // R1 store integrity under broker traffic: daemon appends never touch the store
      const claimW = await A2.open();
      await A2.append((claimW.result as { "claim-id": string })["claim-id"], "9999999999999999");
      check("daemon-side appends never write the certification store (sole-writer law)",
        fs.readFileSync(storePath, "utf8") === before);
    }

    // — restart: certification survives (file-backed), claims do not (memory) —
    {
      const claimPre = await A2.open();
      const cp = claimPre.result as { "claim-id": string };
      await broker.close();
      broker = createBroker({ rootDir: ROOT, socketPath: SOCK, controlSocketPath: CTL, peercredHelperPath: PEERCRED_HELPER, testMode: true });
      await sleep(150);
      const F = new Driver();
      await F.ready;
      const liveGen = (JSON.parse(fs.readFileSync(storePath, "utf8")) as { backends: { "generation-id": string; revoked: boolean }[] })
        .backends.find((b) => !b.revoked)?.["generation-id"];
      const post = await F.open();
      check("unchanged restart preserves certification (R3)", post.ok === true
        && (post.ok === true ? (post.result as { generation: { "generation-id": string } }).generation["generation-id"] === liveGen : false));
      const oldClaim = await F.append(cp["claim-id"], "8888888888888888");
      check("claims die with the daemon (restart re-opens, never resumes)", oldClaim.ok === false && (oldClaim as { reason?: string }).reason === "no-live-claim");
      F.kill();
    }

    // — the canary CLI end-to-end (R6): pre-cert denial phase on an uncertified slug —
    // (async spawn, NOT spawnSync: the daemon runs in THIS process — a sync spawn
    // would freeze its event loop and deadlock the canary's socket wait)
    {
      const canary = join(import.meta.dirname, "..", "..", "broker", "minidc-canary.ts");
      const runCanary = (args: string[]): Promise<{ status: number | null; pid: number; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          const k = spawn(process.execPath, ["--experimental-strip-types", canary, ...args], { stdio: ["ignore", "pipe", "pipe"] });
          kids.push(k);
          let out = "", err = "";
          k.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
          k.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
          k.on("close", (code) => resolve({ status: code, pid: k.pid as number, stdout: out, stderr: err }));
          setTimeout(() => { try { k.kill("SIGKILL"); } catch { /* gone */ } }, 20000).unref?.();
        });
      const pre = await runCanary(["--phase", "pre-cert", "--backend", "matrixbe", "--slug", "canaryslug", "--socket", SOCK]);
      check("canary pre-cert (certified state) exits 1 — the desk IS certified for matrixbe",
        pre.status === 1 && /AUTHORIZED before certification|denial was not the required/.test(pre.stderr));
      // make the canary's own pre-cert phase honest: revoke + run + re-certify
      await revokeBackend({ backend: "matrixbe", stateDir: STATE, requireRoot: false });
      const pre2 = await runCanary(["--phase", "pre-cert", "--backend", "matrixbe", "--slug", "canaryslug", "--socket", SOCK]);
      check("canary pre-cert OK — denial is specifically uncertified-generation", pre2.status === 0 && /pre-cert OK/.test(pre2.stdout));
      const finalCert = await certifyBackend(certifyOpts() as Parameters<typeof certifyBackend>[0]);
      check("canary precondition: fresh live generation certified", finalCert.ok === true);
      const post = await runCanary(["--phase", "post-cert", "--backend", "matrixbe", "--slug", "canaryslug", "--socket", SOCK,
        "--trail", join(ROOT, "store", "canaryslug", "trail.jsonl")]);
      const m = /^canary-receipt claim=(\S+) generation=(\S+) presenter=(\d+):(\d+)@(\d+) entry=([0-9a-f]{16}) slug=(\S+)$/m.exec(post.stdout);
      check("canary post-cert exit 0 with the one-line operator receipt", post.status === 0 && m !== null);
      if (m) {
        check("receipt presenter pid is the canary's own kernel-identified process", m[3] === String(post.pid));
        check("receipt generation matches the live certified generation", m[2] === finalCert.receipt["generation-id"]);
        const trail = fs.readFileSync(join(ROOT, "store", "canaryslug", "trail.jsonl"), "utf8");
        const line = trail.split("\n").find((l) => l.includes(`"claim":"${m[1]}"`));
        check("receipt entry hash matches the committed trail line (independent read-back)",
          line !== undefined && createHashOf(line).slice(0, 16) === m[6]);
      }
      check("canary trail read-back never used the broker API (file parse only)", post.stdout.includes("canary-receipt"));
      // legacy-fallback law: dead socket + --no-legacy-fallback = hard fail; without = soft exit 3
      const deadSock = join(ROOT, "dead.sock");
      const soft = await runCanary(["--phase", "pre-cert", "--backend", "matrixbe", "--slug", "canaryslug", "--socket", deadSock]);
      const hard = await runCanary(["--phase", "pre-cert", "--backend", "matrixbe", "--slug", "canaryslug", "--socket", deadSock, "--no-legacy-fallback"]);
      check("dead socket without flag → soft legacy observation (exit 3, nothing written)", soft.status === 3);
      check("dead socket with --no-legacy-fallback → hard failure (exit 1, per-invocation isolation)", hard.status === 1);
    }

    B.kill(); Cc.kill(); A2.kill();
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
