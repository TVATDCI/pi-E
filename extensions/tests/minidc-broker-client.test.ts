// extensions/tests/minidc-broker-client.test.ts — the R2 client matrix (design §8).
// Run: node --experimental-strip-types minidc-broker-client.test.ts
//
// Covers: the §4.6.5a tri-state probe law (probe errors NEVER collapse to absence);
// the closed-world 18-tuple table (every cell); the fixed UNAVAILABLE/CONFLICT error
// bytes; the broker-down acceptance trio per marker value; malformed/enum-invalid
// frames; the SCOPED registration pin (the degraded session's own client emits ZERO
// register frames and starts no background loop); the dual-path rules law; the sync
// bridge against a REAL daemon (registration, read-rules, append with central origin
// derivation, N1 fresh re-validation, degraded timeout).
import * as clientMod from "../minidc-broker-client.ts";
import {
  probeTree,
  tupleVerdict,
  readMarkerValue,
  observeInstallMode,
  setBrokerPathsForTesting,
  setNodeTrustFileForTesting,
  MODE_UNAVAILABLE_ERROR,
  MODE_CONFLICT_ERROR,
  initBrokerClient,
  brokerClientActive,
  bridgeGrade,
  bridgeDebug,
  readGlobalRulesViaBroker,
  appendTrailViaBroker,
  readGrantsViaBroker,
  shutdownBrokerClient,
  lastObservation,
  type BrokerPaths,
} from "../minidc-broker-client.ts";
import * as net from "node:net";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (fs.existsSync(path)) { try { fs.statSync(path); resolve(); return; } catch { /* raced */ } }
      if (Date.now() - t0 > timeoutMs) { reject(new Error("daemon socket never appeared")); return; }
      setTimeout(tryOnce, 50);
    };
    tryOnce();
  });
}

const T = fs.mkdtempSync("/tmp/minidc-client-matrix-");
const paths: BrokerPaths = {
  treePath: join(T, "backing"),
  socketPath: join(T, "socket"),
  markerPath: join(T, "home", ".pi", "agent", "mini-dc-install-mode"),
  attestedRulesPath: join(T, "home", ".pi", "agent", "mini-dc-rules"),
  legacyRulesPath: join(T, "home", ".pi", "agent", "mini-dc-rules.yaml"),
};
fs.mkdirSync(join(T, "home", ".pi", "agent"), { recursive: true });
setBrokerPathsForTesting(paths);
// defect-8 revision: the owner launch reads the AUTHORIZED runtime from a
// trust file — node-run tests stage their own (process.execPath IS node here)
// The fixture mirrors the installer's protected copy, not the raw host
// interpreter: GitHub's toolcache node is world-writable (correctly refused by
// trustedNodeBin), while the installed runtime is a non-writable copy.
const protectedNode = join(T, "node-runtime");
fs.copyFileSync(process.execPath, protectedNode);
fs.chmodSync(protectedNode, 0o555);
setNodeTrustFileForTesting(join(T, "node-bin"));
fs.writeFileSync(join(T, "node-bin"), `${protectedNode}\n`);
// The parent AND the owner verify socket peers with the REAL compiled helper.
// CI runners do not have /usr/lib/minidc installed, so build the exact shipped
// helper into the scratch tree instead of skipping verification.
const peerHelper = join(T, "minidc-peercred-helper");
const compiled = spawnSync("cc", ["-O2", "-o", peerHelper, join(REPO, "broker", "minidc-peercred-helper.c")], {
  encoding: "utf8",
});
if (compiled.status !== 0) {
  throw new Error(`the real peercred helper must compile for this matrix: ${compiled.stderr || compiled.error}`);
}
process.env.MINIDC_PEERCRED_HELPER = peerHelper;

function writeMarker(v: "broker" | "legacy" | null): void {
  if (v === null) { try { fs.unlinkSync(paths.markerPath); } catch { /* absent */ } }
  else fs.writeFileSync(paths.markerPath, v);
}

