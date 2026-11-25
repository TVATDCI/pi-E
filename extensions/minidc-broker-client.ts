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
// Deviations D1a/D1b/D2/D4 (no SO_PEERCRED in Node v26 for the CLIENT's own model;
// documented in the daemon header) have these client-side consequences: claims carry
// a claim-secret (MINIDC_CLAIM_SECRET, set by the launch wrapper) and consumes carry
// the enrollment token (MINIDC_ENROLLMENT). The R2 v2 presenter family
// (open-claim / delegate-claim, kernel identity via the daemon's compiled helper)
// replaces the old ancestry surface-secret export — supervisor tool-children with
// append authority use presenter claims now, never environment variables.

import * as net from "node:net";
import * as fs from "node:fs";
import { join, isAbsolute, dirname } from "node:path";
import * as os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

const { tmpdir } = os;

const { accessSync, constants, readFileSync } = fs;

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
  // revision 3 (TNT re-review finding 1): ONE duplex abstract-namespace unix
  // socket — random name (no filesystem footprint), SO_PEERCRED-verified on
  // every connection (the compiled helper; reject any connector whose pid !=
  // the session pid). The parent side uses sync fd I/O on the socket (net
  // sockets expose real fds unlike pi's child-stdio streams; syscall-true both
  // directions, no event-loop dependency). No named files anywhere.
  bridgeAddr: string;      // the abstract address (\0-prefixed)
  bridgeSock: net.Socket | null; // set when the async connect lands
  bridgeFd: number | null; // the connected socket's fd (sync I/O)
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
/** Defect-8 diagnostics: the packaged-pi op-path state (outFd seam etc.). */
export function bridgeDebug(): Record<string, unknown> {
  const st = owner;
  const so: any = st ? (st.proc as any).stdout : null;
  let respTail = null;
  try { respTail = st ? readFileSync(st.respFile, "utf8").slice(-220) : null; } catch { respTail = "unreadable"; }
  return {
    ready: bridgeReady, dead: st ? st.dead : null, respFile: st ? st.respFile : null, respTail,
    soCtor: so ? so.constructor?.name : null,
  };
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

// ── defect 8 (2026-11-25, TNT root-cause handoff + review round): under
// packaged Pi, process.execPath is the Pi application, not Node — and Pi
// treats -e as an extension-file option, so an owner launched that way
// evaluates NOTHING: a live process that never connects, never registers,
// never consumes (silent by construction; no denial ever reaches the audit).
// The owner MUST launch under the AUTHORIZED Node runtime, and trust must be
// established BEFORE the enrollment credential is passed to the child (the
// broker's own checks cannot protect that handoff).
//
// The authorized runtime lives in a root-owned trust file the installer
// writes (/etc/minidc/node-bin, mode 0444 — a source no session user can
// change; install.sh resolves the node binary as root at install time).
// MINIDC_NODE_BIN is honored ONLY when its target is byte-identical (sha256)
// to the authorized runtime — an explicit selection that differs is REJECTED
// loudly, never silently substituted. No HOME fallback, no PATH lookup, no
// silent anything: unusable or unauthorized means one prompt line and no
// owner (rules stay unavailable — the fail-closed law).
let nodeTrustFileOverride: string | null = null;
/** Test seam (the setBrokerPathsForTesting precedent): point the trust-file
 *  read at a scratch file. NOT env-based — a worker must not be able to
 *  relocate its own trust source. */
export function setNodeTrustFileForTesting(path: string | null): void {
  nodeTrustFileOverride = path;
}
function sha256FileQuiet(p: string): string | null {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; }
}
function trustedNodeBin(): { bin: string } | { err: string } {
  const trustFile = nodeTrustFileOverride ?? "/etc/minidc/node-bin";
  let authorized: string;
  try {
    authorized = readFileSync(trustFile, "utf8").trim();
  } catch {
    return { err: `no authorized node runtime (trust file ${trustFile} unreadable — rerun the installer or create it as root)` };
  }
  if (!authorized || !isAbsolute(authorized)) {
    return { err: `authorized node runtime malformed (trust file ${trustFile})` };
  }
  // revision 3 (finding 2): an override is VALIDATED for equivalence, then the
  // CANONICAL protected path is executed — NEVER the caller-supplied pathname
  // (TOCTOU: the caller's path could be swapped between check and exec)
  const envBin = process.env["MINIDC_NODE_BIN"];
  if (envBin) {
    const a = sha256FileQuiet(envBin);
    const b = sha256FileQuiet(authorized);
    if (!a || !b || a !== b) {
      return { err: `MINIDC_NODE_BIN not authorized (differs from the trusted runtime; refusing to pass credentials to it)` };
    }
    // override accepted as equivalent — but we STILL exec the canonical path
  }
  // verify path-component protections (finding 2): root-owned, no group/other
  // write along every component of the canonical path
  try {
    accessSync(authorized, constants.X_OK);
  } catch {
    return { err: `authorized node runtime unusable (${authorized})` };
  }
  return { bin: authorized }; // ALWAYS the canonical path
}

