// extensions/minidc-broker-client.ts — the R2 broker client (design §7.4):
// the synchronous bridge (worker_threads + Atomics.wait, 3000 ms hard timeout), the
// §4.6.5a client mode-observation law (TRI-STATE probes, fail-closed BEFORE the tuple
// table, the single SCOPED no-registration pin), the §4.6.5 closed-world 18-tuple
// reconciliation, mode-derived rules paths, the prefetch cache, per-ask grant
// re-validation (N1 §4.5), reconnect + bounded backoff + the 15 s background re-claim
// loop (started only on a non-UNAVAILABLE observation), and the central origin
// derivation (§4.4.4: origin = actor==="gate" ? "gate" : "seat" — ONE derivation point).
//
// The socket/tree/marker paths are module seams (setBrokerPathsForTesting) — NOT
// env-readable in production. A worker cannot redirect the client to a socket it owns.
//
// Deviations D1a–D1d (no SO_PEERCRED in Node v26) are documented in the daemon header
// and the build report; their client-side consequences: claims carry a claim-secret
// (MINIDC_CLAIM_SECRET, set by the launch wrapper), consumes carry the enrollment token
// (MINIDC_ENROLLMENT), and supervisor connections export MINIDC_SURFACE_SECRET for
// their own tool-children (ancestry appends).

import * as net from "node:net";
import * as fs from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

// ═══════════════ paths + seams ════════════════════════════════════════════════
export interface BrokerPaths {
  treePath: string;      // /var/lib/minidc-broker — world-traversable, stat-able
  socketPath: string;    // /run/minidc-broker/socket
  markerPath: string;    // ~/.pi/agent/mini-dc-install-mode (advisory only)
  attestedRulesPath: string; // broker-mode rules dir (protection + status text)
  legacyRulesPath: string;   // legacy-mode rules file (unchanged path)
}

let pathsOverride: BrokerPaths | null = null;
export function setBrokerPathsForTesting(p: BrokerPaths | null): void {
  pathsOverride = p;
}
export function brokerPaths(): BrokerPaths {
  return (
    pathsOverride ?? {
      treePath: "/var/lib/minidc-broker",
      socketPath: "/run/minidc-broker/socket",
      markerPath: join(os.homedir(), ".pi", "agent", "mini-dc-install-mode"),
      attestedRulesPath: join(os.homedir(), ".pi", "agent", "mini-dc-rules"),
      legacyRulesPath: join(os.homedir(), ".pi", "agent", "mini-dc-rules.yaml"),
    }
  );
}

const CONNECT_TIMEOUT_MS = 1500;
const RESPONSE_TIMEOUT_MS = 3000;
const BACKOFF_MS = [250, 500, 1000, 2000]; // bounded exponential (§4.4.6)
const BACKGROUND_RECLAIM_MS = 15_000;

// ═══════════════ §4.6.5a — tri-state probes + the observation law ═════════════
export type TreeProbe = { kind: "present" } | { kind: "absent" } | { kind: "error"; errno: string };
export type SocketProbe =
  | { kind: "live" }
  | { kind: "not-live"; errno: "ENOENT" | "ECONNREFUSED" }
  | { kind: "error"; errno: string }
  | { kind: "timeout" };

export function probeTree(path: string): TreeProbe {
  try {
    fs.statSync(path);
    return { kind: "present" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT") return { kind: "absent" }; // clean ENOENT is the only absence
    return { kind: "error", errno: code };            // EACCES/EIO/… ⇒ NO evidence either way
  }
}

export function probeSocket(path: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<SocketProbe> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (p: SocketProbe) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* already gone */ }
      resolve(p);
    };
    const s = net.connect(path, () => {
      // clean connection ⇒ live. One status roundtrip follows separately.
      done({ kind: "live" });
    });
    s.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") done({ kind: "not-live", errno: e.code });
      else done({ kind: "error", errno: e.code ?? "UNKNOWN" });
    });
    setTimeout(() => done({ kind: "timeout" }), timeoutMs).unref?.();
  });
}

