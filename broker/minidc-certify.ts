#!/usr/bin/env node
// broker/minidc-certify.ts — the R2 certification module (spec §2.1 / R1–R3).
//
// The operator-authorized `certify` command is the SOLE writer of certification
// records (R1). It lives here as an importable module so the CLI
// (minidc-brokerctl certify, run under sudo by the captain) and the test harness
// exercise the SAME verification + atomicity path; only the root/euid gate is
// CLI-side (defense in depth — the production store's root:minidc-broker 0640
// ownership and the unit's ReadOnlyPaths=state already bar the daemon and every
// worker from writing it).
//
// Flow (R2): measure the installed backend artifacts (executable + adapter) →
// verify BOTH digests against the repo-tracked approved list's entry for that
// backend (the installed root-owned copy is the effective approved source) →
// check broker-protocol compatibility (exact protocol-revision equality between
// the approved entry and the LIVE daemon's advertised revision) → only then
// atomically record the generation, bound to the desk-local installation ID, in
// certified-backends.json. Any failure or interruption leaves NO partial grant
// (R2): the store is written once, whole, via O_EXCL temp + rename + fsync.
//
// Protocol-compatibility definition (spec open question a, this ship's ruling):
// the approved list entry declares the protocol revision its artifacts speak; the
// running daemon advertises its wire revision in `status`; certify requires exact
// equality. A mismatched or unreachable daemon is a refusal, never a guess.
//
// Revocation entry point + record representation (open question a): the SAME
// root CLI (`certify --revoke --backend <name>`), flipping the backend's records
// to revoked:true + revoked-at in place (atomic replace) — tombstones preserved
// in the one file, no second writer surface.

import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import * as net from "node:net";

// ── no-follow reads (D2 discipline: the final component is never a symlink — a
// pre-planted link can redirect nothing; clean ENOENT is the only absence) ────
function readNoFollow(path: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e; // ELOOP (symlink plant), EACCES, … — refusal, not absence
  }
  try {
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

// ── digests ───────────────────────────────────────────────────────────────────
export function sha256File(path: string): string {
  const fd = fs.openSync(path, "r");
  try {
    const h = createHash("sha256");
    const buf = Buffer.alloc(1 << 16);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
    return h.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const BACKEND_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ── the repo-tracked approved list (R1: changes only via captain-approved PRs) ─
export interface ApprovedEntry {
  backend: string;
  "exe-digests": string[];    // set-shaped: both desks' binaries may be approved
  "adapter-digests": string[];
  "protocol-revision": number;
}
export interface ApprovedList {
  version: 1;
  backends: ApprovedEntry[];
}

export function parseApprovedList(text: string): ApprovedList | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o["version"] !== 1) return null;
  if (!Array.isArray(o["backends"])) return null;
  const out: ApprovedEntry[] = [];
  for (const b of o["backends"]) {
    if (typeof b !== "object" || b === null) return null;
    const e = b as Record<string, unknown>;
    if (typeof e["backend"] !== "string" || !BACKEND_RE.test(e["backend"])) return null;
    for (const k of ["exe-digests", "adapter-digests"] as const) {
      if (!Array.isArray(e[k])) return null;
      for (const d of e[k]) {
        if (typeof d !== "string" || !HEX64.test(d)) return null;
      }
    }
    if (typeof e["protocol-revision"] !== "number" || !Number.isInteger(e["protocol-revision"]) || e["protocol-revision"] < 1) return null;
    if (out.some((x) => x.backend === e["backend"])) return null; // one entry per backend
    out.push({ backend: e["backend"], "exe-digests": [...e["exe-digests"]], "adapter-digests": [...e["adapter-digests"]], "protocol-revision": e["protocol-revision"] });
  }
  return { version: 1, backends: out };
}

export function readApprovedList(path: string): { list: ApprovedList } | { err: string } {
  let text: string | null;
  try {
    text = readNoFollow(path);
    if (text === null) return { err: `approved list absent: ${path}` };
  } catch (e) {
    return { err: `approved list unreadable: ${(e as NodeJS.ErrnoException).code ?? "unknown"}` };
  }
  const parsed = parseApprovedList(text);
  if (!parsed) return { err: "approved list malformed (strict schema refused)" };
  return { list: parsed };
}

// ── the certification store v2 (digest-based generations; no pids — R3/R4) ─────
export interface GenerationRecord {
  backend: string;
  "generation-id": string;
  "exe-digest": string;
  "adapter-digest": string;
  "protocol-revision": number;
  "installation-id": string;   // desk-local binding (R3) — compared at claim time
  "certified-at": string;
  revoked: boolean;
  "revoked-at": string | null;
}
export interface CertifiedStore {
  version: 2;
  backends: GenerationRecord[];
}

export function emptyStore(): CertifiedStore {
  return { version: 2, backends: [] };
}

/** Strict parse of the store file for readers. Absent file → null (fresh install,
 *  not an error). Malformed → {err} — fail-closed, never an empty-set guess. */
export function parseCertifiedStore(text: string): CertifiedStore | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o["version"] !== 2) return null;
  if (!Array.isArray(o["backends"])) return null;
  const out: GenerationRecord[] = [];
  for (const b of o["backends"]) {
    if (typeof b !== "object" || b === null) return null;
    const r = b as Record<string, unknown>;
    if (typeof r["backend"] !== "string" || !BACKEND_RE.test(r["backend"])) return null;
    if (typeof r["generation-id"] !== "string" || !/^gen-[0-9a-f]{16}$/.test(r["generation-id"])) return null;
    if (typeof r["exe-digest"] !== "string" || !HEX64.test(r["exe-digest"])) return null;
    if (typeof r["adapter-digest"] !== "string" || !HEX64.test(r["adapter-digest"])) return null;
    if (typeof r["protocol-revision"] !== "number" || !Number.isInteger(r["protocol-revision"]) || r["protocol-revision"] < 1) return null;
    if (typeof r["installation-id"] !== "string" || !HEX32.test(r["installation-id"])) return null;
    if (typeof r["certified-at"] !== "string" || Number.isNaN(Date.parse(r["certified-at"]))) return null;
    if (typeof r["revoked"] !== "boolean") return null;
    if (!(r["revoked-at"] === null || (typeof r["revoked-at"] === "string" && !Number.isNaN(Date.parse(r["revoked-at"]))))) return null;
    if (r["revoked"] === false && r["revoked-at"] !== null) return null;
    out.push({
      backend: r["backend"], "generation-id": r["generation-id"],
      "exe-digest": r["exe-digest"], "adapter-digest": r["adapter-digest"],
      "protocol-revision": r["protocol-revision"], "installation-id": r["installation-id"],
      "certified-at": r["certified-at"], revoked: r["revoked"], "revoked-at": r["revoked-at"],
    });
  }
  return { version: 2, backends: out };
}