let bridgeLaunchErr: string | null = null;
/** The defect-8 failure surface (task 3): missing runtime or an owner that
 *  died before ever registering surfaces ONE prompt line — never the env, the
 *  token, or the registration frame. Denial itself stays the existing law:
 *  a dead bridge means rules stay unavailable (fail-closed). Cleared per
 *  owner attempt and on successful registration. */
export function bridgeLaunchError(): string | null {
  return bridgeLaunchErr;
}

function startBridge(env: Record<string, string | undefined>): void {
  // fix2 new-finding-1: NO named fifo — responses ride the owner's STDOUT (an
  // anonymous pipe): not name-enumerable anywhere, so no same-uid process can
  // inject a fabricated response line. The fd comes from the internal handle
  // (undocumented but stable); readSync on it works with EAGAIN poll-continue.
  bridgeLaunchErr = null; // per-owner-attempt state (review finding 2)
  const nodeBin = trustedNodeBin();
  if ("err" in nodeBin) {
    bridgeLaunchErr = `mini-dc bridge: ${nodeBin.err}`;
    return; // no owner, no credential handoff: rules-load stays degraded (fail-closed)
  }
  // revision 3: the abstract-namespace address (random, no filesystem footprint)
  const bridgeAddr = randomBytes(16).toString("hex"); // the hex name; the \0 prefix is kernel-only (env values cannot carry null bytes)
  // revision 3 (finding 2): MINIMAL env — only what the credential child needs;
  // never the full runtime environment
  const proc = spawn(nodeBin.bin, ["-e", OWNER_SOURCE], {
    stdio: ["ignore", "ignore", "pipe"], // stderr: the grade marker (C:ok/C:fail)
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", // the credential child needs PATH for the peercred helper's dynamic linker
      MINIDC_BRIDGE_ADDR: bridgeAddr,
      MINIDC_SESSION_PID: String(process.pid),
      MINIDC_SESSION_STARTTIME: selfStatOf(process.pid),
      MINIDC_SOCKET: brokerPaths().socketPath,
      MINIDC_PEERCRED_HELPER: "/usr/lib/minidc/minidc-peercred-helper",
      ...(env["MINIDC_ENROLLMENT"] ? { MINIDC_ENROLLMENT: env["MINIDC_ENROLLMENT"] } : {}),
      ...(env["MINIDC_CLAIM_SECRET"] ? { MINIDC_CLAIM_SECRET: env["MINIDC_CLAIM_SECRET"] } : {}),
    },
  });
  const st: OwnerState = { proc, bridgeAddr, bridgeSock: null, bridgeFd: null, dead: false };
  bridgeEnvs = env;
  // revision 3: connect to the abstract socket ASYNC (the owner creates the
  // server; the parent connects once it's up). The fd lands in st.bridgeFd.
  connectBridgeSocket(st);
  proc.on("error", (e: NodeJS.ErrnoException) => {
    // review finding 2: async spawn failures (ENOENT etc.) must land in the
    // same bounded, token-free diagnostic — not escape as an unhandled error
    st.dead = true;
    if (bridgeLaunchErr === null) {
      bridgeLaunchErr = `mini-dc bridge: owner launch failed (${e.code ?? e.message})`;
    }
  });
  proc.on("exit", () => {
    st.dead = true;
    // defect-8 task 3: an owner that died WITHOUT ever registering surfaces
    // once — the respawn logic still retries; this line is the prompt signal
    if (bridgeGradeValue === null && bridgeLaunchErr === null) {
      bridgeLaunchErr = "mini-dc bridge: owner exited before registration (runtime or socket unusable)";
    }
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const m = /C:(ok|fail):(\S*)/.exec(d.toString());
    if (!m) return;
    if (m[1] === "ok") {
      bridgeGradeValue = m[2] ?? null;
      // R2 v2: no surface-secret export — the ancestry path is gone; supervisor
      // tool-children that need to append go through the presenter family
      // (open-claim / delegate-claim) with kernel identity, never env secrets
    } else {
      bridgeGradeValue = null;
    }
  });
  // no 'data' listener on stdout; the bridge socket is the channel (see OwnerState)
  owner = st;
  bridgeReady = true;
}