/** Status frame fetch (bounded): a well-formed frame carrying an in-enum attested-mode. */
export type StatusFrameResult =
  | { ok: true; "attested-mode": "broker" | "legacy" | "absent" }
  | { ok: false; why: "socket-absent" | "refused" | "timeout" | "malformed" | "invalid-mode" | "probe-error" };

export function fetchStatusFrame(socketPath: string): Promise<StatusFrameResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: StatusFrameResult) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* gone */ }
      resolve(r);
    };
    const s = net.connect(socketPath, () => {
      s.write(`${JSON.stringify({ id: 1, op: "status", args: {} })}\n`);
      setTimeout(() => finish({ ok: false, why: "timeout" }), RESPONSE_TIMEOUT_MS).unref?.();
    });
    let buf = "";
    s.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try {
        const frame = JSON.parse(buf.slice(0, i)) as { ok?: unknown; result?: { "attested-mode"?: unknown } };
        if (frame.ok !== true || typeof frame.result !== "object" || frame.result === null) {
          finish({ ok: false, why: "malformed" });
          return;
        }
        const am = (frame.result as Record<string, unknown>)["attested-mode"];
        if (am === "broker" || am === "legacy" || am === "absent") {
          finish({ ok: true, "attested-mode": am });
        } else {
          finish({ ok: false, why: "invalid-mode" }); // missing/out-of-enum/non-string
        }
      } catch {
        finish({ ok: false, why: "malformed" });
      }
    });
    s.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") finish({ ok: false, why: "socket-absent" });
      else if (e.code === "ECONNREFUSED") finish({ ok: false, why: "refused" });
      else finish({ ok: false, why: "probe-error" });
    });
    setTimeout(() => finish({ ok: false, why: "timeout" }), CONNECT_TIMEOUT_MS + RESPONSE_TIMEOUT_MS).unref?.();
  });
}

// ═══════════════ §4.6.5 — the closed-world 18-tuple table ═════════════════════
export type MarkerValue = "broker" | "legacy" | "absent";
export type AttestationValue = "broker" | "legacy" | "absent";
export type ObservablesValue = "present" | "absent";
export type TupleVerdict = "BROKER" | "LEGACY" | "CONFLICT";

export function tupleVerdict(
  marker: MarkerValue,
  attestation: AttestationValue,
  observables: ObservablesValue,
): TupleVerdict {
  // BROKER ⟺ attestation broker AND observables present AND marker ∈ {broker, absent}
  if (attestation === "broker" && observables === "present" && (marker === "broker" || marker === "absent")) {
    return "BROKER";
  }
  // LEGACY ⟺ no broker-valued record exists AND no broker observable exists
  if (marker !== "broker" && attestation !== "broker" && observables === "absent") {
    return "LEGACY";
  }
  return "CONFLICT";
}

export function readMarkerValue(markerPath: string): MarkerValue {
  try {
    const v = fs.readFileSync(markerPath, "utf8").trim();
    if (v === "broker" || v === "legacy") return v;
    return "absent"; // unreadable/corrupt marker treated as absent — advisory best-effort
  } catch {
    return "absent";
  }
}

export const MODE_UNAVAILABLE_ERROR = (token: string): string =>
  `🛑 mini-dc: install-mode UNAVAILABLE (broker evidence present or unobservable, attestation unobtainable: ${token}) — run sudo install.sh --repair-mode to reconcile before any gated operation`;

export const MODE_CONFLICT_ERROR = (m: string, a: string, o: string): string =>
  `🛑 mini-dc: install-mode conflict (marker=${m}, attested=${a}, observed=${o}) — run sudo install.sh --repair-mode to reconcile before any gated operation`;

export interface ModeObservation {
  state: TupleVerdict | "UNAVAILABLE";
  marker: MarkerValue;
  attestation: AttestationValue | null; // null when unobtainable (UNAVAILABLE shapes)
  observables: ObservablesValue | null;
  error?: string; // the fixed error bytes for UNAVAILABLE/CONFLICT
  reason?: string; // short machine token for status text
}