/** Read for the certify writer: absent → empty store (first certification on a
 *  fresh install); unreadable/malformed → {err} (a corrupt store is never
 *  silently replaced — the captain resolves it deliberately). */
export function loadStoreForWrite(path: string): { store: CertifiedStore } | { err: string } {
  let text: string | null;
  try {
    text = readNoFollow(path);
    if (text === null) return { store: emptyStore() }; // first certification on a fresh install
  } catch (e) {
    return { err: `certification store unreadable: ${(e as NodeJS.ErrnoException).code ?? "unknown"}` };
  }
  const parsed = parseCertifiedStore(text);
  if (!parsed) return { err: "certification store malformed — refusing to overwrite" };
  return { store: parsed };
}

/** The daemon-side read (R3 fail-closed): any miss — absent, unreadable, planted
 *  symlink, malformed — yields the EMPTY effective set (authorizes nothing). */
export function readCertifiedStoreEffective(path: string): CertifiedStore {
  try {
    const text = readNoFollow(path);
    if (text === null) return emptyStore();
    return parseCertifiedStore(text) ?? emptyStore();
  } catch {
    return emptyStore();
  }
}

/** Atomic whole-file replace (R2): O_EXCL temp in the same dir, fsync file + dir,
 *  rename. Mode 0640 — root-owned state entry, group-readable by the daemon.
 *  D6 (2026-11-24 activation soak): the replace must LAND the installer's
 *  ownership discipline — uid+gid derived from the installation-id sibling —
 *  or the daemon's group read is lost and the effective set fail-closes to
 *  empty (every claim denied as uncertified-generation). The chown runs on
 *  the temp BEFORE the rename so the daemon never observes an unowned file. */