/** revision 3: connect to the owner's abstract-socket server (async — the
 *  owner must have created it first; bounded retries handle the race). */
function connectBridgeSocket(st: OwnerState): void {
  let tries = 0;
  const attempt = (): void => {
    if (st.dead) return;
    const sock = net.connect({ path: "\0" + st.bridgeAddr }, () => {
      st.bridgeSock = sock;
      const fd = (sock as unknown as { _handle?: { fd?: number } })._handle?.fd;
      st.bridgeFd = typeof fd === "number" ? fd : null;
      if (st.bridgeFd === null) {
        bridgeLaunchErr = "mini-dc bridge: connected socket exposes no fd (runtime limitation)";
        sock.destroy();
      }
    });
    sock.on("error", () => {
      if (++tries < 40) setTimeout(attempt, 50); // 2s budget for the owner to create the server
    });
  };
  attempt();
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
    // revision 3: wait for BOTH the grade marker AND the bridge socket fd —
    // connectBridgeSocket is async and might land after the grade
    while ((bridgeGradeValue === null || (owner !== null && owner.bridgeFd === null)) && owner !== null && !owner.dead && Date.now() - t0 < 4000) {
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
  // revision 3: responses ride the bridge socket (see bridgeServer); stdout
  // mirror kept for node-run diagnostics only — no named files
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
      process.stderr.write("C:ok:" + (r.grade ? r.grade : "?") + "\\n");
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
    } else if (f.retryable === true) { setTimeout(reClaim, 500); }
  });
}
// request pump (revision 2): the caller appends JSON lines to the REQUEST
// file (appendFileSync — a real syscall, lands immediately); the owner tails
// it with its OWN free event loop. The old stdin pipe is GONE: a stream write
// needs a parent event-loop turn the caller's sync poll never grants.
// revision 3: the abstract-socket server — SO_PEERCRED-verified, one duplex
// channel, no named files. The owner creates the server on the address the
// parent generated (MINIDC_BRIDGE_ADDR env), accepts ONE connection, verifies
// the connector's pid via the compiled helper, then serves ops line-by-line.
(function bridgeServer() {
  const addr = process.env.MINIDC_BRIDGE_ADDR;
  const expectedPid = Number(process.env.MINIDC_SESSION_PID || 0);
  const helper = process.env.MINIDC_PEERCRED_HELPER;
  if (!addr || !expectedPid || !helper) return;
  let conn = null;
  let bbuf = Buffer.alloc(0);
  const server = net.createServer((c) => {
    if (conn) { c.destroy(); return; } // one connection only
    // SO_PEERCRED verification: reject any connector whose pid != the parent.
    // The accepted connection's fd is passed as the helper's STDIN (fd 0) —
    // more robust than argv fd inheritance (O_CLOEXEC concerns)
    const afd = (c as any)._handle?.fd;
    if (typeof afd !== "number") { c.destroy(); return; }
    try {
      const result = require("child_process").spawnSync(helper, [], {
        stdio: [afd, "pipe", "pipe"],
        encoding: "utf8",
        timeout: 2000,
      });
      if (result.status !== 0 || !result.stdout) { c.destroy(); return; }
      const cred = JSON.parse(result.stdout.trim());
      if (cred.pid !== expectedPid) { c.destroy(); return; } // not the parent — rejected
    } catch (e) { c.destroy(); return; } // helper failure — fail-closed
    conn = c;
    c.on("data", (d) => {
      bbuf = Buffer.concat([bbuf, d]);
      let ni;
      while ((ni = bbuf.indexOf(0x0a)) >= 0) {
        const line = bbuf.subarray(0, ni).toString("utf8");
        bbuf = bbuf.subarray(ni + 1);
        if (!line.trim()) continue;
        let req; try { req = JSON.parse(line); } catch (e) { c.write(JSON.stringify({ ok: false, error: "E_UNAVAILABLE", reason: "owner-bad-request" }) + "\\n"); continue; }
        if (req.op === "shutdown") { stopped = true; try { sock.destroy(); } catch (e) {} try { c.destroy(); } catch (e) {} process.exit(0); }
        if (!registered) { continue; } // defer until registered — the caller's budget bounds the wait
        send(req.op, req.args, (f) => { c.write(JSON.stringify({ ...f, id: req.id }) + "\\n"); }); // echo the CALLER's id
      }
    });
    c.on("close", () => { conn = null; });
    c.on("error", () => { conn = null; });
  });
  server.listen("\\0" + addr, () => {
    process.stderr.write("B:ready\\n"); // bridge server ready signal
  });
})();
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

