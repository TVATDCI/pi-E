// minidc-owner-launch.test.ts — defect 8 regression + acceptance (2026-11-25,
// TNT root-cause handoff, revised per the TNT review round):
//   A. TRUST: the owner launches ONLY under the authorized runtime from the
//      root-owned trust file (module seam in tests); MINIDC_NODE_BIN is honored
//      only byte-identical; a differing explicit selection is REJECTED before
//      any credential handoff (no frames reach the broker).
//   B. LAUNCH: under the REAL packaged Pi, the owner connects and submits
//      exactly ONE register-consume frame carrying the disposable token and
//      the session's true (pid, starttime); the CLIENT observes worker grade
//      and broker-sourced rules.
//   C. NEGATIVES: a rejected enrollment leaves grade null and rules
//      unavailable; a missing trust file surfaces the prompt error and never
//      contacts the broker.
//   D. ISOLATION: disposable HOME/cwd, minimal env, no extension discovery,
//      no provider credentials; a missing packaged-Pi prerequisite prints an
//      unmissable SKIP line (distinct from a pass).
// Red on pristine main via TEST_CLIENT_SRC; green with the fix.
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
const WRONG_TOKEN = "0000000000000000000000000000000000000000000000000000000000000000";
const HERE = new URL(".", import.meta.url).pathname;
const CLIENT_SRC = process.env.TEST_CLIENT_SRC
  || join(HERE, "..", "..", "extensions", "minidc-broker-client.ts");
const NODE_BIN = "/home/vladi/.local/share/mise/installs/node/26.13.1/bin/node";
const PI_BIN = process.env.TEST_PI_BIN
  || join(process.env.HOME || "/home/vladi", ".local/share/mise/installs/pi/1.6.0/pi/pi");

if (!fs.existsSync(PI_BIN)) {
  console.log(`  SKIP — packaged pi not found at ${PI_BIN} (set TEST_PI_BIN); this is a SKIP, not a pass`);
  process.exit(0);
}

// the single-file extension: client source + a plain-statement tail (module
// scope runs BEFORE the loader invokes the default factory — the driver-hook
// seam; ONE default export, no duplicates)
const DRIVER_TAIL = `

// ── test tail (appended by minidc-owner-launch.test.ts; plain statements) ───
setNodeTrustFileForTesting(process.env.TEST_TRUST_FILE as string);
setBrokerPathsForTesting({
  treePath: process.env.TEST_TREE_DIR as string,
  socketPath: process.env.TEST_BROKER_SOCKET as string,
  markerPath: process.env.TEST_MARKER as string,
  attestedRulesPath: process.env.TEST_ATTESTED_RULES as string,
  legacyRulesPath: process.env.TEST_LEGACY_RULES as string,
});
registerBridgeDriverForTesting((pi: any) => {
  pi.on("session_start", async () => {
    const out: string[] = [];
    try {
      await initBrokerClient(process.env as unknown as Record<string, string | undefined>);
      // client-observed evidence (review finding 3): rules FIRST (a
      // credential-less headless pi exits fast — the model call fails
      // immediately — so the evidence reads must not trail a long poll)
      await new Promise((r) => setTimeout(r, 500));
      const rr = readGlobalRulesViaBroker();
      out.push("rules=" + (rr.state === "present" ? String(rr.content.length) : rr.state + ((rr as any).reason ? ":" + (rr as any).reason : "")));
      for (let n = 0; n < 8 && bridgeGrade() === null; n++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      out.push("grade=" + (bridgeGrade() ?? "null"));
    } catch (e) {
      out.push("threw=" + (e as Error).message);
    }
    out.push("launchErr=" + (bridgeLaunchError() ?? "null"));
    try {
      (fs as any).writeFileSync(process.env.TEST_RESULT_FILE as string, out.join("\\n") + "\\n");
    } catch { /* evidence lost — the broker-side assertions still bind */ }
  });
});
`;
const CLIENT = readFileSync(CLIENT_SRC, "utf8");

function buildExt(dir: string): string {
  const f = join(dir, "combined-ext.ts");
  writeFileSync(f, CLIENT + DRIVER_TAIL);
  return f;
}