export function writeCertifiedStore(path: string, store: CertifiedStore): void {
  const dir = dirname(path);
  const sibling = join(dir, "installation-id");
  let ref: { uid: number; gid: number };
  try {
    const st = fs.lstatSync(sibling);
    ref = { uid: st.uid, gid: st.gid };
  } catch {
    throw new Error(
      `writeCertifiedStore: installation-id sibling unreadable (${sibling}) — refusing to write without the ownership reference`);
  }
  const tmp = join(dir, `.tmp-certify-${process.pid}-${randomBytes(4).toString("hex")}`);
  const fd = fs.openSync(tmp, "wx", 0o640);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chownSync(tmp, ref.uid, ref.gid); // D6: sibling-derived ownership, pre-rename
  fs.renameSync(tmp, path);
  try {
    const dfd = fs.openSync(dir, "r");
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* dir fsync best-effort on exotic filesystems */ }
}

// ── installation identity (R3: installer-minted, 128-bit, desk-local) ─────────
export function readInstallationId(stateDir: string): { id: string } | { err: string } {
  let text: string | null;
  try {
    text = readNoFollow(join(stateDir, "installation-id"));
    if (text === null) return { err: `installation-id absent (${join(stateDir, "installation-id")}) — rerun the installer` };
  } catch (e) {
    return { err: `installation-id unreadable (${(e as NodeJS.ErrnoException).code ?? "unknown"}) — rerun the installer` };
  }
  const trimmed = text.trim();
  if (!HEX32.test(trimmed)) return { err: "installation-id malformed (expected 32 hex chars)" };
  return { id: trimmed };
}

// ── live daemon protocol query (compatibility check leg) ──────────────────────
export function queryDaemonProtocolRevision(socketPath: string, timeoutMs = 2000): Promise<{ revision: number } | { err: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { revision: number } | { err: string }) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch { /* gone */ }
      resolve(r);
    };
    const s = net.connect(socketPath, () => {
      s.write(`${JSON.stringify({ id: 1, op: "status", args: {} })}\n`);
      setTimeout(() => finish({ err: "daemon status timeout" }), timeoutMs).unref?.();
    });
    s.on("error", (e: NodeJS.ErrnoException) => finish({ err: `daemon unreachable: ${e.code ?? e.message}` }));
    let buf = "";
    s.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      try {
        const f = JSON.parse(buf.slice(0, i)) as { ok?: boolean; result?: { "protocol-revision"?: unknown } };
        if (f.ok === true && typeof f.result?.["protocol-revision"] === "number") {
          finish({ revision: f.result["protocol-revision"] });
        } else {
          finish({ err: "daemon status frame malformed" });
        }
      } catch {
        finish({ err: "daemon status frame malformed" });
      }
    });
  });
}

// ── the certify + revoke flows ────────────────────────────────────────────────
export interface CertifyOptions {
  backend: string;
  exePath: string;        // installed backend executable to measure
  adapterPath: string;    // installed broker-protocol adapter to measure
  stateDir: string;       // …/state — holds installation-id + certified-backends.json
  approvedListPath: string;
  socketPath: string;     // live daemon, for the protocol-compatibility check
  requireRoot: boolean;   // CLI passes true; the test harness is the scratch operator
}
export interface CertifyReceipt {
  backend: string;
  "generation-id": string;
  "exe-digest": string;
  "adapter-digest": string;
  "protocol-revision": number;
  "installation-id": string;
  "certified-at": string;
  superseded: boolean;    // a previous live generation for this backend was replaced
}