/** The §4.6.5a observation procedure — runs at every session init, BEFORE any tuple
 *  selection and BEFORE ANY registration attempt BY THE SESSION'S OWN CLIENT (the
 *  single law, scoped per finding 1 of #9 — bootstrap connectors are exempt). */
export async function observeInstallMode(): Promise<ModeObservation> {
  const p = brokerPaths();
  const tree = probeTree(p.treePath);
  const marker = readMarkerValue(p.markerPath);

  if (tree.kind === "present") {
    // attestation input is observable ONLY via a well-formed, enum-valid status frame
    const frame = await fetchStatusFrame(p.socketPath);
    if (!frame.ok) {
      return {
        state: "UNAVAILABLE", marker, attestation: null, observables: "present",
        error: MODE_UNAVAILABLE_ERROR(frame.why), reason: `unavailable:${frame.why}`,
      };
    }
    return settle(marker, frame["attested-mode"], "present");
  }
  if (tree.kind === "absent") {
    // structural derivation: the attestation's only home is the missing namespace
    const sock = await probeSocket(p.socketPath);
    if (sock.kind === "not-live") {
      return settle(marker, "absent", "absent"); // tuples 6/12/18 — pre-install, legacy, residue
    }
    if (sock.kind === "live") {
      const frame = await fetchStatusFrame(p.socketPath);
      // finding 3 fix: a live socket IS a broker observable (socket-OR-tree law) —
      // passing "absent" here admitted legacy tuples over a live broker
      if (frame.ok) return settle(marker, frame["attested-mode"], "present"); // daemon-confirmed
      return {
        state: "UNAVAILABLE", marker, attestation: null, observables: "absent",
        error: MODE_UNAVAILABLE_ERROR(frame.why), reason: `unavailable:${frame.why}`,
      };
    }
    // socket probe-error (or timeout): UNAVAILABLE — never mechanically not-live
    const why = sock.kind === "timeout" ? "timeout" : `probe-error:${sock.errno}`;
    return {
      state: "UNAVAILABLE", marker, attestation: null, observables: "absent",
      error: MODE_UNAVAILABLE_ERROR(why), reason: `unavailable:${why}`,
    };
  }
  // tree probe-error ⇒ UNAVAILABLE, never absent
  const why = `probe-error:tree:${tree.errno}`;
  return {
    state: "UNAVAILABLE", marker, attestation: null, observables: null,
    error: MODE_UNAVAILABLE_ERROR(why), reason: `unavailable:${why}`,
  };
}

function settle(
  marker: MarkerValue,
  attestation: AttestationValue,
  observables: ObservablesValue,
): ModeObservation {
  const verdict = tupleVerdict(marker, attestation, observables);
  if (verdict === "CONFLICT") {
    return {
      state: "CONFLICT", marker, attestation, observables,
      error: MODE_CONFLICT_ERROR(marker, attestation, observables), reason: "conflict",
    };
  }
  return { state: verdict, marker, attestation, observables };
}

// ═══════════════ the synchronous bridge (worker_threads + Atomics.wait) ═══════
export interface BridgeResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  retryable?: boolean;
  reason?: string;
}

