#!/usr/bin/env -S node --experimental-strip-types
// broker/minidc-canary.ts — the R2 activation-gate canary CLI (spec §2.3 / R6).
//
// The paired live canary each desk must pass BEFORE leaving legacy mode. It runs
// through the INSTALLED production broker (its socket), never a test seam, and
// changes nothing desk-global: the legacy-fallback disable is a PER-INVOCATION
// flag. Two phases, one operator session:
//
//   pre-cert:  submit a harmless claim and REQUIRE the broker to deny it
//              SPECIFICALLY because the generation is uncertified (any other
//              outcome — authorization, unreachable broker, a different denial —
//              fails the phase). Run BEFORE `minidc-brokerctl certify`.
//
//   post-cert: submit a FRESH equivalent claim, require broker-issued
//              authorization and a committed append, then read the committed
//              entry back by parsing the append-trail FILE directly (never the
//              broker API), match the claim ID, generation, and authenticated
//              presenter tuple, and print the ONE-LINE operator receipt:
//
//   canary-receipt claim=<id> generation=<id> presenter=<pid>:<starttime>@<uid> entry=<sha256-16> slug=<slug>
//
// Legacy-fallback law: when the broker socket is absent/refused, the canary
// observes the desk's legacy posture WITHOUT writing anything (exit 3, soft
// inconclusive) — unless --no-legacy-fallback is set, which turns the same
// observation into a hard failure (exit 1). The flag is per-invocation only;
// ordinary sessions stay in legacy mode until the desk's activation decision.
//
// usage: minidc-canary --phase pre-cert|post-cert --backend <B> --slug <S>
//                      --socket <PATH> [--trail <FILE>] [--no-legacy-fallback]
//        (post-cert requires --trail, the installed broker-mode trail file)

import * as net from "node:net";
import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";

interface Args {
  phase: "pre-cert" | "post-cert";
  backend: string;
  slug: string;
  socket: string;
  trail: string | null;
  noLegacyFallback: boolean;
}

function usage(): never {
  console.error(`usage: minidc-canary --phase pre-cert|post-cert --backend <B> --slug <S> --socket <PATH> [--trail <FILE>] [--no-legacy-fallback]`);
  process.exit(2);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const arg = (n: string): string | null => {
    const i = argv.indexOf(n);
    return i >= 0 && i + 1 < argv.length ? (argv[i + 1] as string) : null;
  };
  const phase = arg("--phase");
  const backend = arg("--backend");
  const slug = arg("--slug");
  const socket = arg("--socket");
  const trail = arg("--trail");
  if (phase !== "pre-cert" && phase !== "post-cert") usage();
  if (!backend || !slug || !socket) usage();
  if (phase === "post-cert" && !trail) usage();
  return { phase, backend, slug, socket, trail, noLegacyFallback: argv.includes("--no-legacy-fallback") };
}

interface Frame { id: number; op: string; args: Record<string, unknown>; }
type Res = { id: number; ok: true; result: Record<string, unknown> } | { id: number; ok: false; error: string; reason?: string };

function call(path: string, frame: Frame, timeoutMs = 8000): Promise<Res> {
  return new Promise((resolve, reject) => {
    const s = net.connect(path, () => {
      s.write(`${JSON.stringify(frame)}\n`);
    });
    let buf = "";
    const timer = setTimeout(() => { s.destroy(); reject(new Error("canary: broker response timeout")); }, timeoutMs);
    s.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i >= 0) {
        clearTimeout(timer);
        s.destroy();
        try {
          resolve(JSON.parse(buf.slice(0, i)) as Res);
        } catch {
          reject(new Error("canary: malformed broker frame"));
        }
      }
    });
    s.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
  });
}

function statStarttime(pid: number): string {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
  return fields[19] as string;
}

/** The soft legacy observation: report and exit 3, or hard-fail under the flag. */
function legacyObserved(a: Args, why: string): never {
  if (a.noLegacyFallback) {
    console.error(`canary: FAIL — broker unavailable (${why}) with legacy fallback disabled`);
    process.exit(1);
  }
  console.log(`canary: legacy-fallback observed (${why}) — inconclusive, nothing written`);
  process.exit(3);
}

async function openClaim(a: Args): Promise<Res> {
  try {
    return await call(a.socket, { id: 1, op: "open-claim", args: { backend: a.backend, slug: a.slug } });
  } catch (e) {
    const msg = (e as Error).message;
    legacyObserved(a, msg);
  }
}

