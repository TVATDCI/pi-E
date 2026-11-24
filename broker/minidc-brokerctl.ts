#!/usr/bin/env -S node --experimental-strip-types
// broker/minidc-brokerctl — the thin CLI over the broker (design §7.2, §2 P4/P5;
// R2 v2 certification legs per broker/minidc-certify.ts).
//   status                       — OPEN, unauthenticated, non-sensitive
//   register --role <captain|firstmate> --pid <pid> --spawn-backend <b>
//                                — sudo-anchored (control socket; §4.4.2 pre-pinned mint;
//                                   prints the claim-secret ONCE — the wrapper routes it to
//                                   the session env; never logged anywhere else)
//   register --enroll-worker --slug <s> --spawn-backend <b>
//                                — control socket (root mint; supervisor mints normally go
//                                   over the supervisor's own registered bridge connection)
//   unregister [--entitlement-id <id>]
//                                — control socket
//   certify --backend <b> --exe <path> --adapter <path>
//                                — sudo (CAPTAIN authority, R1/R2/R3): the SOLE writer of
//                                   certification records — verifies the installed backend
//                                   against the repo-approved digest list, checks
//                                   broker-protocol compatibility, binds the desk-local
//                                   installation ID, records the generation atomically
//   certify --revoke --backend <b>
//                                — sudo (captain): tombstones the backend's records
//   trail-tail --slug <s> [--n 20]   — sudo (captain ad-hoc reads; §2 consequence)
//   list-grants --slug <s>           — sudo
//   write-rules --file <f|->         — sudo (captain authority)
// There is NO read-rules command — not ever (§4.3.2 no-CLI-reads law).
// The ancestry append-trail command is GONE (superseded by the R2 v2 presenter
// family: open-claim / delegate-claim over the main socket — kernel identity,
// never environment variables).
// Test seam: --socket PATH overrides the main socket; --control-socket PATH the control
// socket (also FM_DC_STORE_ROOT remaps to the test socket per the P4 note); --root and
// --approved remap the certify state/approved paths. No env-based sockets in production
// paths beyond that documented test remap.

import * as net from "node:net";
import * as fs from "node:fs";
import { join } from "node:path";
import { certifyBackend, revokeBackend } from "./minidc-certify.ts";

const argv = process.argv.slice(2);

function usage(): never {
  console.error(`usage: minidc-brokerctl <command> [options]
commands:
  status [--socket P]
  register --role <captain|firstmate> --pid <N> --spawn-backend <B> [--ttl-ms N]
  register --enroll-worker --slug <S> --spawn-backend <B>
  unregister [--entitlement-id <ID>]
  certify --backend <B> --exe <PATH> --adapter <PATH> [--root DIR] [--approved FILE] [--socket P]
  certify --revoke --backend <B> [--root DIR]
  trail-tail --slug <S> [--n N]
  list-grants --slug <S>
  write-rules --file <F|->`);
  process.exit(2);
}

function arg(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] as string) : null;
}
function has(name: string): boolean {
  return argv.includes(name);
}

const DEFAULT_SOCKET = "/run/minidc-broker/socket";
const DEFAULT_CONTROL = "/run/minidc-broker/control.sock";
const DEFAULT_STATE_DIR = "/var/lib/minidc-broker/state";

function socketPath(main: boolean): string {
  if (main) {
    const o = arg("--socket");
    if (o) return o;
    // FM_DC_STORE_ROOT test remap (P4 note): the answer-surface test harness points the
    // store root at scratch; the broker test socket rides the same variable.
    if (process.env["FM_DC_STORE_ROOT"] && process.env["FM_DC_STORE_ROOT"].startsWith("/tmp/")) {
      return `${process.env["FM_DC_STORE_ROOT"]}/socket`;
    }
    return DEFAULT_SOCKET;
  }
  return arg("--control-socket") ?? DEFAULT_CONTROL;
}

function stateDir(): string {
  return arg("--root") ? join(arg("--root") as string, "state") : DEFAULT_STATE_DIR;
}

function call(path: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path, () => {
      s.write(`${JSON.stringify(frame)}\n`);
    });
    let buf = "";
    s.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) {
        s.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
        } catch {
          reject(new Error("malformed frame"));
        }
      }
    });
    s.on("error", (e: Error) => reject(e));
  });
}

