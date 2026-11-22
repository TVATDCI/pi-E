#!/usr/bin/env node
// broker/minidc-broker.ts — the R2 mini-damage-control broker daemon (design-of-record:
// data/gate-r2-amend11/report.md §4.1–§4.5, §7.1). Nine operations plus status, exactly:
//   status · register · unregister · read-rules · read-trail · read-grants ·
//   append-trail · create-grant · revoke-grant · write-rules
//
// BUILT DEVIATIONS from the design's letter (Node v26.13.1 has NO SO_PEERCRED API —
// probed empirically this round; kernel-identity substitutions, each preserving the
// security property the peercred law carried — full statements in the build report):
//   D1a ROOT class: a second, root-only CONTROL SOCKET (mode 0600 in a root-owned dir)
//       replaces uid-0 detection — connectability IS the kernel proof of root. The main
//       socket stays world-connectable (the access law is the grade table, per §4.1).
//   D1b PRE-PINNED CLAIMS carry a claim-secret (unguessable, hash-stored, printed once by
//       the root CLI; travels operator-terminal → wrapper → session env, which /proc
//       ptrace-gating shields from same-uid siblings) — closes the escalation a
//       client-asserted pid+starttime alone would leave (captain entitlement theft).
//   D1c ANCESTRY appends carry a surface-secret (issued at claim to firstmate/captain
//       connections; injected into the supervisor's own children via inherited env) —
//       the pid walk, nearest-entitlement cap, and certified-generation gate all still
//       run exactly as designed; the secret anchors the connector's identity that
//       peercred would have supplied.
//   D1d PER-OP revalidation re-checks the RECORDED pid against /proc (liveness +
//       starttime + boot-id). Connection↔process binding is protocol-level; fd passing
//       (SCM_RIGHTS) is not expressible in Node, so the socket holder is the claim holder.
//   D2 dirfd/*at() discipline: Node has no openat/renameat. Substituted: strict
//       slug/path allowlist validation + backing-namespace-only opens + O_NOFOLLOW on
//       final components. The wall (§4.1 ownership/mode law) carries the security.
//   D4 YAML validation: restricted-subset parser (no anchors/flow/multiline), fail-closed
//       E_INVALID on anything it cannot confidently parse — the client pre-validates
//       with the full yaml lib; the daemon's check is the defense-in-depth leg.
// The mount helper's raw syscalls (open_tree/move_mount/renameat2/statx/umount2) are in
// broker/minidc-mount-helper.c (compiled at install — D3, cc-checked, fail-closed
// attended fallback per §4.6.4's fallback law).

import * as net from "node:net";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as dgram from "node:dgram";

// ═══════════════════════════ wire protocol (§4.3.2 fixed vocabulary) ═══════════
// Newline-delimited JSON frames over a unix stream socket.
//   request:  {"id":<n>,"op":"<name>","args":{...}}
//   response: {"id":<n>,"ok":true,"result":{...}}
//             {"id":<n>,"ok":false,"error":"E_*"}            — fixed bytes, NO payload echo
//             {"id":<n>,"ok":false,"error":"E_RATE_LIMITED","retryable":true}
//               (re-claim budget excess ONLY — delayed-and-retried by the client, never a
//                surfaced denial; §4.4.7's split budgets)
export const OPS = [
  "status", "register", "unregister", "read-rules", "read-trail", "read-grants",
  "append-trail", "create-grant", "revoke-grant", "write-rules",
] as const;
export type Op = (typeof OPS)[number];
export const ERRORS = [
  "E_DENIED_UNREGISTERED", "E_DENIED_GRADE", "E_DENIED_SLUG", "E_DENIED_TOPOLOGY",
  "E_RATE_LIMITED", "E_INVALID", "E_UNAVAILABLE",
] as const;
export type BrokerError = (typeof ERRORS)[number];

export interface Entitlement {
  "entitlement-id": string;
  kind: "pre-pinned" | "enrollment";
  grade: "captain" | "firstmate" | "worker";
  "slug-scope": string | null; // worker only, frozen at mint
  "spawn-backend": string;     // resolve-once seam value, frozen at creation (§4.4.1)
  pid: number | null;          // enrollment rows pin at consume
  starttime: string | null;    // /proc/<pid>/stat field 22, raw string (exact compare)
  "boot-id": string | null;
  "secret-hash": string | null;   // sha256 hex — claim-secret (pre-pinned) or token (enrollment)
  "minted-by": number | null;     // connection id of the minting supervisor connection
  "created-by": string;           // "sudo-plain" | "enrollment-consume:<id>"
  "created-at": string;
  "ttl-deadline": number;         // epoch ms, ROLLING on successful op / re-claim (§4.4.0)
  "expires-at": number | null;    // pending-enrollment mint expiry (120 s)
  state: "pending" | "claimed" | "claim-voided";
  "claimed-by": number | null;    // connection id of the live claim
  "claim-count": number;
  "consumed-at": string | null;   // enrollment consume timestamp (tombstone-side)
  "surface-secret-hash": string | null; // live surface-secret issued to the CLAIMING
                                        // firstmate/captain connection (D1c) — set at claim
}

interface RegistrationsFile {
  version: 1;
  "boot-id": string;
  entitlements: Entitlement[];
  "consumed-tokens": Record<string, string>; // token-hash → consumed-at (restart-proof tombstones)
}

export interface AuditEvent {
  ts: string;
  kind: string; // fixed event vocabulary — no payload echo beyond ids/pids/backends
  [k: string]: string | number | boolean | null;
}

export interface BrokerConfig {
  rootDir: string;        // /var/lib/minidc-broker (§4.1 fixed layout)
  socketPath: string;     // /run/minidc-broker/socket          — world connectable
  controlSocketPath: string; // /run/minidc-broker/control.sock — root-only (D1a)
  testMode: boolean;      // seams: no sd_notify, control socket connectable by the
                          // test uid, clock/proc injectable. Module seam, never env-readable.
}

export function defaultConfig(): BrokerConfig {
  return {
    rootDir: "/var/lib/minidc-broker",
    socketPath: "/run/minidc-broker/socket",
    controlSocketPath: "/run/minidc-broker/control.sock",
    testMode: false,
  };
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SUBJECT_RE = /^[0-9a-f]{16}$/;
const ACTOR_ENUM = new Set(["captain", "firstmate", "worker", "gate"]);
const TTL_MS: Record<"captain" | "firstmate" | "worker", number> = {
  captain: 12 * 3600_000,
  firstmate: 24 * 3600_000,
  worker: 24 * 3600_000,
};
const ENROLLMENT_TTL_MS = 120_000; // §4.4.1 expiry semantics

// ── /proc ground truth (§4.4: pid+starttime is process identity) ──────────────
export interface ProcStat { ppid: number; starttime: string; state: string; live: boolean }

export type ProcSource = (pid: number) => ProcStat | null;
let procSourceOverride: ProcSource | null = null;
export function setProcSourceForTesting(fn: ProcSource | null): void {
  procSourceOverride = fn;
}
function procStat(pid: number): ProcStat | null {
  if (procSourceOverride) return procSourceOverride(pid);
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 2).split(/\s+/);
    // fields[0]=state (field 3), [1]=ppid (4), [19]=starttime (22)
    const state = fields[0] ?? "";
    const ppid = Number(fields[1] ?? "-1");
    const starttime = fields[19] ?? "";
    if (!Number.isInteger(ppid) || ppid < 0 || !/^\d+$/.test(starttime)) return null;
    return { ppid, starttime, state, live: state !== "Z" && state !== "X" };
  } catch {
    return null;
  }
}
function currentBootId(): string {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "unknown-boot-id";
  }
}

// ── clock seam (fake-clock budget/TTL tests) ─────────────────────────────────
let clockOverride: (() => number) | null = null;
export function setClockForTesting(fn: (() => number) | null): void {
  clockOverride = fn;
}
function now(): number {
  return clockOverride ? clockOverride() : Date.now();
}

// ── mounts-unit-state check seam (§4.2 daemon-side law) ──────────────────────
export type UnitStateSource = () => string; // returns ActiveState or "unreadable"
let unitStateOverride: UnitStateSource | null = null;
export function setUnitStateSourceForTesting(fn: UnitStateSource | null): void {
  unitStateOverride = fn;
}
function mountsUnitState(): string {
  if (unitStateOverride) return unitStateOverride();
  if (currentCfgTestMode()) return "active"; // --test-mode child daemon: the mounts-unit
  // seam is module-level and cannot cross the process boundary; tests that need the
  // non-active rows drive them via the in-process seam (broker-matrix) instead
  try {
    const out = execFileSync(
      "systemctl", ["show", "-p", "ActiveState", "--value", "minidc-mounts.service"],
      { encoding: "utf8", timeout: 2000, stdio: ["pipe", "pipe", "ignore"] },
    ).trim();
    return out || "unreadable";
  } catch {
    return "unreadable"; // fail-closed: unreadable check ⇒ not-active (§4.2)
  }
}

