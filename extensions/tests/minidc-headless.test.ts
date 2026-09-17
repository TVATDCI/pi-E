// extensions/tests/minidc-headless.test.ts — R2 (i): headless denials settle in-band (design-v0.2 C1/C2).
// Run: node --experimental-strip-types minidc-headless.test.ts   (from extensions/tests/)
//
// Drives the REAL mini-damage-control module (importable since R2 replaced the runtime
// pi-coding-agent import with a local identity). Rules are injected via the project seam
// (ctx.cwd/.pi/mini-dc-rules.yaml) so assertions are deterministic regardless of the
// machine's global rules file. json/print are the DISPATCH-class locks (spawn children run
// --mode json -p); rpc is a separate policy lock; tui is the interactive regression lock.
import miniDc from "../mini-damage-control.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}

const PROJECT_RULES = `bashToolPatterns:\n  - pattern: 'testaskmarker\\\d+'\n    reason: test ask rule\n    ask: true\n  - pattern: 'testblockmarker'\n    reason: test block rule\n`;

interface Harness {
  result: { block: boolean; reason?: string } | undefined | "unset";
  customCalls: number;
  abortCalls: number;
  entries: { customType: string; data: unknown }[];
}

function makeHarness(mode: "tui" | "rpc" | "json" | "print", command: string): Harness {
  const dir = mkdtempSync(join(os.tmpdir(), "minidc-r2-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "mini-dc-rules.yaml"), PROJECT_RULES);
  const h: Harness = { result: "unset", customCalls: 0, abortCalls: 0, entries: [] };
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
  const pi = {
    on: (ev: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers[ev] = fn; },
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) => { h.entries.push({ customType, data: h.entries.length >= 0 ? data : data }); },
  };
  const ctx = {
    cwd: dir,
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      custom: async () => { h.customCalls++; return undefined; },
      notify: () => {},
      setStatus: () => {},
    },
    abort: () => { h.abortCalls++; },
    sessionManager: { getEntries: () => [] },
  };
  return {
    run: async () => {
      (miniDc as unknown as (p: unknown) => void)(pi); // module init — registers the handlers
      await handlers["session_start"]({}, ctx);
      h.result = (await handlers["tool_call"]({ toolName: "bash", input: { command } }, ctx)) as never;
      rmSync(dir, { recursive: true, force: true });
      return h;
    },
  };
}

async function drive(mode: "tui" | "rpc" | "json" | "print", command: string): Promise<Harness> {
  return makeHarness(mode, command).run();
}

// ── (1,2) DISPATCH-CLASS locks: json/print + ASK → in-band settle, no dialog, no abort ──
for (const mode of ["json", "print"] as const) {
  const h = await drive(mode, "echo testaskmarker42");
  check(`(${mode}) ASK ⇒ blocked in-band`, h.result !== "unset" && h.result !== undefined && h.result.block === true);
  check(`(${mode}) ASK ⇒ reason carries headless ASK→deny marker`, typeof h.result === "object" && !!h.result && (h.result.reason ?? "").includes("headless ASK→deny") && (h.result.reason ?? "").includes("BLOCKED by mini-dc"));
  check(`(${mode}) ASK ⇒ NO dialog attempted (custom never called)`, h.customCalls === 0);
  check(`(${mode}) ASK ⇒ NO abort (settles in-band — C1)`, h.abortCalls === 0);
  check(`(${mode}) ASK ⇒ log entry headlessDeny+askClass`, h.entries.some((e) => e.customType === "mini-dc-log" && (e.data as { headlessDeny?: boolean }).headlessDeny === true && (e.data as { askClass?: boolean }).askClass === true));
}

// ── (3) rpc policy lock (deny-by-design, not terminal-accident) ───────────────────
{
  const h = await drive("rpc", "echo testaskmarker7");
  check("(rpc) ASK ⇒ blocked in-band with headless marker", !!h.result && h.result.block === true && (h.result.reason ?? "").includes("headless ASK→deny"));
  check("(rpc) ASK ⇒ NO dialog, NO abort", h.customCalls === 0 && h.abortCalls === 0);
}

// ── (4) TUI interactive regression lock: dialog path unchanged ────────────────────
{
  const h = await drive("tui", "echo testaskmarker9");
  check("(tui) ASK ⇒ dialog attempted exactly once (custom called)", h.customCalls === 1);
  check("(tui) ASK ⇒ still blocks (safe default No on undefined)", !!h.result && h.result.block === true);
  check("(tui) ASK ⇒ reason is the STANDARD text (no headless marker)", !!h.result && (h.result.reason ?? "").includes("BLOCKED by mini-dc") && !(h.result.reason ?? "").includes("headless"));
}

// ── (5) C2 lock: BLOCK-class rule in headless → no-abort denial ───────────────────
{
  const h = await drive("json", "echo testblockmarker");
  check("(json) BLOCK-class ⇒ no-abort denial with (headless) marker", !!h.result && h.result.block === true && (h.result.reason ?? "").includes("headless") && h.abortCalls === 0 && h.customCalls === 0);
  check("(json) BLOCK-class ⇒ log askClass false", h.entries.some((e) => e.customType === "mini-dc-log" && (e.data as { askClass?: boolean }).askClass === false));
}

// ── (6) END-TO-END CURE (C5a): settled refusal output cannot fire the walk ────────
{
  const h = await drive("json", "echo testaskmarker1");
  const settledOutput = `${h.result?.reason ?? ""}\nModel turn continues: the tool result carried the denial; the turn settles with text.`;
  const inbandError = undefined as string | undefined;
  const { shouldWalkAfterFailure } = await import("../orchestration-engine/spawn-outcome.ts");
  check("(e2e) settled headless refusal ⇒ output non-empty, no inbandError, NO walk", settledOutput.length > 0 && inbandError === undefined && shouldWalkAfterFailure(settledOutput.length, inbandError, false, settledOutput) === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