// ═══════════════ the synchronous bridge (D5: helper PROCESS per op) ════════════
// DEVIATION D5 (build-round finding, empirically pinned): Node v26.13.1 STALLS
// worker-thread event loops while the main thread is inside Atomics.wait (the
// §4.4.7 sketch — a worker owning the async socket + main Atomics.wait — cannot
// answer anything during the wait; pinned by a timeline probe: zero worker timer
// ticks inside a 2 s main-thread wait). The design's own fallback discipline
// applies (§4.4.5 names the per-op CLI bridge with its stated limits — made
// primary here): every op spawns a short-lived helper PROCESS that connects,
// registers (claim/consume), performs the op, and prints the response frame.
// per-op helper carries a HARD timeout (3.2 s) — never a hang. The session's
// kernel identity travels via env (MINIDC_SESSION_PID/STARTTIME — the client-
// asserted model of D1d; /proc-verified server-side). Degradation law unchanged:
// any failure ⇒ the op's degraded return per §6.
let bridgeReady = false;
let bridgeGradeValue: string | null = null;
let observationState: ModeObservation | null = null;
// the persistent OWNER process (fix-round finding 2): one long-lived child that
// connects ONCE, registers (consume-or-claim), and KEEPS the connection open —
// the claim stays LIVE between ops (idle supervisors stay authorized), pending
// enrollments minted over the owner's connection survive, and consumed workers
// never re-enter unknown grade. Ops travel: main writes a request line to the
// owner's stdin (async), the owner forwards over ITS registered connection, and
// writes the response line to its STDOUT — an anonymous pipe only this process
// holds (fix2: no name-enumerable fifo, no same-uid response injection); main
// polls it with readSync — the OWNER is a separate process, so the empirically-
// pinned Node stall (worker threads freeze during main-thread blocking) cannot
// touch it. Owner death ⇒ pipe EOF (never a hang) and the NEXT op respawns it; a
// stuck-but-alive owner answers within its own 3 s op budget or the call degrades.
interface OwnerState {
  proc: ChildProcess;
  outFd: number | null; // the stdout pipe fd (internal handle; anonymous pipe —
  // NOT name-enumerable in /tmp: no same-uid process can inject a response line)
  dead: boolean;
}
let owner: OwnerState | null = null;
// fix2 new-finding-2: owner respawn. A dead owner no longer degrades the session
// forever — bridgeCall respawns once per call before degrading. Documented in the
// report as the §6-consistent recovery (bounded: one respawn attempt per op).

export function lastObservation(): ModeObservation | null {
  return observationState;
}
export function brokerClientActive(): boolean {
  return bridgeReady && owner !== null && !owner.dead;
}

export function bridgeGrade(): string | null {
  return bridgeGradeValue;
}
export function bridgeConnected(): boolean {
  return brokerClientActive();
}

function selfStatOf(pid: number): string {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/)[19] ?? "";
  } catch {
    return "";
  }
}

let bridgeEnvs: Record<string, string | undefined> = {};

function startBridge(env: Record<string, string | undefined>): void {
  // fix2 new-finding-1: NO named fifo — responses ride the owner's STDOUT (an
  // anonymous pipe): not name-enumerable anywhere, so no same-uid process can
  // inject a fabricated response line. The fd comes from the internal handle
  // (undocumented but stable); readSync on it works with EAGAIN poll-continue.
  const proc = spawn(process.execPath, ["-e", OWNER_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MINIDC_SESSION_PID: String(process.pid),
      MINIDC_SESSION_STARTTIME: selfStatOf(process.pid),
      MINIDC_SOCKET: brokerPaths().socketPath,
      ...(env["MINIDC_ENROLLMENT"] ? { MINIDC_ENROLLMENT: env["MINIDC_ENROLLMENT"] } : {}),
      ...(env["MINIDC_CLAIM_SECRET"] ? { MINIDC_CLAIM_SECRET: env["MINIDC_CLAIM_SECRET"] } : {}),
    },
  });
  const st: OwnerState = { proc, outFd: null, dead: false };
  bridgeEnvs = env;
  proc.on("exit", () => { st.dead = true; });
  proc.stderr?.on("data", (d: Buffer) => {
    const m = /C:(ok|fail):(\S*)(?: S:(\S+))?/.exec(d.toString());
    if (!m) return;
    if (m[1] === "ok") {
      bridgeGradeValue = m[2] ?? null;
      if (m[3] && !process.env["MINIDC_SURFACE_SECRET"]) {
        // export the supervisor's surface-secret + identity for its own tool-children
        process.env["MINIDC_SURFACE_SECRET"] = m[3] as string;
        process.env["MINIDC_PID"] = String(process.pid);
        process.env["MINIDC_STARTTIME"] = selfStatOf(process.pid);
      }
    } else {
      bridgeGradeValue = null;
    }
  });
  // no 'data' listener on stdout: the stream stays paused, the fd stays ours alone
  const handle = (proc.stdout as unknown as { _handle?: { fd?: number } | null })._handle;
  st.outFd = typeof handle?.fd === "number" ? handle.fd : null;
  owner = st;
  bridgeReady = true;
}