// ═════════════════════ restricted-subset YAML (D4) ════════════════════════════
// Parses exactly the shapes this daemon reads/writes: nested maps of scalars and
// lists of flat maps/scalars, 2-space indent, `- ` items, single/double-quoted or
// bare scalars. Rejects (fail-closed) anchors/aliases, flow syntax, multi-line
// strings, tabs, duplicate keys — anything outside the subset.
export function yamlSubsetParse(text: string): Record<string, unknown> | null {
  const lines: { indent: number; text: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.includes("\t")) return null;
    const noComment = stripComment(rawLine);
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    if (indent % 2 !== 0) return null;
    lines.push({ indent, text: noComment.trim() });
  }
  let i = 0;
  function stripInline(): unknown { return undefined; }
  function parseScalar(s: string): string | boolean | null {
    const t = s.trim();
    if (t === "") return null;
    if (t === "[]") return "__EMPTY_LIST__" as unknown as string; // handled by caller
    if (t === "{}") return "__EMPTY_MAP__" as unknown as string;
    if (t === "true") return true;
    if (t === "false") return false;
    if ((t.startsWith("'") && t.endsWith("'") && t.length >= 2)) return t.slice(1, -1).replace(/''/g, "'");
    if ((t.startsWith('"') && t.endsWith('"') && t.length >= 2)) {
      if (/\\/.test(t.slice(1, -1))) return null; // escapes outside the subset
      return t.slice(1, -1);
    }
    if (/['"]/.test(t)) return null; // unbalanced quotes
    if (/[:{}\[\]|>&*!]/.test(t)) return null; // reserved/flow/multiline indicators
    return t;
  }
  function parseBlock(indent: number): Record<string, unknown> | unknown[] | null {
    const isList = (lines[i]?.text ?? "").startsWith("- ");
    const map: Record<string, unknown> = {};
    const list: unknown[] = [];
    while (i < lines.length) {
      const ln = lines[i] as { indent: number; text: string };
      if (ln.indent < indent) break;
      if (ln.indent > indent) return null; // deeper indent handled by recursive calls
      if (isList) {
        if (!ln.text.startsWith("- ")) return null;
        const item = ln.text.slice(2).trim();
        i++;
        if (item === "") {
          const nested = parseBlock(indent + 2);
          if (nested === null) return null;
          list.push(nested);
        } else if (/^[A-Za-z0-9_.-]+\s*:(\s|$)/.test(item)) {
          // inline first key of a flat map item: `- key: value` then deeper keys
          const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(item);
          if (!m) return null;
          const obj: Record<string, unknown> = {};
          const rest = (m[2] ?? "").trim();
          if (rest === "") {
            const nested = parseBlock(indent + 2);
            if (nested === null || Array.isArray(nested)) return null;
            Object.assign(obj, nested as Record<string, unknown>);
          } else {
            const v = parseScalar(rest);
            if (v === null) return null;
            obj[m[1] as string] = v;
          }
          // continue sibling keys at indent+2
          while (i < lines.length && (lines[i] as { indent: number; text: string }).indent === indent + 2
                 && !(lines[i] as { indent: number; text: string }).text.startsWith("- ")) {
            const s = lines[i] as { indent: number; text: string };
            const km = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(s.text);
            if (!km) return null;
            i++;
            const r = (km[2] ?? "").trim();
            if (r === "") {
              const nested = parseBlock(indent + 4);
              if (nested === null || Array.isArray(nested)) return null;
              obj[km[1] as string] = nested;
            } else {
              const v = parseScalar(r);
              if (v === null) return null;
              obj[km[1] as string] = v;
            }
          }
          list.push(obj);
        } else {
          const v = parseScalar(item);
          if (v === null) return null;
          list.push(v);
        }
        continue;
      }
      const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(ln.text);
      if (!m) return null;
      const key = m[1] as string;
      if (key in map) return null; // duplicate key — reject
      const rest = (m[2] ?? "").trim();
      i++;
      if (rest === "") {
        // nested block (list or map) at indent+2 — or an implicit null / empty flow value
        if (i < lines.length && (lines[i] as { indent: number; text: string }).indent > indent) {
          const nested = parseBlock(indent + 2);
          if (nested === null) return null;
          map[key] = nested;
        } else {
          map[key] = null;
        }
      } else {
        const v = parseScalar(rest);
        if (v === null) return null;
        map[key] = v === ("__EMPTY_LIST__" as unknown as string) ? [] : v === ("__EMPTY_MAP__" as unknown as string) ? {} : v;
      }
    }
    return isList ? list : map;
  }
  function stripComment(line: string): string {
    let inS = false, inD = false;
    for (let k = 0; k < line.length; k++) {
      const c = line[k] as string;
      if (c === "'" && !inD) inS = !inS;
      else if (c === '"' && !inS) inD = !inD;
      else if (c === "#" && !inS && !inD && (k === 0 || /\s/.test(line[k - 1] as string))) {
        return line.slice(0, k);
      }
    }
    return line;
  }
  const out = parseBlock(0);
  if (out === null || Array.isArray(out)) return null;
  return out;
}

function yamlScalar(v: string): string {
  // bare-safe ONLY when the subset parser round-trips it: no colon (key:value ambiguity),
  // no quotes/braces/space-class specials — everything else single-quoted
  if (/^[A-Za-z0-9@%+=_,.\/-]+$/.test(v) && v !== "true" && v !== "false") return v;
  return `'${v.replace(/'/g, "''")}'`;
}

/** Grants yaml — the daemon is the sole writer in broker mode; emits/reads the exact
 *  shape the legacy extension's yamlStringify produced (compat on mode switch). */
export function parseGrantsYaml(text: string): { grants: GrantRow[] } | null {
  const doc = yamlSubsetParse(text);
  if (doc === null) return null;
  const raw = doc["grants"];
  if (raw === null || raw === undefined) return { grants: [] };
  if (!Array.isArray(raw)) return null;
  const grants: GrantRow[] = [];
  for (const g of raw) {
    if (typeof g !== "object" || g === null || Array.isArray(g)) return null;
    const o = g as Record<string, unknown>;
    if (typeof o["id"] !== "string" || typeof o["pattern"] !== "string") return null;
    if (o["class-filter"] !== "R") return null; // never-D is structural (Q3)
    grants.push({
      id: o["id"], "created-at": String(o["created-at"] ?? ""),
      "creator-seat": (o["creator-seat"] as GrantRow["creator-seat"]) ?? "captain",
      pattern: o["pattern"], "class-filter": "R",
    });
  }
  return { grants };
}
export interface GrantRow {
  id: string;
  "created-at": string;
  "creator-seat": "captain" | "firstmate" | "worker";
  pattern: string;
  "class-filter": "R";
}
export function emitGrantsYaml(grants: GrantRow[]): string {
  if (grants.length === 0) return "grants: []\n";
  const lines = ["grants:"];
  for (const g of grants) {
    lines.push(`  - id: ${yamlScalar(g.id)}`);
    lines.push(`    created-at: ${yamlScalar(g["created-at"])}`);
    lines.push(`    creator-seat: ${yamlScalar(g["creator-seat"])}`);
    lines.push(`    pattern: ${yamlScalar(g.pattern)}`);
    lines.push(`    class-filter: 'R'`);
  }
  return lines.join("\n") + "\n";
}

/** Rules yaml validation for write-rules (captain authority; §4.1.1 atomic replace). */
export function validateRulesYaml(text: string): boolean {
  const doc = yamlSubsetParse(text);
  if (doc === null) return false;
  const allowed = new Set(["bashToolPatterns", "zeroAccessPaths", "readOnlyPaths"]);
  for (const k of Object.keys(doc)) {
    if (!allowed.has(k)) return false;
    const v = doc[k];
    if (v === null || v === undefined) continue; // empty layer
    if (!Array.isArray(v)) return false;
    for (const item of v) {
      if (typeof item === "string") continue; // zeroAccess/readOnly entries
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
      const o = item as Record<string, unknown>;
      if (typeof o["pattern"] !== "string" || typeof o["reason"] !== "string") return false;
      for (const ik of Object.keys(o)) {
        if (!["pattern", "reason", "ask", "class"].includes(ik)) return false;
      }
      if ("ask" in o && typeof o["ask"] !== "boolean") return false;
      if ("class" in o && o["class"] !== "D") return false; // R is never rule-pinnable (v1.1 C1)
    }
  }
  return true;
}

// ── rate-budget limits seam (test-only; the designed values are §4.4.7's) ───────
export interface RateLimits { mintPerPid: number; mintGlobal: number; reclaimPerPid: number; reclaimGlobal: number }
const DESIGN_LIMITS: RateLimits = { mintPerPid: 3, mintGlobal: 10, reclaimPerPid: 30, reclaimGlobal: 600 };
let rateLimits: RateLimits = { ...DESIGN_LIMITS };
export function setRateLimitsForTesting(l: RateLimits | null): void {
  rateLimits = { ...(l ?? DESIGN_LIMITS) };
}

let cfgTestModeFlag = false;
function currentCfgTestMode(): boolean {
  return cfgTestModeFlag;
}

// ════════════════════════════ the broker ══════════════════════════════════════
interface ConnState {
  id: number;
  control: boolean;          // arrived on the root-only control socket (D1a)
  entitlement: Entitlement | null;
  surfaceSecret: string | null; // live secret for firstmate/captain claims (D1c)
  socket: net.Socket;
  queued: number;            // unanswered in-flight frames (max 4, §4.4.7)
  readTimes: number[];
  appendTimes: number[];
  mutateTimes: number[];
}

export interface Broker {
  config: BrokerConfig;
  close(): Promise<void>;
  auditTail(): AuditEvent[];
  entitlementsSnapshot(): Entitlement[];
  /** test/admin introspection — never exposed on the wire */
  registrationCount(): number;
}

export function createBroker(cfgIn: Partial<BrokerConfig> = {}): Broker {
  const cfg: BrokerConfig = { ...defaultConfig(), ...cfgIn };
  const storeDir = join(cfg.rootDir, "store");
  const rulesDir = join(cfg.rootDir, "rules");
  const stateDir = join(cfg.rootDir, "state");
  const runtimeDir = join(stateDir, "runtime");
  const registrationsPath = join(runtimeDir, "registrations.json");
  const auditRingPath = join(runtimeDir, "audit-ring.jsonl");
  const rulesFile = join(rulesDir, "rules.yaml");
  const mountHealthPath = join(stateDir, "mount-health.json");
  const attestationPath = join(stateDir, "install-attestation.json");
  const certifiedPath = join(stateDir, "certified-backends.json");

  let nextConnId = 1;
  const conns = new Map<number, ConnState>();
  let entitlements: Entitlement[] = [];
  let consumedTokens: Record<string, string> = {};
  const auditMem: AuditEvent[] = [];
  const daemonStartMs = now();
  // mint budget (sliding, denial): key = `${pid}` → timestamps; plus global list
  const mintByPid = new Map<number, number[]>();
  let mintGlobal: number[] = [];
  // re-claim budget (FIXED one-minute windows, delay-only): windowIndex → count; per-pid too
  const reclaimWindowGlobal = new Map<number, number>();
  const reclaimWindowByPid = new Map<string, number>();
  let closed = false;

  // ── audit ring (§4.4.7: memory last-20 + durable tail, rotation-capped) ────
  function audit(kind: string, fields: Record<string, string | number | boolean | null> = {}): void {
    const ev: AuditEvent = { ts: new Date(now()).toISOString(), kind, ...fields };
    auditMem.push(ev);
    if (auditMem.length > 20) auditMem.shift();
    try {
      fs.appendFileSync(auditRingPath, `${JSON.stringify(ev)}\n`, "utf8");
      const st = fs.statSync(auditRingPath);
      if (st.size > 1_000_000) {
        const old = `${auditRingPath}.old`;
        try { fs.unlinkSync(old); } catch { /* absent */ }
        fs.renameSync(auditRingPath, old);
        fs.writeFileSync(auditRingPath, "", { mode: 0o660 });
      }
    } catch { /* best-effort durable tail — the ring is evidence, never a gate */ }
  }

  // ── persistence: atomic replacement (D2: strict paths, umask 0007, O_EXCL temps) ──
  function atomicWrite(path: string, content: string): void {
    if (!verifyDirComponents(path)) throw new Error("unverified components");
    const dir = dirname(path);
    const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    const fd = fs.openSync(tmp, "wx", 0o660); // O_EXCL — refuses pre-planted temps
    try {
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path);
    try {
      const dfd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* dir fsync best-effort on exotic filesystems */ }
  }
  function persist(): void {
    const doc: RegistrationsFile = {
      version: 1,
      "boot-id": currentBootId(),
      entitlements,
      "consumed-tokens": consumedTokens,
    };
    try {
      atomicWrite(registrationsPath, `${JSON.stringify(doc, null, 2)}\n`);
    } catch { /* daemon-writable state/runtime/ absent in tests until first use */ }
  }

  // ── restart rebuild (§4.4.0: /proc ground truth, never trust the file alone) ──
  function rebuild(): void {
    const boot = currentBootId();
    let cleared = false;
    try {
      const docTxt = readVerified(registrationsPath);
      if (docTxt === null) throw new Error("registrations unreadable or unverified");
      const doc = JSON.parse(docTxt) as RegistrationsFile;
      if (doc["boot-id"] === boot) {
        const kept: Entitlement[] = [];
        for (const row of doc.entitlements ?? []) {
          if (!row || typeof row !== "object") continue;
          if (!validEntitlementRow(row)) continue; // malformed candidate rows are dropped
          if (row.kind === "enrollment" && row.state === "pending") continue; // minter death (step 4)
          if (row.pid === null || row.starttime === null) { cleared = true; continue; }
          const st = procStat(row.pid);
          if (!st || !st.live || st.starttime !== row.starttime) {
            audit("expired-at-restart", { "entitlement-id": row["entitlement-id"], pid: row.pid });
            continue;
          }
          row["claimed-by"] = null; // void every claim — connections died with the daemon (step 3)
          row.state = row.state === "claimed" ? "claim-voided" : row.state;
          kept.push(row);
        }
        entitlements = kept;
        consumedTokens = { ...(doc["consumed-tokens"] ?? {}) }; // tombstones verbatim (step 5)
        audit("restart-rebuild", { kept: kept.length, boot: "current" });
      } else {
        entitlements = [];
        consumedTokens = { ...(doc["consumed-tokens"] ?? {}) };
        cleared = true;
        audit("restart-rebuild", { kept: 0, boot: "changed" }); // reboot law (step 1)
      }
    } catch {
      entitlements = [];
      consumedTokens = {};
      cleared = true;
      if (fs.existsSync(registrationsPath)) audit("restart-rebuild", { kept: 0, boot: "unreadable" });
    }
    persist();
  }

  function validEntitlementRow(row: Entitlement): boolean {
    return (
      typeof row["entitlement-id"] === "string" &&
      (row.kind === "pre-pinned" || row.kind === "enrollment") &&
      (row.grade === "captain" || row.grade === "firstmate" || row.grade === "worker") &&
      typeof row["spawn-backend"] === "string" && row["spawn-backend"].length > 0 &&
      typeof row["ttl-deadline"] === "number" &&
      (row.state === "pending" || row.state === "claimed" || row.state === "claim-voided")
    );
  }

  // ── rate budgets (§4.4.7 split budgets; §4.4.6 fixed windows) ────────────────
  function slide(list: number[], limit: number, t: number): { ok: boolean; list: number[] } {
    const fresh = list.filter((x) => t - x < 60_000);
    if (fresh.length >= limit) return { ok: false, list: fresh };
    fresh.push(t);
    return { ok: true, list: fresh };
  }
  function mintBudgetOk(pid: number): boolean {
    const t = now();
    const perPid = slide(mintByPid.get(pid) ?? [], rateLimits.mintPerPid, t);
    if (!perPid.ok) { mintByPid.set(pid, perPid.list); return false; }
    const glob = slide(mintGlobal, rateLimits.mintGlobal, t);
    if (!glob.ok) { mintGlobal = glob.list; return false; }
    mintByPid.set(pid, perPid.list);
    mintGlobal = glob.list;
    return true;
  }
  function reclaimWindowIndex(t: number): number {
    return Math.floor((t - daemonStartMs) / 60_000);
  }
  /** Fixed one-minute window. Returns {admitted, retryable} — excess is DELAYED via
   *  retryable:true, never a surfaced denial (§4.4.6: the client retries under backoff). */
  function reclaimBudgetAdmit(pid: number): { admitted: boolean; retryable: boolean } {
    const t = now();
    const w = reclaimWindowIndex(t);
    const g = reclaimWindowGlobal.get(w) ?? 0;
    const pk = `${w}:${pid}`;
    const p = reclaimWindowByPid.get(pk) ?? 0;
    if (g >= rateLimits.reclaimGlobal || p >= rateLimits.reclaimPerPid) {
      audit("budget-delay", { bucket: "reclaim", window: w, pid });
      return { admitted: false, retryable: true };
    }
    reclaimWindowGlobal.set(w, g + 1);
    reclaimWindowByPid.set(pk, p + 1);
    return { admitted: true, retryable: false };
  }

  // ── helper: grade of a connection ───────────────────────────────────────────
  function gradeOf(c: ConnState): "unknown" | "worker" | "firstmate" | "captain" | "root" {
    if (c.control) return "root";
    return c.entitlement?.grade ?? "unknown";
  }

  // ── per-op revalidation (§4.4.0 claim rule 4; deviation D1d) ────────────────
  function revalidate(c: ConnState): boolean {
    const e = c.entitlement;
    if (!e) return true; // unknown-grade connections need no revalidation
    if (e["ttl-deadline"] <= now()) {
      dropEntitlement(e, "ttl-expired");
      c.entitlement = null;
      return false;
    }
    if (e.pid !== null) {
      const st = procStat(e.pid);
      if (!st || !st.live || st.starttime !== e.starttime) {
        audit("claim-drop", { "entitlement-id": e["entitlement-id"], why: "instance-gone" });
        e["claimed-by"] = null;
        e.state = "claim-voided";
        c.entitlement = null;
        persist();
        return false;
      }
    }
    return true;
  }
  function rollTtl(e: Entitlement): void {
    e["ttl-deadline"] = now() + TTL_MS[e.grade];
  }
  function dropEntitlement(e: Entitlement, why: string): void {
    entitlements = entitlements.filter((x) => x !== e);
    audit("drop", { "entitlement-id": e["entitlement-id"], why });
    persist();
  }

  // ── trail IO: slug validation + mkdir-lock serialization (server-side reuse) ──
  function slugDirOf(slug: string): string | null {
    if (!SLUG_RE.test(slug) || slug === "." || slug === "..") return null;
    return join(storeDir, slug);
  }
  function withDirLock<T>(dir: string, name: string, fn: () => T): T {
    const lockPath = join(dir, `${name}.lock`);
    const deadline = now() + 5000;
    for (;;) {
      try {
        fs.mkdirSync(lockPath);
        break;
      } catch {
        if (now() > deadline) {
          try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* raced */ }
          continue;
        }
        sleepSync(5);
      }
    }
    try {
      return fn();
    } finally {
      try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
  function sleepSync(ms: number): void {
    const buf = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buf), 0, 0, ms);
  }

  interface TrailEntryFrame {
    v: number; ts: string; actor: string; pane: string | null; task: string | null;
    subject: string; cls: string; decision: string; scope: string; message?: string;
  }
  function validateEntry(e: unknown): TrailEntryFrame | null {
    if (typeof e !== "object" || e === null) return null;
    const o = e as Record<string, unknown>;
    if (o["v"] !== 1) return null;
    if (typeof o["ts"] !== "string" || Number.isNaN(Date.parse(o["ts"]))) return null;
    if (typeof o["actor"] !== "string" || !ACTOR_ENUM.has(o["actor"])) return null;
    if (!(o["pane"] === null || (typeof o["pane"] === "string" && o["pane"].length <= 64))) return null;
    if (!(o["task"] === null || (typeof o["task"] === "string" && o["task"].length <= 128))) return null;
    if (typeof o["subject"] !== "string" || !SUBJECT_RE.test(o["subject"])) return null;
    if (o["cls"] !== "D" && o["cls"] !== "R" && o["cls"] !== "G") return null;
    if (!["proceed", "deny", "park"].includes(o["decision"] as string)) return null;
    if (!["once", "session", "grant", "none"].includes(o["scope"] as string)) return null;
    if ("message" in o && o["message"] !== undefined) {
      if (typeof o["message"] !== "string" || o["message"].length > 500) return null;
    }
    for (const k of Object.keys(o)) {
      if (!["v", "ts", "actor", "pane", "task", "subject", "cls", "decision", "scope", "message"].includes(k)) {
        return null; // unknown fields refused (entry-immutability discipline)
      }
    }
    return o as TrailEntryFrame;
  }

  // verified no-follow opens (finding 4: backing-only/no-follow realized). Node
  // lacks openat/*at(): every protected open VERIFIES each directory component
  // (lstat: real directory, never a symlink) and opens the final component with
  // O_NOFOLLOW - a pre-planted symlink can redirect nothing.
  function verifyDirComponents(p: string): boolean {
    try {
      let cur = "/";
      for (const seg of p.split("/").filter(Boolean).slice(0, -1)) {
        cur = cur + "/" + seg;
        const st = fs.lstatSync(cur);
        if (!st.isDirectory() || st.isSymbolicLink()) return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  function openVerified(p: string, flags: number): number | null {
    if (!p.startsWith("/") || !verifyDirComponents(p)) return null;
    try {
      return fs.openSync(p, flags | fs.constants.O_NOFOLLOW);
    } catch {
      return null;
    }
  }
  /** null = clean ENOENT (absence); THROWS on refusal (symlink plant / verification
   *  failure) — callers map a throw to unavailable, never to absence. */
  function readVerified(p: string): string | null {
    // the file's own clean ENOENT short-circuits as ABSENCE (parents may not exist
    // yet — a fresh slug dir is legal); every other miss path is a REFUSED read
    let fd: number;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e; // ELOOP (symlink final), EACCES, … — refusal, not absence
    }
    try {
      if (!verifyDirComponents(p)) throw new Error("unverified components");
      return fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  function readTrailFile(slug: string): { entries: TrailEntryFrame[] } | { err: BrokerError } {
    const dir = slugDirOf(slug);
    if (!dir) return { err: "E_INVALID" };
    let raw: string | null;
    try {
      raw = readVerified(join(dir, "trail.jsonl"));
    } catch {
      return { err: "E_UNAVAILABLE" }; // refusal (symlink plant / verification failure)
    }
    if (raw === null) return { entries: [] }; // clean ENOENT -> no history
    const entries: TrailEntryFrame[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = validateEntry(JSON.parse(line)); // malformed JSON line → corrupt
      if (!parsed) return { err: "E_INVALID" };
      entries.push(parsed);
    }
    return { entries };
  }

  function appendTrailFile(slug: string, entry: TrailEntryFrame): boolean {
    const dir = slugDirOf(slug);
    if (!dir) return false;
    try {
      // verified slug-dir creation: the existing components are verified BEFORE mkdir
      if (!verifyDirComponents(dir)) return false;
      fs.mkdirSync(dir, { recursive: true });
      return withDirLock(dir, "trail", () => {
        const fd = openVerified(join(dir, "trail.jsonl"),
          fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT);
        if (fd === null) return false;
        try {
          fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`, "utf8");
          return true;
        } finally {
          fs.closeSync(fd);
        }
      });
    } catch {
      return false; // best-effort evidence [C8] — failures never block the gate
    }
  }

  function readGrantsFile(slug: string): { grants: GrantRow[] } | { err: BrokerError } {
    const dir = slugDirOf(slug);
    if (!dir) return { err: "E_INVALID" };
    let raw: string | null;
    try {
      raw = readVerified(join(dir, "grants.yaml"));
    } catch {
      return { grants: [] }; // refusal -> no grants honored (fail-closed)
    }
    if (raw === null) return { grants: [] }; // clean ENOENT
    const parsed = parseGrantsYaml(raw);
    return parsed ?? { grants: [] };
  }
  function writeGrantsFile(slug: string, grants: GrantRow[]): boolean {
    const dir = slugDirOf(slug);
    if (!dir) return false;
    try {
      if (!verifyDirComponents(dir)) return false;
      fs.mkdirSync(dir, { recursive: true });
      return withDirLock(dir, "grants", () => {
        atomicWrite(join(dir, "grants.yaml"), emitGrantsYaml(grants));
        return true;
      });
    } catch {
      return false;
    }
  }

  // ── rules gate (§4.2: mount-health + unit-state factor into EVERY rules read) ──
  interface GateFailure { error: "E_UNAVAILABLE"; reason: string }
  function rulesGate(): GateFailure | null {
    let health: { healthy?: unknown; "boot-id"?: unknown } | null = null;
    try {
      const healthTxt = readVerified(mountHealthPath);
      if (healthTxt === null) throw new Error("health unreadable or unverified");
      health = JSON.parse(healthTxt) as typeof health;
    } catch {
      return { error: "E_UNAVAILABLE", reason: "mount-health:unreadable" };
    }
    if (!health || health.healthy !== true) {
      return { error: "E_UNAVAILABLE", reason: "mount-health:unhealthy" };
    }
    if (health["boot-id"] !== currentBootId()) {
      return { error: "E_UNAVAILABLE", reason: "mount-health:stale-boot" };
    }
    const unit = mountsUnitState();
    if (unit !== "active") {
      return { error: "E_UNAVAILABLE", reason: `mounts-unit:${unit || "unreadable"}` };
    }
    return null;
  }

  function readCertifiedBackends(): {
    backends: Record<string, { "server-pid": number; "server-starttime": string }[]>;
  } {
    try {
      const certTxt = readVerified(certifiedPath);
      if (certTxt === null) return { backends: {} }; // unreadable/unverified -> empty set (fail-closed)
      const raw = JSON.parse(certTxt) as {
        backends?: { backend: string; generations?: unknown[] }[];
      };
      const out: Record<string, { "server-pid": number; "server-starttime": string }[]> = {};
      for (const b of raw.backends ?? []) {
        if (!b || typeof b.backend !== "string") continue;
        const gens: { "server-pid": number; "server-starttime": string }[] = [];
        for (const g of b.generations ?? []) {
          if (!g || typeof g !== "object") continue;
          const o = g as Record<string, unknown>;
          if (typeof o["server-pid"] === "number" && typeof o["server-starttime"] === "string") {
            gens.push({ "server-pid": o["server-pid"], "server-starttime": o["server-starttime"] });
          }
        }
        out[b.backend] = gens;
      }
      return { backends: out };
    } catch {
      return { backends: {} }; // empty set — fail-closed default (§4.4.3)
    }
  }

  function sha256hex(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }
  function hashMatches(secret: string, hash: string | null): boolean {
    if (!hash) return false;
    const a = Buffer.from(sha256hex(secret), "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ── the ancestry walk (§4.4.3 — cap, certification, both pids audited) ───────
  function ancestryAuthorize(
    assertedPid: number,
    assertedStarttime: string,
    surfaceSecret: string,
  ): { ok: true; grade: "firstmate" | "captain"; entitlement: Entitlement; generation?: { "server-pid": number } }
    | { ok: false; error: BrokerError; why: string } {
    // D1c: the surface-secret identifies the authorizing live claim.
    let authorizer: Entitlement | null = null;
    for (const e of entitlements) {
      if (e.state !== "claimed") continue;
      if (e["surface-secret-hash"] && hashMatches(surfaceSecret, e["surface-secret-hash"])) {
        authorizer = e;
        break;
      }
    }
    if (!authorizer) return { ok: false, error: "E_DENIED_UNREGISTERED", why: "no live claim for surface secret" };
    if (authorizer.grade !== "firstmate" && authorizer.grade !== "captain") {
      return { ok: false, error: "E_DENIED_GRADE", why: "surface secret bound to non-supervisor grade" };
    }
    // authorizing claim liveness re-check
    if (!revalidateClaimOnly(authorizer)) {
      return { ok: false, error: "E_DENIED_UNREGISTERED", why: "authorizing claim not live" };
    }
    if (authorizer.pid === null) return { ok: false, error: "E_DENIED_UNREGISTERED", why: "authorizer unpinned" };
    // walk the asserted connector's chain up to the authorizer, first-registered-match cap
    const self = procStat(assertedPid);
    if (!self || self.starttime !== assertedStarttime || !self.live) {
      return { ok: false, error: "E_DENIED_UNREGISTERED", why: "connector instance not verified" };
    }
    const chain: number[] = [];
    let reached = false;
    let walkPid = assertedPid;
    for (let hop = 0; hop < 64; hop++) {
      if (walkPid === authorizer.pid) { reached = true; break; }
      chain.push(walkPid);
      const st = procStat(walkPid);
      if (!st) break; // unreadable stat ends the walk
      // nearest-entitlement cap (§4.4.3): FIRST pid matching ANY entitlement (any kind,
      // claim live or dead, TTL-unexpired, instance-matching)
      const nearest = entitlements.find(
        (e) => e.pid === walkPid && e.starttime === st.starttime && e["ttl-deadline"] > now(),
      );
      if (nearest) {
        // dead claim OR worker grade ⇒ DENY — the walk does not pass through to a
        // farther live claim
        if (nearest.state !== "claimed") {
          audit("ancestry-denied", { why: "dead-claim-cap", pid: walkPid, "entitlement-id": nearest["entitlement-id"] });
          return { ok: false, error: "E_DENIED_GRADE", why: "nearest entitlement holds a dead claim" };
        }
        if (nearest.grade === "worker") {
          audit("ancestry-denied", { why: "worker-claim-cap", pid: walkPid, "entitlement-id": nearest["entitlement-id"] });
          return { ok: false, error: "E_DENIED_GRADE", why: "nearest entitlement is worker-grade" };
        }
      }
      if (st.ppid <= 1) break; // init (or a subreaper-rooted end) ends the walk
      walkPid = st.ppid;
    }
    if (!reached) {
      return { ok: false, error: "E_DENIED_UNREGISTERED", why: "walk reached init without the authorizing claim" };
    }
    // certification gate: a live certified GENERATION of the entitlement's backend must
    // sit in the walked chain (below the authorizing claim) (§4.4.3)
    const certified = readCertifiedBackends().backends[authorizer["spawn-backend"]] ?? [];
    let matched: { "server-pid": number } | undefined;
    for (const pid of chain) {
      const st = procStat(pid);
      if (!st || !st.live) continue;
      if (certified.some((g) => g["server-pid"] === pid && g["server-starttime"] === st.starttime)) {
        matched = { "server-pid": pid };
        break;
      }
    }
    if (!matched) {
      audit("ancestry-denied", {
        why: "uncertified-generation", backend: authorizer["spawn-backend"],
        connector: assertedPid, authorizer: authorizer.pid,
      });
      return { ok: false, error: "E_DENIED_TOPOLOGY", why: "no certified generation in chain" };
    }
    rollTtl(authorizer);
    audit("ancestry-authorized", {
      connector: assertedPid, authorizer: authorizer.pid,
      grade: authorizer.grade, backend: authorizer["spawn-backend"], "server-pid": matched["server-pid"],
    });
    return { ok: true, grade: authorizer.grade, entitlement: authorizer, generation: matched };
  }
  function revalidateClaimOnly(e: Entitlement): boolean {
    if (e["ttl-deadline"] <= now()) return false;
    if (e.pid !== null) {
      const st = procStat(e.pid);
      if (!st || !st.live || st.starttime !== e.starttime) return false;
    }
    return true;
  }

  // ════════════════════════ request dispatch (§4.3.2 matrix) ══════════════════
  type Frame = { id: number; op: string; args: Record<string, unknown> };
  type Res = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; retryable?: boolean; reason?: string };

  function ok(id: number, result: unknown): Res { return { id, ok: true, result }; }
  function err(id: number, error: string, extra?: { retryable?: boolean; reason?: string }): Res {
    return { id, ok: false, error, ...(extra?.retryable !== undefined ? { retryable: extra.retryable } : {}), ...(extra?.reason ? { reason: extra.reason } : {}) };
  }

  function opBucketsPass(c: ConnState, kind: "read" | "append" | "mutate"): boolean {
    const t = now();
    if (kind === "read") {
      const r = slide(c.readTimes, 120, t);
      c.readTimes = r.list;
      return r.ok;
    }
    if (kind === "append") {
      const r = slide(c.appendTimes, 60, t);
      c.appendTimes = r.list;
      return r.ok;
    }
    const r = slide(c.mutateTimes, 30, t);
    c.mutateTimes = r.list;
    return r.ok;
  }

  function slugScopeOk(c: ConnState, slug: string): boolean {
    const g = gradeOf(c);
    if (g === "root" || g === "captain" || g === "firstmate") return true;
    if (g === "worker") return c.entitlement?.["slug-scope"] === slug;
    return false;
  }

  function handleFrame(c: ConnState, f: Frame): Res {
    if (!Number.isInteger(f.id) || typeof f.op !== "string" || typeof f.args !== "object" || f.args === null) {
      return err(-1, "E_INVALID");
    }
    if (c.queued > 4) return err(f.id, "E_RATE_LIMITED"); // max 4 queued per connection
    if (!(OPS as readonly string[]).includes(f.op)) return err(f.id, "E_INVALID");
    // wire-layer slug validation: the strict allowlist runs BEFORE any store path is
    // derived (D2's substitute for dirfd discipline — no path spelling reaches the fs)
    const wireSlugOk = (v: unknown): v is string => typeof v === "string" && SLUG_RE.test(v) && v !== "." && v !== "..";
    const op = f.op as Op;
    const grade = gradeOf(c);
    const registered = grade === "worker" || grade === "firstmate" || grade === "captain";

    // status: open, non-sensitive, unauthenticated (§5 condition 3)
    if (op === "status") {
      const gate = rulesGate();
      let rulesState = "unavailable";
      let rulesReason = gate ? gate.reason : "";
      if (!gate) {
        try {
          const stTxt = readVerified(rulesFile);
          if (stTxt === null) { rulesState = "absent"; rulesReason = ""; }
          else { rulesState = "present"; rulesReason = ""; }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") rulesState = "absent";
          else { rulesState = "unavailable"; rulesReason = "rules-read-error"; }
        }
      }
      let attestedMode = "absent";
      try {
        const attTxt = readVerified(attestationPath);
        const a = attTxt === null ? {} : JSON.parse(attTxt) as { "install-mode"?: unknown };
        attestedMode = typeof a["install-mode"] === "string" ? a["install-mode"] : "absent";
      } catch { attestedMode = "absent"; }
      let slugs = 0;
      try { slugs = fs.readdirSync(storeDir).length; } catch { slugs = 0; }
      return ok(f.id, {
        mode: "broker",
        "attested-mode": attestedMode,
        "rules-state": rulesState,
        ...(rulesReason ? { "rules-reason": rulesReason } : {}),
        "mount-health": (() => {
          try { const t = readVerified(mountHealthPath); return t === null ? { healthy: false, "boot-id": null, "checked-at": null, findings: ["unreadable"] } : JSON.parse(t); } catch { return { healthy: false, "boot-id": null, "checked-at": null, findings: ["unreadable"] }; }
        })(),
        "mounts-unit-state": mountsUnitState(),
        "certified-backends": readCertifiedBackends().backends,
        connections: conns.size,
        entitlements: {
          total: entitlements.length,
          pending: entitlements.filter((e) => e.state === "pending").length,
          claimed: entitlements.filter((e) => e.state === "claimed").length,
        },
        "audit-tail": auditMem.slice(-20),
      });
    }

    // register — the four modes (§4.4.0–§4.4.2)
    if (op === "register") {
      const mode = f.args["mode"];
      if (mode === "plain") {
        // root-CLI only (§4.4.2): sudo-earned pre-pinned entitlement, roles captain/firstmate
        if (!c.control) return err(f.id, "E_DENIED_GRADE");
        const role = f.args["role"];
        if (role !== "captain" && role !== "firstmate") return err(f.id, "E_INVALID");
        const pid = f.args["pid"];
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return err(f.id, "E_INVALID");
        const backend = f.args["spawn-backend"];
        if (typeof backend !== "string" || !backend || backend.length > 64) return err(f.id, "E_INVALID");
        if (!mintBudgetOk(pid)) return err(f.id, "E_RATE_LIMITED");
        const st = procStat(pid);
        if (!st || !st.live) return err(f.id, "E_INVALID"); // target must exist post-fork
        if (entitlements.some((e) => e.pid === pid && e.starttime === st.starttime && e["ttl-deadline"] > now())) {
          return err(f.id, "E_INVALID"); // one role per process instance (§4.4.0 rule 2)
        }
        const claimSecret = randomBytes(32).toString("hex"); // D1b
        const e: Entitlement = {
          "entitlement-id": randomUUID(),
          kind: "pre-pinned",
          grade: role,
          "slug-scope": null,
          "spawn-backend": backend,
          pid,
          starttime: st.starttime,
          "boot-id": currentBootId(),
          "secret-hash": sha256hex(claimSecret),
          "minted-by": null,
          "created-by": "sudo-plain",
          "created-at": new Date(now()).toISOString(),
          "ttl-deadline": now() + TTL_MS[role],
          "expires-at": null,
          state: "pending",
          "claimed-by": null,
          "claim-count": 0,
          "consumed-at": null,
          "surface-secret-hash": null,
        };
        entitlements.push(e);
        persist();
        audit("mint-plain", { role, pid, "entitlement-id": e["entitlement-id"] });
        return ok(f.id, { "entitlement-id": e["entitlement-id"], "claim-secret": claimSecret, "ttl-ms": TTL_MS[role] });
      }
      if (mode === "enroll-worker") {
        // supervisor mints (firstmate/captain connection or root control) (§4.4.1 step 2)
        if (!(registered && (grade === "firstmate" || grade === "captain")) && grade !== "root") {
          return err(f.id, "E_DENIED_GRADE");
        }
        const slug = f.args["slug"];
        if (typeof slug !== "string" || !SLUG_RE.test(slug)) return err(f.id, "E_INVALID");
        const backend = f.args["spawn-backend"];
        if (typeof backend !== "string" || !backend || backend.length > 64) return err(f.id, "E_INVALID");
        if (!revalidate(c)) return err(f.id, "E_DENIED_UNREGISTERED");
        if (!mintBudgetOk(c.entitlement?.pid ?? c.id)) return err(f.id, "E_RATE_LIMITED");
        const token = randomBytes(32).toString("hex");
        const e: Entitlement = {
          "entitlement-id": randomUUID(),
          kind: "enrollment",
          grade: "worker",
          "slug-scope": slug, // frozen at mint — the minting connection cannot widen it
          "spawn-backend": backend,
          pid: null,
          starttime: null,
          "boot-id": null,
          "secret-hash": sha256hex(token),
          "minted-by": c.id,
          "created-by": "enrollment-mint",
          "created-at": new Date(now()).toISOString(),
          "ttl-deadline": now() + TTL_MS.worker,
          "expires-at": now() + ENROLLMENT_TTL_MS,
          state: "pending",
          "claimed-by": null,
          "claim-count": 0,
          "consumed-at": null,
          "surface-secret-hash": null,
        };
        entitlements.push(e);
        persist();
        audit("mint-enrollment", { slug, backend, "entitlement-id": e["entitlement-id"], "minted-by": c.id });
        return ok(f.id, { "enrollment-id": e["entitlement-id"], token, "expires-at": new Date(e["expires-at"] as number).toISOString() });
      }
      if (mode === "consume") {
        // the one single-use act (§4.4.0): token → pin presenter → claim, atomically
        if (registered && grade !== "root") return err(f.id, "E_INVALID"); // consume is the unknown-grade family
        const token = f.args["token"];
        if (typeof token !== "string" || token.length < 32 || token.length > 128) return err(f.id, "E_INVALID");
        if (!mintBudgetOk(typeof f.args["pid"] === "number" ? (f.args["pid"] as number) : c.id)) {
          return err(f.id, "E_RATE_LIMITED");
        }
        const hash = sha256hex(token);
        if (consumedTokens[hash]) return err(f.id, "E_DENIED_UNREGISTERED"); // tombstone: never again
        const e = entitlements.find((x) => x.kind === "enrollment" && x.state === "pending" && x["secret-hash"] === hash);
        if (!e) return err(f.id, "E_DENIED_UNREGISTERED");
        if (e["expires-at"] !== null && e["expires-at"] <= now()) {
          dropEntitlement(e, "enrollment-expired");
          return err(f.id, "E_DENIED_UNREGISTERED");
        }
        const pin = pinFromArgs(f.args); // D1d: client-asserted presenter + /proc self-consistency
        if (!pin) return err(f.id, "E_INVALID");
        e.pid = pin.pid;
        e.starttime = pin.starttime;
        e["boot-id"] = currentBootId();
        e.state = "claimed";
        e["claimed-by"] = c.id;
        e["claim-count"] += 1;
        e["consumed-at"] = new Date(now()).toISOString();
        e["ttl-deadline"] = now() + TTL_MS.worker;
        c.entitlement = e;
        consumedTokens[hash] = e["consumed-at"]; // the TOKEN is the only single-use object
        persist();
        audit("consume", { pid: pin.pid, slug: e["slug-scope"], "entitlement-id": e["entitlement-id"] });
        return ok(f.id, { grade: "worker", slug: e["slug-scope"], "entitlement-id": e["entitlement-id"] });
      }
      if (mode === "claim") {
        // pre-pinned first claim (secret required — D1b) or same-instance re-claim
        if (c.entitlement) return err(f.id, "E_INVALID"); // one entitlement per connection
        const pin0 = pinFromArgs(f.args);
        if (!pin0) return err(f.id, "E_INVALID");
        if (!reclaimBudgetAdmit(pin0.pid).admitted) {
          return err(f.id, "E_RATE_LIMITED", { retryable: true });
        }
        const pin = pin0;
        if (c.control) {
          // root may bind any connection's claim directly (matrix: root ✓ claim)
          const target = f.args["entitlement-id"];
          const e = typeof target === "string"
            ? entitlements.find((x) => x["entitlement-id"] === target)
            : undefined;
          if (!e || e["ttl-deadline"] <= now()) return err(f.id, "E_INVALID");
          e.state = "claimed";
          e["claimed-by"] = c.id;
          e["claim-count"] += 1;
          rollTtl(e);
          c.entitlement = e;
          persist();
          audit("claim", { "entitlement-id": e["entitlement-id"], by: "root" });
          return ok(f.id, { grade: e.grade, slug: e["slug-scope"], "entitlement-id": e["entitlement-id"] });
        }
        const secret = f.args["secret"];
        const candidates = entitlements.filter(
          (e) => e.state !== "claimed" && e.pid === pin.pid && e.starttime === pin.starttime && e["ttl-deadline"] > now(),
        );
        if (candidates.length === 0) return err(f.id, "E_DENIED_UNREGISTERED");
        for (const e of candidates) {
          if (e.kind === "pre-pinned") {
            // finding 1 fix: the claim-secret is ONE-SHOT. First claim consumes it
            // (tombstoned); later same-instance re-claims ride the row's pid+starttime
            // pin alone. A captured secret therefore buys exactly ONE fail-closed
            // displacement — the same bounded residual shape the design accepts for
            // enrollment tokens — and never a standing 12h bearer. (Connector-level
            // authentication is unreachable in Node: Linux exposes socket-peer pids
            // only via SO_PEERCRED, which Node does not implement; the row-pin +
            // one-shot secret is the smallest mechanism that satisfies the finding.)
            if (e["secret-hash"] !== null) {
              if (typeof secret !== "string" || !hashMatches(secret, e["secret-hash"])) {
                audit("claim-refused", { "entitlement-id": e["entitlement-id"], why: "secret-mismatch", pid: pin.pid });
                continue; // wrong/missing secret against a live secret-slot — never claims
              }
              e["secret-hash"] = null; // one-shot: the secret dies at its first successful use
            }
          } else {
            // enrollment re-claim: same-instance (pid+starttime) match is the credential;
            // displacement within a worker entitlement is the accepted bearer residual (D1d)
          }
          e.state = "claimed";
          e["claimed-by"] = c.id;
          e["claim-count"] += 1;
          rollTtl(e); // a successful re-claim ROLLS the TTL (§4.4.6)
          c.entitlement = e;
          if ((e.grade === "firstmate" || e.grade === "captain") && !e["surface-secret-hash"]) {
            e["surface-secret-hash"] = null; // set below — the secret is returned once
          }
          persist();
          audit(e["claim-count"] > 1 ? "re-claim" : "claim", { "entitlement-id": e["entitlement-id"], pid: pin.pid, grade: e.grade });
          let surfaceSecret: string | undefined;
          if (e.grade === "firstmate" || e.grade === "captain") {
            if (!e["surface-secret-hash"]) {
              // set-ONCE per entitlement: the supervisor exports it into its children's
              // env (D1c) — later re-claims must not invalidate the exported secret
              surfaceSecret = randomBytes(32).toString("hex");
              e["surface-secret-hash"] = sha256hex(surfaceSecret);
            }
            persist();
          }
          return ok(f.id, {
            grade: e.grade, slug: e["slug-scope"], "entitlement-id": e["entitlement-id"],
            ...(surfaceSecret ? { "surface-secret": surfaceSecret } : {}),
          });
        }
        return err(f.id, "E_DENIED_UNREGISTERED");
      }
      return err(f.id, "E_INVALID"); // unknown register mode
    }

    // everything beyond status/register requires a live registered claim (§4.3.1:
    // the TWO exception families are consume/claim (above) and ancestry append (below))
    if (op === "append-trail" && !registered && !c.control) {
      // family (b): ancestry-authorized append (§4.4.3) — origin=seat only.
      // A request WITHOUT the ancestry shape is not a family member at all — the
      // §4.3.1 unknown-grade law answers E_DENIED_UNREGISTERED (gate rows included).
      const pid = f.args["pid"];
      const stt = f.args["starttime"];
      const secret = f.args["surface-secret"];
      if (typeof pid !== "number" || typeof stt !== "string" || typeof secret !== "string") {
        return err(f.id, "E_DENIED_UNREGISTERED");
      }
      if (!opBucketsPass(c, "append")) return err(f.id, "E_RATE_LIMITED");
      const slug = f.args["slug"];
      const entry = validateEntry(f.args["entry"]);
      if (typeof slug !== "string" || !entry || !wireSlugOk(slug)) {
        return err(f.id, "E_INVALID");
      }
      if (entry.actor === "gate") {
        audit("gate-origin-refused", { where: "ancestry-path" });
        return err(f.id, "E_INVALID"); // origin=gate on the ancestry path is E_INVALID (§4.4.4)
      }
      if ("origin" in f.args && f.args["origin"] !== "seat") return err(f.id, "E_INVALID");
      const verdict = ancestryAuthorize(pid, stt, secret);
      if (!verdict.ok) return err(f.id, verdict.error, { reason: verdict.why });
      const stamped: TrailEntryFrame = { ...entry, actor: verdict.grade }; // server-stamped seat actor
      const appended = appendTrailFile(slug, stamped);
      return ok(f.id, { appended, actor: verdict.grade });
    }

    if (!revalidate(c)) return err(f.id, "E_DENIED_UNREGISTERED");

    if (op === "unregister") {
      if (!opBucketsPass(c, "mutate")) return err(f.id, "E_RATE_LIMITED");
      if (c.control) {
        const target = f.args["entitlement-id"];
        const e = typeof target === "string" ? entitlements.find((x) => x["entitlement-id"] === target) : undefined;
        if (!e) return err(f.id, "E_INVALID");
        dropEntitlement(e, "unregister-root");
        return ok(f.id, { unregistered: true });
      }
      const mine = c.entitlement;
      if (!mine) return err(f.id, "E_DENIED_UNREGISTERED");
      // firstmate unregister also kills ITS pending enrollments (§4.3.2)
      const killed = entitlements.filter(
        (e) => e.kind === "enrollment" && e.state === "pending" && e["minted-by"] === c.id,
      );
      for (const k of killed) dropEntitlement(k, "minter-unregister");
      dropEntitlement(mine, "unregister");
      c.entitlement = null;
      return ok(f.id, { unregistered: true, "enrollments-killed": killed.length });
    }

    if (op === "read-rules") {
      if (!registered && !c.control) return err(f.id, "E_DENIED_UNREGISTERED");
      if (!opBucketsPass(c, "read")) return err(f.id, "E_RATE_LIMITED");
      const gate = rulesGate();
      if (gate) return err(f.id, gate.error, { reason: gate.reason });
      let raw: string;
      try {
        const rulesTxt = readVerified(rulesFile);
        if (rulesTxt === null) return ok(f.id, { state: "absent" }); // ENOENT-only absence
        raw = rulesTxt;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok(f.id, { state: "absent" }); // ENOENT-only absence
        return err(f.id, "E_UNAVAILABLE", { reason: "rules-read-error" });
      }
      return ok(f.id, { state: "present", content: raw }); // client parses+validates (§4.2)
    }

    // wire-layer slug validation runs at every slug-consuming op (declared above)

    if (op === "read-trail") {
      if (!registered && !c.control) return err(f.id, "E_DENIED_UNREGISTERED");
      if (!opBucketsPass(c, "read")) return err(f.id, "E_RATE_LIMITED");
      const slug = f.args["slug"];
      if (typeof slug !== "string") return err(f.id, "E_INVALID");
      if (!wireSlugOk(slug)) return err(f.id, "E_INVALID");
      if (!slugScopeOk(c, slug)) return err(f.id, "E_DENIED_SLUG");
      const r = readTrailFile(slug);
      if ("err" in r) return err(f.id, r.err);
      return ok(f.id, { entries: r.entries });
    }

    if (op === "read-grants") {
      if (!registered && !c.control) return err(f.id, "E_DENIED_UNREGISTERED");
      if (!opBucketsPass(c, "read")) return err(f.id, "E_RATE_LIMITED");
      const slug = f.args["slug"];
      if (typeof slug !== "string") return err(f.id, "E_INVALID");
      if (!wireSlugOk(slug)) return err(f.id, "E_INVALID");
      if (!slugScopeOk(c, slug)) return err(f.id, "E_DENIED_SLUG");
      const r = readGrantsFile(slug);
      return ok(f.id, { grants: r.grants });
    }

    if (op === "append-trail") {
      if (!registered && !c.control) return err(f.id, "E_DENIED_UNREGISTERED");
      if (!opBucketsPass(c, "append")) return err(f.id, "E_RATE_LIMITED");
      const slug = f.args["slug"];
      const entry = validateEntry(f.args["entry"]);
      if (typeof slug !== "string" || !entry) return err(f.id, "E_INVALID");
      if (!wireSlugOk(slug)) return err(f.id, "E_INVALID");
      if (!slugScopeOk(c, slug)) return err(f.id, "E_DENIED_SLUG");
      // ── the append origin law (§4.4.4): origin is DERIVED from the actor field ──
      const frameOrigin = f.args["origin"];
      const derivedOrigin = entry.actor === "gate" ? "gate" : "seat";
      if (frameOrigin !== undefined && frameOrigin !== derivedOrigin) {
        return err(f.id, "E_INVALID"); // disagreement refused
      }
      if (entry.actor === "gate") {
        // origin=gate rows: registered live gate-process connections only (any grade);
        // stamped actor=gate VERBATIM — pane/task/subject/cls/decision/scope/message carried
        const stamped: TrailEntryFrame = { ...entry, actor: "gate" };
        const appended = appendTrailFile(slug, stamped);
        if (c.entitlement) rollTtl(c.entitlement);
        return ok(f.id, { appended, actor: "gate", ts: stamped.ts });
      }
      // origin=seat: the client actor is IGNORED — the claim grade is stamped (forgery audit)
      const stampedGrade = gradeOf(c) === "root" ? "captain" : (gradeOf(c) as "captain" | "firstmate" | "worker");
      if (entry.actor !== stampedGrade) {
        audit("actor-forgery-attempt", { claimed: entry.actor, stamped: stampedGrade });
      }
      const stamped: TrailEntryFrame = { ...entry, actor: stampedGrade };
      const appended = appendTrailFile(slug, stamped);
      if (c.entitlement) rollTtl(c.entitlement);
      return ok(f.id, { appended, actor: stampedGrade, ts: stamped.ts });
    }

    if (op === "create-grant") {
      if (!registered && !c.control) return err(f.id, "E_DENIED_UNREGISTERED");
      if (!opBucketsPass(c, "mutate")) return err(f.id, "E_RATE_LIMITED");
      const slug = f.args["slug"];
      const pattern = f.args["pattern"];
      if (typeof slug !== "string" || typeof pattern !== "string") return err(f.id, "E_INVALID");
      if (!pattern.trim() || pattern.length > 200 || /\n/.test(pattern)) return err(f.id, "E_INVALID");
      // Q3/N4 server-side law: workers NEVER; firstmate R-class only — the schema admits
      // only R structurally (the class field does not exist on the wire) — never-D stays never-D
      const g = gradeOf(c);
      if (g === "worker") {
        audit("denied-grade", { op: "create-grant", slug });
        return err(f.id, "E_DENIED_GRADE");
      }
      const r = readGrantsFile(slug);
      const grants = ("grants" in r ? r.grants : []);
      const id = `g-${now().toString(36)}-${randomBytes(3).toString("hex")}`;
      const row: GrantRow = {
        id,
        "created-at": new Date(now()).toISOString(),
        "creator-seat": g === "root" ? "captain" : g,
        pattern: pattern.trim(),
        "class-filter": "R",
      };
      grants.push(row);
      if (!writeGrantsFile(slug, grants)) return err(f.id, "E_UNAVAILABLE");
      if (c.entitlement) rollTtl(c.entitlement);
      audit("create-grant", { slug, id, grade: g });
      return ok(f.id, { id, "created-at": row["created-at"], actor: row["creator-seat"] });
    }

    if (op === "revoke-grant") {
      if (!registered && !c.control) return err(f.id, "E_DENIED_UNREGISTERED");
      if (!opBucketsPass(c, "mutate")) return err(f.id, "E_RATE_LIMITED");
      const g = gradeOf(c);
      if (g !== "captain" && g !== "root") return err(f.id, "E_DENIED_GRADE");
      const slug = f.args["slug"];
      const id = f.args["id"];
      if (typeof slug !== "string" || typeof id !== "string") return err(f.id, "E_INVALID");
      const r = readGrantsFile(slug);
      const grants = "grants" in r ? r.grants : [];
      const next = grants.filter((x) => x.id !== id);
      if (next.length === grants.length) return err(f.id, "E_INVALID");
      if (!writeGrantsFile(slug, next)) return err(f.id, "E_UNAVAILABLE");
      if (c.entitlement) rollTtl(c.entitlement);
      audit("revoke-grant", { slug, id });
      return ok(f.id, { revoked: id });
    }

    if (op === "write-rules") {
      if (!registered && !c.control) return err(f.id, "E_DENIED_UNREGISTERED");
      if (!opBucketsPass(c, "mutate")) return err(f.id, "E_RATE_LIMITED");
      const g = gradeOf(c);
      if (g !== "captain" && g !== "root") return err(f.id, "E_DENIED_GRADE");
      const content = f.args["content"];
      if (typeof content !== "string" || content.length > 1_000_000) return err(f.id, "E_INVALID");
      if (!validateRulesYaml(content)) return err(f.id, "E_INVALID"); // fail-closed validation
      try {
        atomicWrite(rulesFile, content); // mkstemp-class O_EXCL 0660 + rename — atomic through both paths (§4.1.1)
      } catch {
        return err(f.id, "E_UNAVAILABLE");
      }
      if (c.entitlement) rollTtl(c.entitlement);
      audit("write-rules", { bytes: content.length, grade: g });
      return ok(f.id, { written: true });
    }

    return err(f.id, "E_INVALID");
  }

  // ── connection plumbing ─────────────────────────────────────────────────────
  function attach(socket: net.Socket, control: boolean): void {
    const c: ConnState = {
      id: nextConnId++,
      control,
      entitlement: null,
      surfaceSecret: null,
      socket,
      queued: 0,
      readTimes: [],
      appendTimes: [],
      mutateTimes: [],
    };
    conns.set(c.id, c);
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let f: Frame;
        try {
          f = JSON.parse(line) as Frame;
        } catch {
          socket.write(`${JSON.stringify({ id: -1, ok: false, error: "E_INVALID" })}\n`);
          continue;
        }
        c.queued += 1;
        let res: Res;
        try {
          res = handleFrame(c, f);
        } catch (e) {
          console.error("broker frame error:", (e as Error).stack ?? String(e)); // journal-side only
          res = err(f.id, "E_UNAVAILABLE"); // internal failure ⇒ fixed error, never a stack echo
        }
        c.queued -= 1;
        try {
          socket.write(`${JSON.stringify(res)}\n`);
        } catch { /* socket gone */ }
      }
    });
    socket.on("close", () => {
      conns.delete(c.id);
      if (c.entitlement) {
        // socket close drops the claim and NOTHING else — the entitlement SURVIVES for
        // same-instance re-claim (§4.4.0 single-use/re-claim law)
        c.entitlement["claimed-by"] = null;
        c.entitlement.state = "claim-voided";
        audit("claim-drop", { "entitlement-id": c.entitlement["entitlement-id"], why: "socket-close" });
        c.entitlement = null;
        persist();
      }
      // minter-death law (§4.4.1) — finding 2 scope fix: pending enrollments minted
      // by this connection die, EXCEPT root-control mints. A control-socket exit is
      // the sudo CLI's normal lifecycle (mint-then-exit), not an unexpected minter
      // death; the root trust anchor replaces the long-lived supervisor connection
      // the design's law presumes. Daemon restart still kills every pending
      // enrollment (§4.4.0 step 4) — unchanged.
      if (!c.control) {
        const orphans = entitlements.filter(
          (e) => e.kind === "enrollment" && e.state === "pending" && e["minted-by"] === c.id,
        );
        for (const o of orphans) dropEntitlement(o, "minter-death");
      }
    });
    socket.on("error", () => { /* close follows */ });
  }

  function ensureLayout(): void {
    for (const d of [cfg.rootDir, storeDir, rulesDir, stateDir, runtimeDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch { /* tests may pre-create stricter */ }
    }
    try {
      if (!fs.existsSync(registrationsPath)) {
        fs.writeFileSync(registrationsPath, JSON.stringify({ version: 1, "boot-id": currentBootId(), entitlements: [], "consumed-tokens": {} }, null, 2), { mode: 0o660 });
      }
      if (!fs.existsSync(auditRingPath)) fs.writeFileSync(auditRingPath, "", { mode: 0o660 });
    } catch { /* install-created in production; best-effort in scratch */ }
  }

  function sdNotifyReady(): void {
    if (cfg.testMode) return;
    const ns = process.env["NOTIFY_SOCKET"];
    if (!ns) return;
    try {
      const sock = dgram.createSocket("unix_dgram");
      sock.send(`READY=1\nMAIN_PID=${process.pid}\n`, () => sock.close());
    } catch { /* Type=notify best-effort from Node; systemd degrades on timeout */ }
  }

  ensureLayout();
  rebuild();

  const server = net.createServer((s) => attach(s, false));
  const controlServer = net.createServer((s) => attach(s, true));
  for (const p of [cfg.socketPath, cfg.controlSocketPath]) {
    try { fs.unlinkSync(p); } catch { /* absent */ }
  }
  try { fs.mkdirSync(dirname(cfg.socketPath), { recursive: true }); } catch { /* RuntimeDirectory in prod */ }

  const closedPromise = new Promise<void>((resolveClosed) => {
    let pending = 2;
    const maybeDone = () => { if (--pending === 0) resolveClosed(); };
    server.listen(cfg.socketPath, () => {
      try { fs.chmodSync(cfg.socketPath, 0o666); } catch { /* test scratch may differ */ }
      maybeDone();
    });
    controlServer.listen(cfg.controlSocketPath, () => {
      // D1a: root-only — mode 0600. In production /run/minidc-broker is root-owned 0755,
      // so connectability is the kernel proof of root. In testMode the scratch owner
      // plays root (module seam, never env-readable).
      try { fs.chmodSync(cfg.controlSocketPath, 0o600); } catch { /* best-effort */ }
      maybeDone();
    });
    server.on("close", maybeDone);
    controlServer.on("close", maybeDone);
  });

  // TTL/expiry sweep (§4.4.0: entitlement expiry drops the row with an audit event)
  const sweep = setInterval(() => {
    const t = now();
    for (const e of [...entitlements]) {
      if (e.kind === "enrollment" && e.state === "pending" && e["expires-at"] !== null && e["expires-at"] <= t) {
        dropEntitlement(e, "enrollment-expired");
        continue;
      }
      if (e["ttl-deadline"] <= t) dropEntitlement(e, "ttl-expired");
    }
    // reclaim-window map hygiene: drop windows older than 2 minutes
    const wNow = reclaimWindowIndex(t);
    for (const k of [...reclaimWindowGlobal.keys()]) if (k < wNow - 1) reclaimWindowGlobal.delete(k);
    for (const k of [...reclaimWindowByPid.keys()]) {
      const w = Number(k.split(":")[0]);
      if (Number.isInteger(w) && w < wNow - 1) reclaimWindowByPid.delete(k);
    }
  }, cfg.testMode ? 150 : 10_000);
  sweep.unref?.();

  audit("daemon-start", { test: cfg.testMode });
  sdNotifyReady(); // Type=notify READY=1 once both listeners are up

  return {
    config: cfg,
    auditTail: () => [...auditMem],
    entitlementsSnapshot: () => entitlements.map((e) => ({ ...e })),
    registrationCount: () => entitlements.length,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      server.close();
      controlServer.close();
      for (const c of conns.values()) c.socket.destroy();
      await closedPromise;
      try { fs.unlinkSync(cfg.socketPath); } catch { /* absent */ }
      try { fs.unlinkSync(cfg.controlSocketPath); } catch { /* absent */ }
    },
  };
}

function pinFromArgs(args: Record<string, unknown>): { pid: number; starttime: string } | null {
  const pid = args["pid"];
  const stt = args["starttime"];
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return null;
  if (typeof stt !== "string" || !/^\d+$/.test(stt)) return null;
  const st = procStat(pid);
  if (!st || !st.live || st.starttime !== stt) return null; // /proc self-consistency (D1d)
  return { pid, starttime: stt };
}

function randomUUID(): string {
  return randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
}

// ── production entry (systemd: Type=notify, TimeoutStartSec=60) ───────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === (process.argv[1] as string)) {
  const cfg = defaultConfig();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) cfg.rootDir = args[i + 1] as string;
    if (args[i] === "--socket" && args[i + 1]) cfg.socketPath = args[i + 1] as string;
    if (args[i] === "--control-socket" && args[i + 1]) cfg.controlSocketPath = args[i + 1] as string;
    if (args[i] === "--test-mode") { cfg.testMode = true; cfgTestModeFlag = true; }
  }
  const broker = createBroker(cfg);
  const shutdown = () => {
    void broker.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // main() awaits nothing: the event loop stays alive via the listening servers
  void broker;
}