async function main(): Promise<number> {
  const cmd = argv[0];
  if (!cmd) usage();
  let nextId = 1;

  if (cmd === "status") {
    const r = await call(socketPath(true), { id: nextId++, op: "status", args: {} });
    if (r["ok"] === true) {
      console.log(JSON.stringify(r["result"], null, 2));
      return 0;
    }
    console.error(`broker status failed: ${r["error"]}`);
    return 1;
  }

  if (cmd === "register") {
    const ctl = socketPath(false);
    if (has("--enroll-worker")) {
      const slug = arg("--slug");
      const backend = arg("--spawn-backend");
      if (!slug || !backend) usage();
      const r = await call(ctl, { id: nextId++, op: "register", args: { mode: "enroll-worker", slug, "spawn-backend": backend } });
      if (r["ok"] === true) {
        const res = r["result"] as Record<string, unknown>;
        console.log(`enrollment-id: ${res["enrollment-id"]}`);
        console.log(`token: ${res["token"]}`);
        console.log(`expires-at: ${res["expires-at"]}`);
        return 0;
      }
      console.error(`register failed: ${r["error"]}`);
      return 1;
    }
    const role = arg("--role");
    const pid = arg("--pid");
    const backend = arg("--spawn-backend");
    if (!role || !pid || !backend) usage();
    const r = await call(ctl, {
      id: nextId++,
      op: "register",
      args: { mode: "plain", role, pid: Number(pid), "spawn-backend": backend },
    });
    if (r["ok"] === true) {
      const res = r["result"] as Record<string, unknown>;
      // The claim-secret crosses ONLY this stdout — the launching wrapper's terminal.
      console.log(`entitlement-id: ${res["entitlement-id"]}`);
      console.log(`claim-secret: ${res["claim-secret"]}`);
      return 0;
    }
    console.error(`register failed: ${r["error"]}`);
    return 1;
  }

  if (cmd === "unregister") {
    const args: Record<string, unknown> = {};
    const id = arg("--entitlement-id");
    if (id) args["entitlement-id"] = id;
    const r = await call(socketPath(false), { id: nextId++, op: "unregister", args });
    if (r["ok"] === true) { console.log("unregistered"); return 0; }
    console.error(`unregister failed: ${r["error"]}`);
    return 1;
  }

  if (cmd === "certify") {
    const backend = arg("--backend");
    if (!backend) usage();
    const dir = stateDir();
    if (has("--revoke")) {
      const r = await revokeBackend({ backend, stateDir: dir, requireRoot: true });
      if (r.ok === true) {
        console.log(`revoked: ${backend} (${r.revoked} generation${r.revoked === 1 ? "" : "s"} tombstoned)`);
        return 0;
      }
      console.error(`revoke failed: ${r.err}`);
      return 1;
    }
    const exe = arg("--exe");
    const adapter = arg("--adapter");
    if (!exe || !adapter) usage();
    const approved = arg("--approved") ?? join(dir, "approved-backends.json");
    const r = await certifyBackend({
      backend, exePath: exe, adapterPath: adapter,
      stateDir: dir, approvedListPath: approved,
      socketPath: socketPath(true), requireRoot: true,
    });
    if (r.ok === true) {
      const rec = r.receipt;
      console.log(`certified: backend=${rec.backend} generation=${rec["generation-id"]}`);
      console.log(`  exe=${rec["exe-digest"]} adapter=${rec["adapter-digest"]}`);
      console.log(`  protocol-revision=${rec["protocol-revision"]} installation-id=${rec["installation-id"]}`);
      if (rec.superseded) console.log("  (superseded a previous live generation for this backend)");
      return 0;
    }
    console.error(`certify failed: ${r.err} (no partial grant written)`);
    return 1;
  }

  if (cmd === "trail-tail") {
    const slug = arg("--slug");
    if (!slug) usage();
    const n = Number(arg("--n") ?? "20");
    const r = await call(socketPath(false), { id: nextId++, op: "read-trail", args: { slug } });
    if (r["ok"] !== true) { console.error(`trail-tail failed: ${r["error"]}`); return 1; }
    const res = r["result"] as { entries: unknown[] };
    for (const e of res.entries.slice(-n)) console.log(JSON.stringify(e));
    return 0;
  }

  if (cmd === "list-grants") {
    const slug = arg("--slug");
    if (!slug) usage();
    const r = await call(socketPath(false), { id: nextId++, op: "read-grants", args: { slug } });
    if (r["ok"] !== true) { console.error(`list-grants failed: ${r["error"]}`); return 1; }
    const res = r["result"] as { grants: Record<string, string>[] };
    if (res.grants.length === 0) { console.log("(no grants)"); return 0; }
    for (const g of res.grants) console.log(`${g["id"]}  ${g["creator-seat"]}  ${g["class-filter"]}  ${g["pattern"]}  (${g["created-at"]})`);
    return 0;
  }

  if (cmd === "write-rules") {
    const file = arg("--file");
    if (!file) usage();
    const content = file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
    const r = await call(socketPath(false), { id: nextId++, op: "write-rules", args: { content } });
    if (r["ok"] === true) { console.log("written"); return 0; }
    console.error(`write-rules failed: ${r["error"]}`);
    return 1;
  }

  usage();
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(`minidc-brokerctl: ${(e as Error).message}`);
  process.exit(1);
});