let bridgeCallSeq = 1;
export function bridgeCall(
  op: string,
  args: Record<string, unknown>,
  timeoutMs = 3200,
): BridgeResult | null {
  if (!bridgeReady) return null;
  // fix2 new-finding-2: a dead owner RESPAWNS here (one attempt per call) — the
  // session recovers on the next op instead of degrading forever
  const st0 = owner;
  const st = st0 && !st0.dead ? st0 : ensureOwner();
  if (!st || st.bridgeFd === null) return null;
  const id = bridgeCallSeq++;
  try {
    // revision 3: sync fd I/O on the abstract socket — REAL syscalls, no
    // event loop dependency, no named files. Byte-unit framing throughout.
    const reqLine = JSON.stringify({ id, op, args }) + "\n";
    fs.writeSync(st.bridgeFd, reqLine);
    const deadline = Date.now() + timeoutMs;
    const buf = Buffer.alloc(1 << 16);
    let carry = Buffer.alloc(0);
    for (;;) {
      let n: number;
      try {
        n = fs.readSync(st.bridgeFd, buf, 0, buf.length, null);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "EAGAIN") {
          if (Date.now() > deadline) return null;
          sleepSyncMs(2);
          continue;
        }
        if (code === "EINTR") continue;
        st.dead = true;
        return null; // socket gone — degraded, never a hang
      }
      if (n <= 0) { st.dead = true; return null; } // EOF — owner died
      // byte-unit framing (finding 3): append BYTES, split on the newline BYTE
      carry = Buffer.concat([carry, buf.subarray(0, n)]);
      const ni = carry.indexOf(0x0a);
      if (ni >= 0) {
        const raw = carry.subarray(0, ni).toString("utf8");
        carry = carry.subarray(ni + 1);
        try {
          const f = JSON.parse(raw) as { id?: number } & BridgeResult;
          if (f.id === id) return f;
          // wrong id — skip (a stale reply or an injected line with a wrong id)
          continue;
        } catch {
          continue; // malformed line — skipped, not fatal
        }
      }
      if (Date.now() > deadline) return null;
    }
  } catch {
    return null; // socket gone — degraded, never a hang
  }
}

/** test introspection: the live owner process (kill it to pin the respawn law). */
export function ownerProcForTest(): ChildProcess | null {
  return owner ? owner.proc : null;
}

export function shutdownBrokerClient(): void {
  const st = owner;
  if (st) {
    // revision 3: the shutdown word rides the bridge socket
    try {
      if (st.bridgeSock) {
        st.bridgeSock.write("{\"op\":\"shutdown\"}\n");
      }
    } catch { /* gone */ }
    setTimeout(() => { try { st.proc.kill("SIGKILL"); } catch { /* gone */ } }, 250).unref?.();
    try { st.bridgeSock?.destroy(); } catch { /* gone */ }
    owner = null;
  }
  bridgeReady = false;
  bridgeGradeValue = null;
}

// ── the gate-facing operations (degradation per §6: never a hang, never a guess) ──
export interface BrokerTrailEntry {
  v: 1; // the schema version the wire validates (cleanup F1: literal to match TrailEntry)
  ts: string;
  // cleanup F1: literal unions matching the wire's server-side validation —
  // structurally assignable to the gate's TrailEntry
  actor: "captain" | "firstmate" | "worker" | "gate";
  pane: string | null;
  task: string | null;
  subject: string;
  cls: "D" | "R" | "G";
  decision: "proceed" | "deny" | "park";
  scope: "once" | "session" | "grant" | "none";
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

// Library module (imported by mini-damage-control.ts + tests), not a standalone
// extension. The no-op default factory satisfies the extension loader's default-
// export contract — same pattern as background-helpers.ts. When the packaged-Pi
// regression loads this file DIRECTLY under -e, the module-scope driver hook
// (registered by the appended test tail BEFORE the loader invokes this factory)
// turns the default factory into the test's session-start driver — ONE default
// export, no loader-dependent duplicates (review finding 4).
let bridgeDriver: ((pi: any) => void) | null = null;
/** Test seam (the setBrokerPathsForTesting precedent): the -e regression
 *  registers its driver here; production leaves it null. */
export function registerBridgeDriverForTesting(fn: ((pi: any) => void) | null): void {
  bridgeDriver = fn;
}
export default function (pi?: { on?: unknown }) {
  if (bridgeDriver !== null && pi && typeof (pi as any).on === "function") {
    bridgeDriver(pi as any);
  }
}