export async function certifyBackend(o: CertifyOptions): Promise<{ ok: true; receipt: CertifyReceipt } | { ok: false; err: string }> {
  if (o.requireRoot && (process.geteuid?.() ?? 0) !== 0) {
    return { ok: false, err: "certify requires root (run via sudo — the captain's channel)" };
  }
  if (!BACKEND_RE.test(o.backend)) return { ok: false, err: "backend name malformed" };

  // leg 1 — the approved source (R1: repo list installed root-owned; never worker-writable)
  const approved = readApprovedList(o.approvedListPath);
  if ("err" in approved) return { ok: false, err: approved.err };
  const entry = approved.list.backends.find((b) => b.backend === o.backend);
  if (!entry) return { ok: false, err: `backend '${o.backend}' is not in the approved list (captain-approved PR required)` };

  // leg 2 — measure the installed artifacts (R2: both digests must match exactly)
  let exeDigest: string, adapterDigest: string;
  try {
    exeDigest = sha256File(o.exePath);
  } catch (e) {
    return { ok: false, err: `executable unreadable: ${o.exePath} (${(e as NodeJS.ErrnoException).code ?? "unknown"})` };
  }
  try {
    adapterDigest = sha256File(o.adapterPath);
  } catch (e) {
    return { ok: false, err: `adapter unreadable: ${o.adapterPath} (${(e as NodeJS.ErrnoException).code ?? "unknown"})` };
  }
  if (!entry["exe-digests"].includes(exeDigest)) {
    return { ok: false, err: `executable digest ${exeDigest.slice(0, 16)}… not approved for '${o.backend}'` };
  }
  if (!entry["adapter-digests"].includes(adapterDigest)) {
    return { ok: false, err: `adapter digest ${adapterDigest.slice(0, 16)}… not approved for '${o.backend}'` };
  }

  // leg 3 — protocol compatibility (open question a ruling: exact revision equality)
  const proto = await queryDaemonProtocolRevision(o.socketPath);
  if ("err" in proto) return { ok: false, err: `broker-protocol compatibility unproven: ${proto.err}` };
  if (proto.revision !== entry["protocol-revision"]) {
    return { ok: false, err: `protocol revision mismatch: approved entry says ${entry["protocol-revision"]}, live daemon advertises ${proto.revision}` };
  }

  // leg 4 — installation identity (R3)
  const inst = readInstallationId(o.stateDir);
  if ("err" in inst) return { ok: false, err: inst.err };

  // leg 5 — atomic record (R2: whole or nothing; one live generation per backend —
  // recertifying different digests supersedes, keeping the tombstone rows)
  const storePath = join(o.stateDir, "certified-backends.json");
  const loaded = loadStoreForWrite(storePath);
  if ("err" in loaded) return { ok: false, err: loaded.err };
  const superseded = loaded.store.backends.some((r) => r.backend === o.backend && !r.revoked);
  const receipt: CertifyReceipt = {
    backend: o.backend,
    "generation-id": `gen-${randomBytes(8).toString("hex")}`,
    "exe-digest": exeDigest,
    "adapter-digest": adapterDigest,
    "protocol-revision": proto.revision,
    "installation-id": inst.id,
    "certified-at": new Date().toISOString(),
    superseded,
  };
  const record: GenerationRecord = {
    backend: receipt.backend, "generation-id": receipt["generation-id"],
    "exe-digest": receipt["exe-digest"], "adapter-digest": receipt["adapter-digest"],
    "protocol-revision": receipt["protocol-revision"], "installation-id": receipt["installation-id"],
    "certified-at": receipt["certified-at"], revoked: false, "revoked-at": null,
  };
  // idempotent re-certify of the SAME digests refreshes certified-at in place (same
  // generation-id would churn restart evidence; a fresh id per certify is honest —
  // restart-preservation is the RECORD's property, tested by R3's check)
  const next: CertifiedStore = {
    version: 2,
    backends: [
      ...loaded.store.backends.filter((r) => r.backend !== o.backend || r.revoked),
      record,
    ],
  };
  try {
    writeCertifiedStore(storePath, next);
  } catch (e) {
    return { ok: false, err: `store write failed: ${(e as Error).message} (no partial grant written)` };
  }
  return { ok: true, receipt };
}

export interface RevokeOptions {
  backend: string;
  stateDir: string;
  requireRoot: boolean;
}
export async function revokeBackend(o: RevokeOptions): Promise<{ ok: true; revoked: number } | { ok: false; err: string }> {
  if (o.requireRoot && (process.geteuid?.() ?? 0) !== 0) {
    return { ok: false, err: "revoke requires root (run via sudo — the captain's channel)" };
  }
  if (!BACKEND_RE.test(o.backend)) return { ok: false, err: "backend name malformed" };
  const storePath = join(o.stateDir, "certified-backends.json");
  const loaded = loadStoreForWrite(storePath);
  if ("err" in loaded) return { ok: false, err: loaded.err };
  const live = loaded.store.backends.filter((r) => r.backend === o.backend && !r.revoked);
  if (live.length === 0) return { ok: false, err: `no live certification for '${o.backend}'` };
  const at = new Date().toISOString();
  const next: CertifiedStore = {
    version: 2,
    backends: loaded.store.backends.map((r) =>
      r.backend === o.backend && !r.revoked ? { ...r, revoked: true, "revoked-at": at } : r,
    ),
  };
  try {
    writeCertifiedStore(storePath, next);
  } catch (e) {
    return { ok: false, err: `store write failed: ${(e as Error).message} (no partial revoke written)` };
  }
  return { ok: true, revoked: live.length };
}
