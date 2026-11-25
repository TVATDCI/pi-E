// minidc-owner-launch.test.ts — defect 8 regression (2026-11-25, TNT root-cause
// handoff): under packaged Pi, extensions/minidc-broker-client.ts launched its
// bridge owner with process.execPath — the Pi application, not Node — and Pi
// treats -e as an extension-file option, so the owner was born inert (no
// connect, no register, no consume; silent). This test exercises the REAL
// packaged-Pi launch path end to end against an in-process fake broker: the
// owner must connect and submit its register-consume frame carrying the
// disposable enrollment token and the session identity. A Node-only runner
// cannot cover this (the whole defect is the host binary) — hence the packaged
// spawn. The unit under test is loaded by CONCATENATING the client source with
// a driver tail into ONE -e extension file (pi's -e loader cannot resolve
// nested relative .ts imports — the require-stack lesson of this very round).
// Red on the pre-fix source (owner inert, no frame); green with the fix.
import * as net from "node:net";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
function ok(m: string) { pass++; console.log(`  ✓ ${m}`); }
function bad(m: string) { fail++; console.log(`  ✗ ${m}`); }

const TOKEN = "1f2e3d4c5b6a79887766554433221100ffeeddccbbaa99887766554433221100";
const HERE = new URL(".", import.meta.url).pathname;
// TEST_CLIENT_SRC: red-proof seam — point at a pristine client copy to show
// the test fails on the pre-fix source (the failing-first evidence).
const CLIENT_SRC = process.env.TEST_CLIENT_SRC
  || join(HERE, "..", "..", "extensions", "minidc-broker-client.ts");

const D = mkdtempSync(join(tmpdir(), "owner-launch-"));
mkdirSync(join(D, "tree"));
mkdirSync(join(D, "rules"), { recursive: true });
writeFileSync(join(D, "marker"), "broker");
writeFileSync(join(D, "rules", "rules.yaml"), "");
const sockPath = join(D, "test.sock");

// the single-file extension: the client source + a driver tail (same module
// scope; the -e default-export contract receives the pi API as its parameter)
const DRIVER_TAIL = `

// ── test driver tail (appended by minidc-owner-launch.test.ts) ──────────────
export default function (pi: any) {
  pi.on("session_start", async () => {
    setBrokerPathsForTesting({
      treePath: process.env.TEST_TREE_DIR as string,
      socketPath: process.env.TEST_BROKER_SOCKET as string,
      markerPath: process.env.TEST_MARKER as string,
      attestedRulesPath: process.env.TEST_ATTESTED_RULES as string,
      legacyRulesPath: process.env.TEST_LEGACY_RULES as string,
    });
    await initBrokerClient(process.env as unknown as Record<string, string | undefined>);
  });
}
`;
const combined = readFileSync(CLIENT_SRC, "utf8") + DRIVER_TAIL;
const extFile = join(D, "combined-ext.ts");
writeFileSync(extFile, combined);

const frames: string[] = [];
const server = net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      frames.push(line);
      let f: { id?: number; op?: string } = {};
      try { f = JSON.parse(line); } catch { /* ignore */ }
      if (f.op === "status") {
        c.write(JSON.stringify({ id: f.id, ok: true, result: { "attested-mode": "broker" } }) + "\n");
      } else if (f.op === "register") {
        c.write(JSON.stringify({ id: f.id, ok: true, result: { grade: "worker", slug: "pi-E", "entitlement-id": "test-eid" } }) + "\n");
      } else {
        c.write(JSON.stringify({ id: f.id, ok: true, result: {} }) + "\n");
      }
    }
  });
});
await new Promise<void>((resolve) => server.listen(sockPath, resolve));

const piBin = process.env.TEST_PI_BIN || join(process.env.HOME || "/home/vladi",
  ".local/share/mise/installs/pi/1.6.0/pi/pi");
if (!fs.existsSync(piBin)) {
  console.log(`  — skipped (packaged pi not found at ${piBin}; set TEST_PI_BIN)`);
  server.close();
  process.exit(0);
}

const child = spawn(piBin, ["-e", extFile, "-p", "ack"], {
  env: {
    ...process.env,
    PI_PURPOSE: "defect-8 owner-launch regression",
    MINIDC_ENROLLMENT: TOKEN,
    TEST_TREE_DIR: join(D, "tree"),
    TEST_BROKER_SOCKET: sockPath,
    TEST_MARKER: join(D, "marker"),
    TEST_ATTESTED_RULES: join(D, "rules"),
    TEST_LEGACY_RULES: join(D, "legacy.yaml"),
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderrTail = "";
child.stderr?.on("data", (d: Buffer) => { stderrTail += d.toString("utf8").slice(-600); });
const rc = await new Promise<number>((resolve) => {
  child.on("exit", (c2) => resolve(c2 ?? -1));
  setTimeout(() => { try { child.kill(); } catch { /* already gone */ } resolve(-1); }, 60000).unref?.();
});

for (let n = 0; n < 12 && !frames.some((l) => l.includes('"mode":"consume"')); n++) {
  await new Promise((r) => setTimeout(r, 500));
}
server.close();

if (frames.some((l) => l.includes('"mode":"consume"'))) ok("owner connected and submitted its register-consume frame");
else bad(`no register-consume frame reached the broker (owner inert — defect 8 shape); pi rc=${rc}; stderr tail: ${stderrTail.slice(-300)}`);
if (frames.some((l) => l.includes(TOKEN))) ok("the frame carries the disposable enrollment token");
else bad("the enrollment token never reached the broker");
if (frames.some((l) => l.includes('"pid":')) && frames.some((l) => l.includes('"starttime":'))) {
  ok("the frame carries the session identity (pid + starttime)");
} else {
  bad("the frame lacks the session identity");
}

fs.rmSync(D, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