function harmlessEntry(slug: string): Record<string, unknown> {
  return {
    v: 1,
    ts: new Date().toISOString(),
    actor: "worker", // ignored on the presenter path — server stamps "backend"
    pane: null,
    task: `canary:${slug}`,
    subject: randomBytes(8).toString("hex"),
    cls: "G",
    decision: "proceed",
    scope: "once",
    message: "r2 activation canary",
  };
}

async function preCert(a: Args): Promise<number> {
  const r = await openClaim(a);
  if (r.ok === true) {
    console.error("canary: FAIL — claim AUTHORIZED before certification (fail-closed law violated)");
    return 1;
  }
  if (r.error !== "E_DENIED_TOPOLOGY" || r.reason !== "uncertified-generation") {
    console.error(`canary: FAIL — denial was not the required uncertified-generation verdict (got ${r.error}${r.reason ? `/${r.reason}` : ""})`);
    return 1;
  }
  console.log(`canary: pre-cert OK — harmless claim denied specifically because the generation is uncertified (backend=${a.backend})`);
  return 0;
}

interface TrailRow {
  v: number; ts: string; actor: string;
  claim?: string; generation?: string;
  presenter?: { pid: number; starttime: string; uid: number; "exe-digest": string };
  delegated?: boolean;
  subject?: string;
  [k: string]: unknown;
}

async function postCert(a: Args): Promise<number> {
  const trailFile = a.trail as string;
  // phase 1 — fresh equivalent claim, broker-issued authorization required
  const claim = await openClaim(a);
  if (claim.ok !== true) {
    console.error(`canary: FAIL — claim denied after certification (${claim.error}${claim.reason ? `/${claim.reason}` : ""})`);
    return 1;
  }
  const result = claim.result;
  const claimId = result["claim-id"] as string;
  const generation = (result["generation"] as { "generation-id": string })["generation-id"];
  const presenter = result["presenter"] as { pid: number; starttime: string; uid: number };
  // the presenter tuple must be THIS canary process — kernel-identified (R4)
  if (presenter.pid !== process.pid || presenter.starttime !== statStarttime(process.pid)) {
    console.error(`canary: FAIL — broker-issued presenter does not match this process (got ${presenter.pid}:${presenter.starttime}, am ${process.pid})`);
    return 1;
  }
  // phase 2 — the committed append
  const append = await call(a.socket, {
    id: 2, op: "append-trail",
    args: { slug: a.slug, entry: harmlessEntry(a.slug), "claim-id": claimId },
  });
  if (append.ok !== true) {
    console.error(`canary: FAIL — append denied (${append.error}${append.reason ? `/${append.reason}` : ""})`);
    return 1;
  }
  // phase 3 — INDEPENDENT read-back: parse the trail FILE directly, never the API
  let rows: TrailRow[];
  try {
    const raw = fs.readFileSync(trailFile, "utf8");
    rows = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as TrailRow);
  } catch (e) {
    console.error(`canary: FAIL — trail file unreadable: ${trailFile} (${(e as Error).message})`);
    return 1;
  }
  const committed = rows.filter((r) => r.claim === claimId);
  if (committed.length !== 1) {
    console.error(`canary: FAIL — expected exactly 1 committed entry for claim ${claimId}, found ${committed.length}`);
    return 1;
  }
  const row = committed[0] as TrailRow;
  if (row.generation !== generation) {
    console.error(`canary: FAIL — entry generation mismatch (entry ${String(row.generation)} vs claim ${generation})`);
    return 1;
  }
  const rp = row.presenter;
  if (!rp || rp.pid !== presenter.pid || rp.starttime !== presenter.starttime || rp.uid !== presenter.uid) {
    console.error("canary: FAIL — entry presenter tuple mismatch");
    return 1;
  }
  // the receipt: entry hash over the entry's serialized JSON object (stable field
  // order: the file line itself; hash the LINE bytes for exact file evidence)
  const line = fs.readFileSync(trailFile, "utf8").split("\n").find((l) => l.includes(`"claim":"${claimId}"`)) ?? "";
  const entryHash = createHash("sha256").update(line).digest("hex").slice(0, 16);
  console.log(`canary-receipt claim=${claimId} generation=${generation} presenter=${presenter.pid}:${presenter.starttime}@${presenter.uid} entry=${entryHash} slug=${a.slug}`);
  return 0;
}

async function main(): Promise<number> {
  const a = parseArgs();
  return a.phase === "pre-cert" ? preCert(a) : postCert(a);
}

main().then((code) => process.exit(code)).catch((e: unknown) => {
  console.error(`canary: ${(e as Error).message}`);
  process.exit(1);
});