/** fix2 new-finding-2: respawn the owner after death — the next op relaunches it
 *  (fresh connect + claim) instead of degrading the session forever. */
function ensureOwner(): OwnerState | null {
  const st = owner;
  if (st && !st.dead) return st;
  if (!bridgeReady) return null;
  try { st?.proc.kill("SIGKILL"); } catch { /* gone */ }
  startBridge(bridgeEnvs);
  return owner && !owner.dead ? owner : null;
}

function sleepSyncMs(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

/** Session init: observation FIRST (the law), then — only on a usable BROKER mode —
 *  bridge startup. LEGACY sessions never connect. UNAVAILABLE/CONFLICT sessions never
 *  connect and never register (the scoped pin) — their own client holds no connection,
 *  no claim, no loop, for the session's whole life (§4.6.5a). */
export async function initBrokerClient(env: Record<string, string | undefined>): Promise<ModeObservation> {
  observationState = await observeInstallMode();
  if (observationState.state === "BROKER") {
    startBridge(env);
    // bounded registration wait: ops fired before the owner's register round-trip
    // would land as unknown-grade; wait for the grade marker (or a 2 s budget —
    // a failed registration leaves every op failing closed per §4.3.1 either way)
    const t0 = Date.now();
    while (bridgeGradeValue === null && owner !== null && !owner.dead && Date.now() - t0 < 2000) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return observationState;
}

/** The OWNER source — the persistent registration owner (fix-round finding 2).
 *  Plain CJS; no secrets inline (they ride env). Connects ONCE, registers (consume
 *  first when a token is present, else claim), keeps the connection open for the
 *  session's life, reconnects with bounded backoff + identity re-claim on socket
 *  loss, and serves op frames line-by-line: stdin line in → broker frame out →
 *  response line written to the fifo. Every op answers within 3 s (its own budget)
 *  so the main thread's blocking read can never wedge. Exported for direct testing. */
export const OWNER_SOURCE = `
const net = require("node:net");
const sockPath = process.env.MINIDC_SOCKET;
const pid = Number(process.env.MINIDC_SESSION_PID || 0);
const starttime = process.env.MINIDC_SESSION_STARTTIME || "";
let enrollment = process.env.MINIDC_ENROLLMENT || "";
const claimSecret = process.env.MINIDC_CLAIM_SECRET || "";
let sock = null;
let connected = false;
let registered = false;
let buf = "";
let nextId = 10;
const pending = new Map();
let backoffN = 0;
let stopped = false;

// fix2 new-finding-1: responses ride STDOUT — an anonymous pipe, not a
// name-enumerable fifo; only the parent holds the read end
function writeResp(obj) {
  try { process.stdout.write(JSON.stringify(obj) + "\\n"); } catch (e) { /* reader gone */ }
}
function send(op, args, cb) {
  if (!sock || !connected) { cb({ ok: false, error: "E_UNAVAILABLE", reason: "owner-disconnected" }); return; }
  const id = nextId++;
  pending.set(id, cb);
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); cb({ ok: false, error: "E_UNAVAILABLE", reason: "owner-op-timeout" }); } }, 3000);
  sock.write(JSON.stringify({ id, op, args }) + "\\n");
}
function register() {
  const args = enrollment
    ? { mode: "consume", token: enrollment, pid, starttime }
    : { mode: "claim", pid, starttime, ...(claimSecret ? { secret: claimSecret } : {}) };
  send("register", args, (f) => {
    if (f.ok === true) {
      registered = true;
      enrollment = ""; // consumed: later re-claims ride identity
      const r = f.result || {};
      let line = "C:ok:" + (r.grade ? r.grade : "?");
      if (r["surface-secret"]) line += " S:" + r["surface-secret"];
      process.stderr.write(line + "\\n");
    } else if (f.retryable === true) {
      setTimeout(register, 500); // delay-budget retry (never a surfaced denial)
    } else {
      process.stderr.write("C:fail:" + (f.error || "?") + "\\n");
    }
  });
}
function connect() {
  if (stopped) return;
  sock = net.connect(sockPath, () => {
    connected = true;
    buf = "";
    backoffN = 0;
    if (!registered) register(); else reClaim();
  });
  sock.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const f = JSON.parse(line);
        const cb = pending.get(f.id);
        if (cb) { pending.delete(f.id); cb(f); }
      } catch (e) { /* malformed */ }
    }
  });
  sock.on("error", () => { connected = false; });
  sock.on("close", () => {
    connected = false;
    registered = false; // the claim died with the socket — re-claim on reconnect
    const wait = backoffN >= 4 ? 2000 : [250, 500, 1000, 2000][backoffN++];
    setTimeout(() => { if (!connected && !stopped) connect(); }, wait);
  });
}
function reClaim() {
  // fix2 finding1: EVERY pre-pinned claim carries the secret — re-claims too
  send("register", { mode: "claim", pid, starttime, ...(claimSecret ? { secret: claimSecret } : {}) }, (f) => {
    if (f.ok === true) {
      registered = true;
      const r = f.result || {};
      if (r["surface-secret"]) process.stderr.write("C:ok:" + (r.grade || "?") + " S:" + r["surface-secret"] + "\\n");
    } else if (f.retryable === true) { setTimeout(reClaim, 500); }
  });
}
// op pump: one JSON line per op from stdin; answer on the fifo
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "shutdown") { stopped = true; try { sock.destroy(); } catch (e) {} process.exit(0); }
  let req; try { req = JSON.parse(line); } catch (e) { writeResp({ ok: false, error: "E_UNAVAILABLE", reason: "owner-bad-request" }); return; }
  send(req.op, req.args, (f) => writeResp(f));
});
// the 15 s background re-claim loop (§4.4.6): rebinds after daemon restarts while idle
setInterval(() => { if (!connected) return; if (!registered) reClaim(); }, 15000);
connect();
`;

export interface BridgeResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  retryable?: boolean;
  reason?: string;
}

export function bridgeCall(
  op: string,
  args: Record<string, unknown>,
  timeoutMs = 3200,
): BridgeResult | null {
  if (!bridgeReady) return null;
  // fix2 new-finding-2: a dead owner RESPAWNS here (one attempt per call) — the
  // session recovers on the next op instead of degrading forever
  const st0 = owner;
  const st = st0 && !st0.dead && st0.outFd !== null ? st0 : ensureOwner();
  if (!st || st.outFd === null) return null;
  try {
    st.proc.stdin?.write(`${JSON.stringify({ op, args })}\n`);
    // poll the owner's STDOUT pipe (fix2: anonymous, not name-enumerable — no
    // same-uid response injection); the OWNER is a separate process (immune to
    // the Node main-thread stall); owner death ⇒ readSync returns EOF.
    const deadline = Date.now() + timeoutMs;
    let line = "";
    const chunk = Buffer.alloc(1 << 16);
    for (;;) {
      let n: number;
      try {
        n = fs.readSync(st.outFd, chunk, 0, chunk.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
          if (Date.now() > deadline) return null; // budget spent — degraded
          sleepSyncMs(2);
          continue;
        }
        if ((e as NodeJS.ErrnoException).code === "EINTR") continue;
        throw e; // pipe gone
      }
      if (n <= 0) { st.dead = true; return null; } // EOF — owner died
      line += chunk.toString("utf8", 0, n);
      const i = line.indexOf("\n");
      if (i >= 0) {
        const raw = line.slice(0, i);
        try {
          return JSON.parse(raw) as BridgeResult;
        } catch {
          return null; // malformed — degraded, never a guess
        }
      }
      if (Date.now() > deadline) return null; // owner overran its own budget — degraded
    }
  } catch {
    return null; // pipe gone — degraded, never a hang
  }
}

/** test introspection: the live owner process (kill it to pin the respawn law). */
export function ownerProcForTest(): ChildProcess | null {
  return owner ? owner.proc : null;
}

export function shutdownBrokerClient(): void {
  const st = owner;
  if (st) {
    try { st.proc.stdin?.write("shutdown\n"); } catch { /* gone */ }
    setTimeout(() => { try { st.proc.kill("SIGKILL"); } catch { /* gone */ } }, 250).unref?.();
    owner = null;
  }
  bridgeReady = false;
  bridgeGradeValue = null;
}

// ── the gate-facing operations (degradation per §6: never a hang, never a guess) ──
export interface BrokerTrailEntry {
  v: number;
  ts: string;
  actor: string;
  pane: string | null;
  task: string | null;
  subject: string;
  cls: string;
  decision: string;
  scope: string;
  message?: string;
}
export interface BrokerGrantRow {
  id: string;
  "created-at": string;
  "creator-seat": string;
  pattern: string;
  "class-filter": "R";
}

export type GlobalRulesResult =
  | { state: "present"; content: string }
  | { state: "absent" }
  | { state: "unavailable"; reason: string };

export function readGlobalRulesViaBroker(): GlobalRulesResult {
  const r = bridgeCall("read-rules", {});
  if (r === null) return { state: "unavailable", reason: "bridge-timeout" };
  if (r.ok !== true) return { state: "unavailable", reason: r.reason ?? r.error ?? "broker-error" };
  const res = r.result as { state?: string; content?: string };
  if (res.state === "absent") return { state: "absent" };
  if (res.state === "present" && typeof res.content === "string") return { state: "present", content: res.content };
  return { state: "unavailable", reason: "malformed-frame" };
}

export function appendTrailViaBroker(slug: string, entry: BrokerTrailEntry): boolean {
  // the CENTRAL origin derivation (§4.4.4): the frame may omit origin; the server
  // re-derives from the actor field and refuses disagreement
  const origin = entry.actor === "gate" ? "gate" : "seat";
  const r = bridgeCall("append-trail", { slug, entry, origin });
  if (r === null || r.ok !== true) return false;
  return (r.result as { appended?: boolean }).appended === true;
}

export function readTrailViaBroker(slug: string): BrokerTrailEntry[] | null {
  const r = bridgeCall("read-trail", { slug });
  if (r === null) return null; // degraded ⇒ PRIOR absent
  if (r.ok !== true) return null;
  return (r.result as { entries: BrokerTrailEntry[] }).entries ?? null;
}

export function readGrantsViaBroker(slug: string): BrokerGrantRow[] | null {
  const r = bridgeCall("read-grants", { slug });
  if (r === null) return null; // degraded ⇒ no grants honored
  if (r.ok !== true) return null;
  return (r.result as { grants: BrokerGrantRow[] }).grants ?? null;
}

export function createGrantViaBroker(
  slug: string,
  pattern: string,
): { id: string } | { error: string } {
  const r = bridgeCall("create-grant", { slug, pattern });
  if (r === null) return { error: "bridge-unavailable" };
  if (r.ok !== true) return { error: r.error ?? "E_UNAVAILABLE" };
  return { id: (r.result as { id: string }).id };
}

export function revokeGrantViaBroker(slug: string, id: string): boolean {
  const r = bridgeCall("revoke-grant", { slug, id });
  return r !== null && r.ok === true;
}

export function writeRulesViaBroker(content: string): boolean {
  const r = bridgeCall("write-rules", { content });
  return r !== null && r.ok === true;
}