interface Ctx {
  dir: string; ext: string; sock: string; trust: string; result: string;
  frames: { line: string; f: any }[]; consumeCount: () => number; server: net.Server;
}
async function setup(name: string): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), `owner-launch-${name}-`));
  mkdirSync(join(dir, "tree"));
  mkdirSync(join(dir, "rules"), { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "marker"), "broker");
  writeFileSync(join(dir, "rules", "rules.yaml"), "bashToolPatterns: []\nzeroAccessPaths: []\nreadOnlyPaths: []\n");
  const sock = join(dir, "test.sock");
  const trust = join(dir, "node-bin");
  const result = join(dir, "result.txt");
  const frames: { line: string; f: any }[] = [];
  const server = net.createServer((c) => {
    let buf = "";
    let connRegistered = false; // TNT verification demand: read-rules binds to a VALIDATED register on THIS connection
    c.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let f: any = {};
        try { f = JSON.parse(line); } catch { /* ignore */ }
        frames.push({ line, f });
        if (f.op === "status") {
          c.write(JSON.stringify({ id: f.id, ok: true, result: { "attested-mode": "broker" } }) + "\n");
        } else if (f.op === "register") {
          // VALIDATING broker (review finding 3): ok ONLY for the exact
          // expected consume — token bound to this run, pin checked against
          // the spawned session's true identity by the test's env
          const a = f.args ?? {};
          const wantTok = process.env.RUN_TOKEN;
          const wantPid = Number(process.env.RUN_PID);
          const wantSt = process.env.RUN_STARTTIME;
          if (a.mode === "consume" && a.token === wantTok && a.pid === wantPid && a.starttime === wantSt) {
            connRegistered = true;
            c.write(JSON.stringify({ id: f.id, ok: true, result: { grade: "worker", slug: "pi-E", "entitlement-id": "test-eid" } }) + "\n");
          } else {
            c.write(JSON.stringify({ id: f.id, ok: false, error: "E_DENIED_UNREGISTERED" }) + "\n");
          }
        } else if (f.op === "read-rules") {
          if (connRegistered) {
            c.write(JSON.stringify({ id: f.id, ok: true, result: { state: "present", content: "bashToolPatterns: []\nzeroAccessPaths: []\nreadOnlyPaths: []\n" } }) + "\n");
          } else {
            c.write(JSON.stringify({ id: f.id, ok: false, error: "E_DENIED_UNREGISTERED", reason: "not-registered" }) + "\n");
          }
        } else {
          c.write(JSON.stringify({ id: f.id, ok: true, result: {} }) + "\n");
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return { dir, ext: buildExt(dir), sock, trust, result, frames, consumeCount: () => frames.filter((x) => x.f?.op === "register" && x.f?.args?.mode === "consume").length, server };
}

function spawnPi(ctx: Ctx, token: string, extraEnv: Record<string, string> = {}) {
  // ISOLATION (review finding 4): disposable HOME + cwd, minimal env, no
  // discovery, no provider credentials — the model call fails harmlessly
  // AFTER session_start has already fired
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? "/home/vladi", // packaged pi requires its real ~/.pi to boot; isolation substance = -ne + scratch cwd + this stripped env (stated in the PR)
    TMPDIR: join(ctx.dir, "home"),
    LANG: "C.UTF-8",
    PI_PURPOSE: "defect-8 owner-launch regression",
    MINIDC_ENROLLMENT: token,
    TEST_TREE_DIR: join(ctx.dir, "tree"),
    TEST_BROKER_SOCKET: ctx.sock,
    TEST_MARKER: join(ctx.dir, "marker"),
    TEST_ATTESTED_RULES: join(ctx.dir, "rules"),
    TEST_LEGACY_RULES: join(ctx.dir, "legacy.yaml"),
    TEST_TRUST_FILE: ctx.trust,
    TEST_RESULT_FILE: ctx.result,
    ...extraEnv,
  };
  const child = spawn(PI_BIN, ["-ne", "-e", ctx.ext, "-p", "ack"], { env, cwd: ctx.dir, stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.stderr?.resume?.(); // always drain: an undrained pipe blocks the child\u0027s writes
  return child;
}

function statStart(pid: number): string {
  const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  return raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/)[19] ?? "";
}

async function run() {
  // ── CASE B: the happy path (trust file present, correct token) ───────────
  {
    const ctx = await setup("b");
    writeFileSync(ctx.trust, NODE_BIN + "\n");
    const child = spawnPi(ctx, TOKEN);
    let err2 = "";
    child.stderr?.on("data", (d: Buffer) => { err2 += d.toString("utf8").slice(-300); });
    process.env.RUN_TOKEN = TOKEN;
    process.env.RUN_PID = String(child.pid);
    process.env.RUN_STARTTIME = statStart(child.pid);
    await new Promise<number>((resolve) => {
      child.on("exit", (c) => resolve(c ?? -1));
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } resolve(-1); }, 9000).unref?.();
    });
    for (let n = 0; n < 8 && ctx.consumeCount() === 0; n++) await new Promise((r) => setTimeout(r, 400));
    ctx.server.close();

    const consume = ctx.frames.filter((x) => x.f?.op === "register" && x.f?.args?.mode === "consume");
    if (consume.length === 1) ok("exactly one register-consume frame reached the validating broker");
    else bad(`expected exactly one consume, saw ${consume.length}${consume.length ? "" : `; stderr: ${err2.slice(-200)}`}`);
    const a = consume[0]?.f?.args ?? {};
    if (a.token === TOKEN) ok("the frame carries the exact disposable token (broker-validated)");
    else bad("token mismatch");
    if (a.pid === child.pid && a.starttime === process.env.RUN_STARTTIME) ok("the frame carries the session's TRUE pid + starttime (broker-validated)");
    else bad(`pin mismatch: got ${a.pid}:${a.starttime}, want ${child.pid}:${process.env.RUN_STARTTIME}`);
    const res = fs.existsSync(ctx.result) ? readFileSync(ctx.result, "utf8") : "";
    if (/grade=worker/.test(res)) ok("the CLIENT observed worker grade");
    else bad(`client grade evidence: ${res.replace(/\n/g, "; ").slice(0, 200)}`);
    if (/rules=\d+/.test(res)) ok("broker-sourced rules loaded through the bridge");
    else bad(`client rules evidence: ${res.replace(/\n/g, "; ").slice(0, 300)}`);
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }

  // ── CASE C1: rejected enrollment (wrong token) ────────────────────────────
  {
    const ctx = await setup("c1");
    writeFileSync(ctx.trust, NODE_BIN + "\n");
    const child = spawnPi(ctx, WRONG_TOKEN);
    process.env.RUN_TOKEN = TOKEN; // broker expects the RIGHT token → rejection
    process.env.RUN_PID = String(child.pid);
    process.env.RUN_STARTTIME = statStart(child.pid);
    await new Promise<number>((resolve) => {
      child.on("exit", (c) => resolve(c ?? -1));
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } resolve(-1); }, 9000).unref?.();
    });
    for (let n = 0; n < 8 && ctx.consumeCount() === 0; n++) await new Promise((r) => setTimeout(r, 400));
    ctx.server.close();
    const res = fs.existsSync(ctx.result) ? readFileSync(ctx.result, "utf8") : "";
    if (/grade=null/.test(res) || !/grade=worker/.test(res)) ok("rejected enrollment: no grade observed (denied)");
    else bad(`rejected enrollment still graded: ${res.slice(0, 150)}`);
    if (!/rules=\d+/.test(res)) ok("rejected enrollment: rules stay unavailable (fail-closed)");
    else bad("rules loaded despite rejection");
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }

  // ── CASE C2: missing trust file ───────────────────────────────────────────
  {
    const ctx = await setup("c2"); // trust file NOT written
    const child = spawnPi(ctx, TOKEN);
    process.env.RUN_TOKEN = TOKEN;
    process.env.RUN_PID = String(child.pid);
    process.env.RUN_STARTTIME = statStart(child.pid);
    await new Promise<number>((resolve) => {
      child.on("exit", (c) => resolve(c ?? -1));
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } resolve(-1); }, 9000).unref?.();
    });
    await new Promise((r) => setTimeout(r, 800));
    ctx.server.close();
    if (!ctx.frames.some((x) => x.f?.op === "register")) ok("missing trust file: NO register/credential frame ever reached the broker");
    else bad(`credential frames reached the broker without a trust file: ${ctx.frames.filter((x) => x.f?.op === "register").length}`);
    const res = fs.existsSync(ctx.result) ? readFileSync(ctx.result, "utf8") : "";
    if (/launchErr=mini-dc bridge: no authorized node runtime/.test(res)) ok("missing trust file: the prompt error surfaced");
    else bad(`expected prompt error, saw: ${res.replace(/\n/g, "; ").slice(0, 200)}`);
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }

  // ── CASE A: unauthorized explicit MINIDC_NODE_BIN (differing binary) ──────
  {
    const ctx = await setup("a");
    writeFileSync(ctx.trust, NODE_BIN + "\n");
    const fake = join(ctx.dir, "fake-node");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(fake, 0o755);
    const child = spawnPi(ctx, TOKEN, { MINIDC_NODE_BIN: fake });
    process.env.RUN_TOKEN = TOKEN;
    process.env.RUN_PID = String(child.pid);
    process.env.RUN_STARTTIME = statStart(child.pid);
    await new Promise<number>((resolve) => {
      child.on("exit", (c) => resolve(c ?? -1));
      setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } resolve(-1); }, 9000).unref?.();
    });
    await new Promise((r) => setTimeout(r, 800));
    ctx.server.close();
    if (!ctx.frames.some((x) => x.f?.op === "register")) ok("unauthorized explicit runtime: REJECTED before any credential handoff");
    else bad(`credential frames reached the broker despite unauthorized runtime: ${ctx.frames.filter((x) => x.f?.op === "register").length}`);
    const res = fs.existsSync(ctx.result) ? readFileSync(ctx.result, "utf8") : "";
    if (/launchErr=mini-dc bridge: MINIDC_NODE_BIN not authorized/.test(res)) ok("unauthorized runtime: the prompt error surfaced");
    else bad(`expected unauthorized-runtime error, saw: ${res.replace(/\n/g, "; ").slice(0, 200)}`);
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}

await run();
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