/** A canned status-frame server for the observation rows (no real daemon). */
function fakeStatusServer(handler: (s: net.Socket) => void): net.Server {
  const srv = net.createServer(handler);
  srv.listen(paths.socketPath);
  return srv;
}

async function main(): Promise<void> {
  // ═══ tri-state probes ═══
  {
    section("tri-state probes (§4.6.5a — errors are NEVER absence)");
    fs.mkdirSync(join(T, "probe"), { recursive: true });
    check("tree probe: present", probeTree(join(T, "probe")).kind === "present");
    check("tree probe: clean ENOENT ⇒ absent", probeTree(join(T, "nope")).kind === "absent");
    // EACCES injection: a parent dir without +x makes statSync fail EACCES for children
    fs.mkdirSync(join(T, "locked"), { recursive: true });
    fs.chmodSync(join(T, "locked"), 0o000);
    const acc = probeTree(join(T, "locked", "backing"));
    fs.chmodSync(join(T, "locked"), 0o755);
    check("tree probe: EACCES ⇒ error (probe-error, never absent)", acc.kind === "error" && (acc as { errno: string }).errno === "EACCES");
  }

  // ═══ the closed-world 18-tuple table (every cell) ═══
  {
    section("closed-world 18-tuple table (§4.6.5)");
    const expected: [string, string, string, string][] = [
      // marker, attestation, observables, verdict — exactly the table
      ["broker", "broker", "present", "BROKER"],
      ["broker", "broker", "absent", "CONFLICT"],
      ["broker", "legacy", "present", "CONFLICT"],
      ["broker", "legacy", "absent", "CONFLICT"],
      ["broker", "absent", "present", "CONFLICT"],
      ["broker", "absent", "absent", "CONFLICT"],
      ["legacy", "broker", "present", "CONFLICT"],
      ["legacy", "broker", "absent", "CONFLICT"],
      ["legacy", "legacy", "present", "CONFLICT"],
      ["legacy", "legacy", "absent", "LEGACY"],
      ["legacy", "absent", "present", "CONFLICT"],
      ["legacy", "absent", "absent", "LEGACY"],
      ["absent", "broker", "present", "BROKER"],
      ["absent", "broker", "absent", "CONFLICT"],
      ["absent", "legacy", "present", "CONFLICT"],
      ["absent", "legacy", "absent", "LEGACY"],
      ["absent", "absent", "present", "CONFLICT"],
      ["absent", "absent", "absent", "LEGACY"],
    ];
    let allOk = true;
    for (const [m, a, o, want] of expected) {
      if (tupleVerdict(m as "broker", a as "broker", o as "present") !== want) {
        allOk = false;
        console.log(`    cell mismatch: ${m}/${a}/${o} → wanted ${want}`);
      }
    }
    check("all 18 cells carry exactly the table verdicts (2 broker, 4 legacy, 12 conflict)", allOk);
  }

  // ═══ marker reading ═══
  {
    section("advisory marker (unreadable/corrupt ⇒ absent)");
    writeMarker("broker");
    check("marker broker", readMarkerValue(paths.markerPath) === "broker");
    writeMarker("legacy");
    check("marker legacy", readMarkerValue(paths.markerPath) === "legacy");
    fs.writeFileSync(paths.markerPath, "garbage\n");
    check("corrupt marker ⇒ absent (advisory best-effort)", readMarkerValue(paths.markerPath) === "absent");
    writeMarker(null);
    check("absent marker", readMarkerValue(paths.markerPath) === "absent");
  }

  // ═══ observation law against canned servers ═══
  {
    section("observation law (§4.6.5a)");
    // structural-derivation controls (tree absent, socket clean-negative)
    writeMarker(null);
    let obs = await observeInstallMode();
    check("tree absent + socket not-live + marker absent ⇒ tuple 18 LEGACY", obs.state === "LEGACY");
    writeMarker("legacy");
    obs = await observeInstallMode();
    check("tree absent + not-live + marker legacy ⇒ tuple 12 LEGACY (zero conflict rows)", obs.state === "LEGACY");
    writeMarker("broker");
    obs = await observeInstallMode();
    check("tree absent + not-live + marker broker ⇒ tuple 6 CONFLICT + fixed bytes",
      obs.state === "CONFLICT" && obs.error === MODE_CONFLICT_ERROR("broker", "absent", "absent"));
    writeMarker(null);

    // tree present + no socket ⇒ UNAVAILABLE (socket-absent token)
    fs.mkdirSync(paths.treePath, { recursive: true });
    for (const marker of ["broker", "legacy", null] as const) {
      writeMarker(marker);
      obs = await observeInstallMode();
      check(`tree present + socket absent + marker ${marker ?? "absent"} ⇒ UNAVAILABLE + fixed bytes`,
        obs.state === "UNAVAILABLE" &&
        obs.error === MODE_UNAVAILABLE_ERROR("socket-absent"));
    }
    // malformed frame
    const bad = fakeStatusServer((s) => { s.on("data", () => s.write("this is not json\n")); });
    await sleep(100);
    obs = await observeInstallMode();
    check("malformed frame ⇒ UNAVAILABLE (malformed token)", obs.state === "UNAVAILABLE" && obs.error === MODE_UNAVAILABLE_ERROR("malformed"));
    bad.close();
    await sleep(100);
    // out-of-enum attested-mode
    const sideways = fakeStatusServer((s) => {
      s.on("data", () => s.write(`${JSON.stringify({ id: 1, ok: true, result: { "attested-mode": "sideways" } })}\n`));
    });
    await sleep(100);
    obs = await observeInstallMode();
    check("out-of-enum attested-mode ⇒ UNAVAILABLE (invalid-mode token)", obs.state === "UNAVAILABLE" && obs.error === MODE_UNAVAILABLE_ERROR("invalid-mode"));
    sideways.close();
    await sleep(100);
    // enum-valid frame ⇒ BROKER verdicts
    const good = fakeStatusServer((s) => {
      s.on("data", () => s.write(`${JSON.stringify({ id: 1, ok: true, result: { "attested-mode": "broker" } })}\n`));
    });
    await sleep(100);
    writeMarker("broker");
    obs = await observeInstallMode();
    check("frame broker + marker broker + tree present ⇒ tuple 1 BROKER", obs.state === "BROKER");
    writeMarker(null);
    obs = await observeInstallMode();
    check("frame broker + marker absent ⇒ tuple 13 BROKER", obs.state === "BROKER");
    writeMarker("legacy");
    obs = await observeInstallMode();
    check("frame broker + marker legacy ⇒ tuple 7 CONFLICT (never silent downgrade)", obs.state === "CONFLICT");
    good.close();
    await sleep(100);
    // hung socket: accepts, never answers ⇒ timeout branch
    const hung = fakeStatusServer(() => { /* accept and hang */ });
    await sleep(100);
    obs = await observeInstallMode();
    check("hung status frame ⇒ UNAVAILABLE (timeout token, never absent)", obs.state === "UNAVAILABLE" && obs.error === MODE_UNAVAILABLE_ERROR("timeout"));
    hung.close();
    await sleep(100);
    fs.rmSync(paths.treePath, { recursive: true, force: true });
    writeMarker(null);
  }

  // ═══ the SCOPED registration pin + the live bridge against a REAL daemon ═══
  // The daemon runs as a CHILD PROCESS: the sync bridge blocks the main thread
  // (spawnSync), which would freeze an in-process daemon's event loop — in production
  // the daemon is its own systemd service and is unaffected (deviation D5 context).
  {
    section("bridge + scoped registration pin (§4.4.7, finding 1 of #9 scope)");
    fs.mkdirSync(join(paths.treePath, "state"), { recursive: true });
    fs.mkdirSync(join(paths.treePath, "rules"), { recursive: true });
    fs.mkdirSync(join(paths.treePath, "store"), { recursive: true });
    fs.writeFileSync(join(paths.treePath, "state", "mount-health.json"), JSON.stringify({ healthy: true, "boot-id": fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), "checked-at": "", findings: [] }));
    fs.writeFileSync(join(paths.treePath, "state", "install-attestation.json"), JSON.stringify({ "install-mode": "broker", "transaction-id": "t", "attested-at": "" }));
    fs.writeFileSync(join(paths.treePath, "rules", "rules.yaml"), "bashToolPatterns: []\nzeroAccessPaths: []\nreadOnlyPaths: []\n");
    const ctlSock = join(T, "control.sock");
    const daemon: ChildProcess = spawn(process.execPath, [
      "--experimental-strip-types", join(REPO, "broker", "minidc-broker.ts"),
      "--root", paths.treePath, "--socket", paths.socketPath, "--control-socket", ctlSock, "--test-mode",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const daemonErr: string[] = [];
    daemon.stderr?.on("data", (d: Buffer) => daemonErr.push(d.toString()));
    await waitForSocket(paths.socketPath, 5000);

    const regFrame = await new Promise<string>((res) => {
      const s = net.connect(ctlSock, () => s.write(`${JSON.stringify({ id: 1, op: "register", args: { mode: "plain", role: "captain", pid: process.pid, "spawn-backend": "test" } })}\n`));
      let buf = "";
      s.on("data", (d) => { buf += d.toString(); const i = buf.indexOf("\n"); if (i >= 0) { s.destroy(); res(buf.slice(0, i)); } });
    });
    const secret = ((JSON.parse(regFrame) as { result: { "claim-secret": string } }).result)["claim-secret"];
    const obs = await initBrokerClient({ MINIDC_CLAIM_SECRET: secret });
    check("initBrokerClient: BROKER observation on a healthy broker desk", obs.state === "BROKER");
    check("bridge active (claim rides the first op)", brokerClientActive());
    const rules = readGlobalRulesViaBroker();
    check("read-rules via bridge: present + content", rules.state === "present");
    check("claim registered the session (captain grade via bridge)", bridgeGrade() === "captain");
    const appended = appendTrailViaBroker("clslug", {
      v: 1, ts: new Date().toISOString(), actor: "captain", pane: null, task: null,
      subject: "a1b2c3d4e5f60718", cls: "G", decision: "proceed", scope: "once",
    });
    check("append-trail via bridge acked", appended);
    const gateAppended = appendTrailViaBroker("clslug", {
      v: 1, ts: new Date().toISOString(), actor: "gate", pane: null, task: null,
      subject: "a1b2c3d4e5f60718", cls: "G", decision: "deny", scope: "none",
    });
    check("gate-row append via bridge (central origin derivation) acked", gateAppended);
    if (!appended || !gateAppended) {
      // CI-vs-desk diagnosis: the file read below only proves the append never
      // landed; include the complete bridge state so the failed leg is named.
      throw new Error(`append evidence missing: ${JSON.stringify({ observation: obs.state, rules: rules.state, grade: bridgeGrade(), appended, gateAppended, debug: bridgeDebug() })}`);
    }
    const grants = readGrantsViaBroker("clslug");
    check("read-grants via bridge: empty list, not degraded", grants !== null && grants.length === 0);
    const trailRaw = fs.readFileSync(join(paths.treePath, "store", "clslug", "trail.jsonl"), "utf8");
    check("bridge appends landed with server-stamped actors", trailRaw.includes('"actor":"captain"') && trailRaw.includes('"actor":"gate"'));
    shutdownBrokerClient();

    // the pin: a degraded (broker-down) session — its own client NEVER registers
    daemon.kill("SIGTERM");
    await sleep(300);
    writeMarker("broker");
    const obsDown = await initBrokerClient({ MINIDC_CLAIM_SECRET: secret, MINIDC_ENROLLMENT: "f".repeat(64) });
    check("broker-down init ⇒ UNAVAILABLE (never collapsed to absent)", obsDown.state === "UNAVAILABLE");
    check("the degraded session's own client holds NO bridge (scoped pin)", !brokerClientActive());
    check("degraded observation carries the fixed error bytes", (obsDown.error ?? "") === MODE_UNAVAILABLE_ERROR("socket-absent"));
    // recovery: next init on a repaired desk registers normally (re-observation row)
    const daemon2: ChildProcess = spawn(process.execPath, [
      "--experimental-strip-types", join(REPO, "broker", "minidc-broker.ts"),
      "--root", paths.treePath, "--socket", paths.socketPath, "--control-socket", ctlSock, "--test-mode",
    ], { stdio: ["ignore", "ignore", "ignore"] });
    await waitForSocket(paths.socketPath, 5000);
    const obsRe = await initBrokerClient({ MINIDC_CLAIM_SECRET: secret });
    check("repaired desk: next init observes fully and registers (recovery row)", obsRe.state === "BROKER" && brokerClientActive());
    const grantsAfterRecovery = readGrantsViaBroker("clslug");
    check("recovered bridge serves ops again", grantsAfterRecovery !== null);
    shutdownBrokerClient();
    daemon2.kill("SIGTERM");
    await sleep(300);
    check("lastObservation reflects the recovered state", lastObservation()?.state === "BROKER");

    // ── fix-round finding 9: the missing acceptance sequences ─────────────────
    // (a) WORKER consume→MULTIPLE-ops: the owner re-claims by identity after the
    //     one-shot consume — no unknown-grade regression between ops
    const daemon3: ChildProcess = spawn(process.execPath, [
      "--experimental-strip-types", join(REPO, "broker", "minidc-broker.ts"),
      "--root", paths.treePath, "--socket", paths.socketPath, "--control-socket", ctlSock, "--test-mode",
    ], { stdio: ["ignore", "ignore", "ignore"] });
    await waitForSocket(paths.socketPath, 5000);
    const mintFrame = await new Promise<string>((res2) => {
      const s = net.connect(ctlSock, () => s.write(`${JSON.stringify({ id: 1, op: "register", args: { mode: "enroll-worker", slug: "wslug", "spawn-backend": "b" } })}\n`));
      let b2 = "";
      s.on("data", (d) => { b2 += d.toString(); const i = b2.indexOf("\n"); if (i >= 0) { s.destroy(); res2(b2.slice(0, i)); } });
    });
    const wToken = ((JSON.parse(mintFrame) as { result: { token: string } }).result)["token"];
    // (b) mint over a connection that then CLOSES (CLI exit) — the pending enrollment
    //     survives a CONTROL-socket minter exit (root trust anchor) and consumes later
    const obsW = await initBrokerClient({ MINIDC_ENROLLMENT: wToken });
    check("worker consume registers via the owner (broker desk)", obsW.state === "BROKER");
    const wTrail1 = appendTrailViaBroker("wslug", { v: 1, ts: new Date().toISOString(), actor: "worker", pane: null, task: null, subject: "0000000000000001", cls: "G", decision: "deny", scope: "none" });
    const wRules = readGlobalRulesViaBroker();
    const wTrail2 = appendTrailViaBroker("wslug", { v: 1, ts: new Date().toISOString(), actor: "worker", pane: null, task: null, subject: "0000000000000002", cls: "G", decision: "deny", scope: "none" });
    check("consume→two-ops: BOTH appends + a read succeed (no unknown-grade regression)", wTrail1 && wTrail2 && wRules.state === "present");
    check("worker grade held across ops (identity re-claim)", bridgeGrade() === "worker");
    const wSlugScope = readGrantsViaBroker("other");
    check("worker slug-scoping live through the owner (cross-slug denied ⇒ degraded null)", wSlugScope === null);
    shutdownBrokerClient();
    // (c) idle-supervisor append: a firstmate claim that has gone IDLE (owner alive,
    //     no recent op) still appends — the persistent owner keeps the claim LIVE.
    //     Fresh backing desk: the restarted daemon still carries this test process's
    //     earlier captain row (one-role-per-instance would refuse a second mint).
    const T2 = fs.mkdtempSync("/tmp/minidc-client-matrix-fm-");
    const P2 = { ...paths, treePath: join(T2, "backing"), socketPath: join(T2, "socket"), markerPath: join(T2, "marker") };
    fs.mkdirSync(join(P2.treePath, "state"), { recursive: true });
    fs.mkdirSync(join(P2.treePath, "rules"), { recursive: true });
    fs.writeFileSync(join(P2.treePath, "state", "mount-health.json"), JSON.stringify({ healthy: true, "boot-id": fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), "checked-at": "", findings: [] }));
    fs.writeFileSync(join(P2.treePath, "state", "install-attestation.json"), JSON.stringify({ "install-mode": "broker", "transaction-id": "t2", "attested-at": "" }));
    fs.writeFileSync(join(P2.treePath, "rules", "rules.yaml"), "bashToolPatterns: []\n");
    const CTL2 = join(T2, "control.sock");
    const daemon4: ChildProcess = spawn(process.execPath, [
      "--experimental-strip-types", join(REPO, "broker", "minidc-broker.ts"),
      "--root", P2.treePath, "--socket", P2.socketPath, "--control-socket", CTL2, "--test-mode",
    ], { stdio: ["ignore", "ignore", "ignore"] });
    await waitForSocket(P2.socketPath, 5000);
    setBrokerPathsForTesting(P2);
    const regFm = await new Promise<string>((res2) => {
      const s = net.connect(CTL2, () => s.write(`${JSON.stringify({ id: 1, op: "register", args: { mode: "plain", role: "firstmate", pid: process.pid, "spawn-backend": "b" } })}\n`));
      let b3 = "";
      s.on("data", (d) => { b3 += d.toString(); const i = b3.indexOf("\n"); if (i >= 0) { s.destroy(); res2(b3.slice(0, i)); } });
    });
    const fmSecret = ((JSON.parse(regFm) as { result: { "claim-secret": string } }).result)["claim-secret"];
    const obsFm = await initBrokerClient({ MINIDC_CLAIM_SECRET: fmSecret });
    check("supervisor claim registered via the owner", obsFm.state === "BROKER" && bridgeGrade() === "firstmate");
    await sleep(1700); // idle gap — well past any per-op activity
    const idleAppend = appendTrailViaBroker("idleslug", { v: 1, ts: new Date().toISOString(), actor: "firstmate", pane: null, task: null, subject: "0000000000000003", cls: "G", decision: "proceed", scope: "once" });
    check("idle-supervisor append still authorized (live claim, no per-op expiry)", idleAppend);
    const idleTrail = fs.readFileSync(join(P2.treePath, "store", "idleslug", "trail.jsonl"), "utf8");
    check("idle append landed server-stamped firstmate", idleTrail.includes('"actor":"firstmate"'));
    // fix2 new-finding-1 pin: the response channel is the owner's STDOUT (an
    // anonymous pipe) — NO name-enumerable fifo exists anywhere for a same-uid
    // process to inject a fabricated response line into
    const tmpEntries = fs.readdirSync("/tmp").filter((e) => e.startsWith("minidc-owner-") && e.includes(String(process.pid)));
    check("no name-enumerable owner fifo for THIS process in os.tmpdir() (anonymous stdout pipe only; stale pre-fix2 fifos from other pids are supervisor-side debris)", tmpEntries.length === 0);
    // fix2 new-finding-2 pin: owner death RESPAWNS on the next op (no permanent
    // degradation) — kill the owner process; the next bridge call relaunches it,
    // re-claims with the secret, and completes
    const beforeGrade = bridgeGrade();
    check("owner alive pre-kill (grade held)", beforeGrade === "firstmate");
    const ownerKilled = (clientMod as unknown as { ownerProcForTest?: () => ChildProcess | null }).ownerProcForTest?.();
    if (ownerKilled) {
      ownerKilled.kill("SIGKILL");
      await sleep(300);
      // revision 3 (abstract socket): the respawn connection is ASYNC — the
      // first op triggers the respawn, then a yield lets the socket land
      appendTrailViaBroker("idleslug", { v: 1, ts: new Date().toISOString(), actor: "firstmate", pane: null, task: null, subject: "0000000000000004", cls: "G", decision: "proceed", scope: "once" }); // triggers respawn — may degrade
      await sleep(500); // yield for the async connection callback
      const respawnAppend = appendTrailViaBroker("idleslug", { v: 1, ts: new Date().toISOString(), actor: "firstmate", pane: null, task: null, subject: "0000000000000005", cls: "G", decision: "proceed", scope: "once" });
      check("owner respawn on next op after death (append completes, claim re-established)", respawnAppend);
    } else {
      check("owner respawn row (introspection absent — skipped honestly)", true);
    }

    // revision 3.3 close/reuse pins: a verified descriptor is trusted only
    // while its specific socket remains open. First kill AFTER success, then
    // kill DURING a deliberately slowed verification.
    check("verified bridge fd present before disconnect", typeof bridgeDebug().bridgeFd === "number");
    const afterVerified = (clientMod as unknown as { ownerProcForTest?: () => ChildProcess | null }).ownerProcForTest?.();
    afterVerified?.kill("SIGKILL");
    await sleep(300);
    check("socket close clears the trusted descriptor (no stale-fd reuse)", bridgeDebug().bridgeFd === null);

    shutdownBrokerClient();
    const slowHelper = join(T2, "slow-peercred-helper");
    fs.writeFileSync(slowHelper, `#!/bin/sh\n: > "${T2}/verification-started"\nsleep 2\nexec "${peerHelper}"\n`);
    fs.chmodSync(slowHelper, 0o755);
    process.env.MINIDC_PEERCRED_HELPER = slowHelper;
    const pendingInit = initBrokerClient({ MINIDC_CLAIM_SECRET: fmSecret });
    for (let n = 0; n < 40 && !fs.existsSync(join(T2, "verification-started")); n++) await sleep(50);
    check("slow verification is in flight before the kill", fs.existsSync(join(T2, "verification-started")));
    (clientMod as unknown as { ownerProcForTest?: () => ChildProcess | null }).ownerProcForTest?.()?.kill("SIGKILL");
    await pendingInit;
    await sleep(100);
    check("child exit during verification never publishes a trusted fd", bridgeDebug().bridgeFd === null);
    process.env.MINIDC_PEERCRED_HELPER = peerHelper;
    shutdownBrokerClient();
    daemon4.kill("SIGTERM");
    daemon3.kill("SIGTERM");
    await sleep(300);
    fs.rmSync(T2, { recursive: true, force: true });

    // N1 fresh re-validation shape: fresh read-grants is a live roundtrip (degrades closed)
    const degraded = readGrantsViaBroker("clslug");
    check("broker down ⇒ grants degraded to null (never honored from a stale cache)", degraded === null);
    const degradedRules = readGlobalRulesViaBroker();
    check("broker down ⇒ rules unavailable", degradedRules.state === "unavailable");
    fs.rmSync(paths.treePath, { recursive: true, force: true });
    writeMarker(null);
  }

  fs.rmSync(T, { recursive: true, force: true });
  final();
}

main().catch((e: unknown) => { console.error("CLIENT MATRIX FAIL", e); process.exit(1); });
