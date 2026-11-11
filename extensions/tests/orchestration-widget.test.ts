// Regression tests — dispatch progress-preview newline defect (2026-11-11).
//
// Defect: the orchestrator widget put the RAW task text into one returned row, so an
// embedded LF/CR/CRLF escaped the single terminal row the regular-mode renderer
// assumes; the next elapsed-time repaint desynced physical rows (duplicate progress
// headings). Fix: whitespace-normalize the DISPLAY preview before width truncation;
// params.task passed to resolveAndSpawn stays byte-for-byte.
//
// These tests exercise the PRODUCTION rendering path: the real extension module is
// imported, dispatch is registered through the real registerTool wiring, execute()
// runs end-to-end, and spawnSub's child is a PATH stub `pi` (simulated JSON progress
// events, exit 0) — NO real agent spawn and NO provider/API request anywhere.
// HOME is redirected to a temp dir for the test process so no live ~/.pi/agent state
// (personas, teams, sessions) is read or written.
//
// RUN: node --experimental-strip-types --test extensions/tests/orchestration-widget.test.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";

// ── isolated environment: temp HOME + stub `pi` on PATH ─────────────────────
// Must be installed BEFORE importing the extension (index.ts captures GLOBAL_TEAMS_PATH
// from homedir at module load).
const realTempDirs: string[] = [];
// Original env + global identities captured BEFORE any mutation, so teardown restores
// exactly what was there (an originally absent variable is deleted, not set undefined).
const originalEnv = { HOME: process.env.HOME, PATH: process.env.PATH, ORCH_TEST_ARGV_FILE: process.env.ORCH_TEST_ARGV_FILE, ORCH_TEST_DELAY_MS: process.env.ORCH_TEST_DELAY_MS };
const originalSetInterval = globalThis.setInterval; // unbound original identity
const trackedMkdtemp = (prefix: string): string => {
  const d = mkdtempSync(prefix);
  realTempDirs.push(d);
  return d;
};
const fakeHome = trackedMkdtemp(join(tmpdir(), "orch-widget-test-home-"));
mkdirSync(join(fakeHome, ".pi", "agent", "agents"), { recursive: true });
// Minimal stub persona for the auto-seat default (resolveFunctionalAgent → "keymaker") so
// resolveAndSpawn proceeds past loadPersona and actually spawns the PATH-stub child.
writeFileSync(
  join(fakeHome, ".pi", "agent", "agents", "keymaker.md"),
  "---\nname: keymaker\ndescription: test stub persona\ntools: read\n---\nTest stub persona for orchestration-widget regression tests.\n",
);
process.env.HOME = fakeHome;

const stubDir = trackedMkdtemp(join(tmpdir(), "orch-widget-test-stub-"));
let argvCounter = 0;
const stubPi = [
  "#!/bin/sh",
  '# Test stub — NEVER a real agent. Simulates JSON progress events, records argv (base64).',
  'if [ -n "$ORCH_TEST_ARGV_FILE" ]; then',
  '  for a in "$@"; do printf \'%s\\n\' "$(printf \'%s\' "$a" | base64)" >> "$ORCH_TEST_ARGV_FILE"; done',
  "fi",
  'if [ -n "$ORCH_TEST_DELAY_MS" ]; then sleep "$ORCH_TEST_DELAY_MS"; fi', // kept for manual debugging only; tests are deterministic (see in-flight test)
  'printf \'%s\\n\' \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"working"}}\'',
  'printf \'%s\\n\' \'{"type":"tool_execution_start"}\'',
  'printf \'%s\\n\' \'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":" done"}}\'',
  'printf \'%s\\n\' \'{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0},"totalTokens":2}}}\'',
  "exit 0",
].join("\n");
writeFileSync(join(stubDir, "pi"), stubPi);
chmodSync(join(stubDir, "pi"), 0o755);
process.env.PATH = `${stubDir}:${process.env.PATH ?? ""}`;

// ── production extension module, loaded under the isolated env ──────────────
type WidgetFactory = (tui: unknown, theme: unknown) => { render(width: number): string[]; invalidate(): void };
interface CapturedCtx {
  hasUI: boolean;
  cwd: string;
  modelRegistry: { find(p: string, id: string): { provider: string; id: string }; getAvailable(): Array<{ provider: string; id: string }> };
  ui: { setWidget(name: string, factory: WidgetFactory | undefined): void; notify(): void };
}
let dispatchExecute: ((id: unknown, params: { task: string; category?: string }, signal: unknown, onUpdate: unknown, ctx: CapturedCtx) => Promise<unknown>) | undefined;
let lastWidgetFactory: WidgetFactory | undefined;
let capturedCtx: CapturedCtx;
// One-shot latch: resolved by the fake ui.setWidget on the FIRST widget installation —
// deterministic in-flight observation, no timing/polling.
let firstWidgetInstalled: Promise<void> | undefined;
let resolveFirstWidget: (() => void) | undefined;

/** Fresh extension instance per call: index.ts keeps per-instance closure state (the subs
 *  map), and each test must start from an empty roster rather than accumulate prior subs. */
async function loadExtension(): Promise<void> {
  // Minimal structural fake of the ExtensionAPI surface index.ts uses at registration.
  interface FakePi {
    on(): void;
    registerCommand(): void;
    registerTool(tool: { name: string; execute: unknown }): void;
    appendEntry(type: string, data: unknown): void;
  }
  const pi: FakePi = {
    on() {},
    registerCommand() {},
    appendEntry() {},
    registerTool(tool) {
      if (tool.name === "dispatch") dispatchExecute = tool.execute as typeof dispatchExecute;
    },
  };
  const mod = await import("../orchestration-engine/index.ts");
  // Type-cast through unknown (never as any): the fake harness satisfies only the
  // registration surface index.ts exercises; the full ExtensionAPI is runtime-provided.
  mod.default(pi as unknown as Parameters<typeof mod.default>[0]);
}

function ensureCtx(): CapturedCtx {
  if (!capturedCtx) {
    capturedCtx = {
      hasUI: true,
      cwd: trackedMkdtemp(join(tmpdir(), "orch-widget-test-cwd-")),
      // Every tier model "exists": no downshift walk, stub child is spawned for the tier primary.
      modelRegistry: {
        find(p: string, id: string) { return { provider: p, id }; },
        getAvailable() { return [{ provider: "zai-coding-cn", id: "glm-5.3-flash" }]; },
      },
      ui: {
        setWidget(_name: string, factory: WidgetFactory | undefined) {
          lastWidgetFactory = factory;
          if (factory && resolveFirstWidget) { const r = resolveFirstWidget; resolveFirstWidget = undefined; r(); }
        },
        notify() {},
      },
    };
  }
  return capturedCtx;
}

/** Drive the production render path: run a real dispatch execute() against the stub child,
 *  then render the captured widget factory (the exact rows setWidget hands the TUI). */
async function dispatchAndRender(task: string, width: number, category = "quick"): Promise<string[]> {
  await loadExtension(); // fresh instance ⇒ empty subs roster for this dispatch
  const ctx = await ensureCtx();
  const file = join(fakeHome, `argv-${++argvCounter}.b64`);
  const intervalSnapshot = new Set(liveIntervals);
  process.env.ORCH_TEST_ARGV_FILE = file;
  try {
    return await (async () => {
      await dispatchExecute!("test-id", { task, category }, undefined, undefined, ctx);
      assert.ok(lastWidgetFactory, "render() must install the orchestrator widget");
      const widget = lastWidgetFactory!({}, { fg: (_t: string, s: string) => s });
      return widget.render(width);
    })();
  } finally {
    delete process.env.ORCH_TEST_ARGV_FILE;
    clearIntervalsCreatedSince(intervalSnapshot); // honest teardown even on failure
  }
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── scoped interval teardown (harness-side, honest) ─────────────────────────
// startTick() creates a 1s render interval inside the extension closure; if execute()
// throws unexpectedly the tick would leak and keep the test process alive. Track every
// setInterval the extension creates and clear the new ones in each dispatch's finally.
const liveIntervals = new Set<ReturnType<typeof setInterval>>();
const boundSetInterval = originalSetInterval.bind(globalThis);
globalThis.setInterval = ((fn: () => void, ms?: number, ...args: unknown[]) => {
  const t = boundSetInterval(fn as () => void, ms, ...args as []);
  liveIntervals.add(t);
  return t;
}) as typeof setInterval;
function clearIntervalsCreatedSince(snapshot: Set<ReturnType<typeof setInterval>>): void {
  for (const t of [...liveIntervals]) {
    if (!snapshot.has(t)) {
      clearInterval(t);
      liveIntervals.delete(t);
    }
  }
}

test("embedded LF in task cannot escape a single returned preview row", async () => {
  const rows = await dispatchAndRender("line one\nline two\nline three", 120);
  assert.equal(rows.length, 2, "one sub ⇒ exactly one heading row + one preview row");
  for (const row of rows) {
    assert.ok(!row.includes("\n"), "row must not contain LF");
    assert.ok(!row.includes("\r"), "row must not contain CR");
  }
});

test("embedded CR in task cannot escape a single returned preview row", async () => {
  const rows = await dispatchAndRender("carriage\rreturned task", 120);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(!row.includes("\r"), "row must not contain CR");
    assert.ok(!row.includes("\n"), "row must not contain LF");
  }
});

test("embedded CRLF in task cannot escape a single returned preview row", async () => {
  const rows = await dispatchAndRender("windows\r\nline\r\nending", 120);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(!row.includes("\r") && !row.includes("\n"), "row must be newline-free");
  }
});

test("preview whitespace is normalized (runs of whitespace collapse to one space)", async () => {
  const rows = await dispatchAndRender("tabs\tand    spaces   collapse", 200);
  assert.equal(rows.length, 2);
  const visible = stripAnsi(rows[1]).replace(/^ {2}/, ""); // skip the widget's 2-space indent
  assert.ok(!/\t/.test(visible), "no tabs in preview");
  assert.ok(!/ {2,}/.test(visible), "no repeated spaces in preview");
});

test("narrow width: every returned row fits the terminal width", async () => {
  const rows = await dispatchAndRender("a long multiline\ntask for narrow\nterminals", 40);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(!row.includes("\n") && !row.includes("\r"));
    assert.ok(stripAnsi(row).length <= 40, `row exceeds width 40: ${JSON.stringify(stripAnsi(row))}`);
    // Idempotent truncation ⇒ the row already fits (a second truncate is a no-op).
    assert.equal(truncateToWidth(row, 40), row);
  }
});

test("wide width: embedded newlines still cannot escape a single row", async () => {
  const rows = await dispatchAndRender("first\nsecond\nthird\nfourth\nfifth line of a wide dispatch", 360);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.ok(!row.includes("\n") && !row.includes("\r"));
});

test("original task bytes reach the agent child byte-for-byte", async () => {
  const original = "byte-for-byte\r\ncheck\t task ✓";
  await dispatchAndRender(original, 120);
  const file = join(fakeHome, `argv-${argvCounter}.b64`);
  assert.ok(readFileSync(file, "utf-8").length > 0, "stub child recorded argv");
  const argv = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => Buffer.from(l, "base64").toString("utf-8"));
  assert.ok(argv.includes(original), `original task must reach the stub child byte-for-byte; argv was: ${JSON.stringify(argv)}`);
  // The task is the LAST argument (spawnSub pushes it last) and survives intact there too.
  assert.equal(argv[argv.length - 1], original);
});

test("in-flight progress render stays a single newline-free row (simulated child progress)", async () => {
  // Deterministic in-flight snapshot: start execute WITHOUT awaiting; the one-shot latch
  // resolves when the fake ui.setWidget receives the FIRST widget installation (which the
  // extension performs as soon as the sub is registered, before the stub child completes).
  // Assert the mid-flight rows, then always settle the dispatch. No sleep, no polling, no
  // real agent spawn / provider request.
  await loadExtension();
  const ctx = ensureCtx();
  const intervalSnapshot = new Set(liveIntervals);
  lastWidgetFactory = undefined; // only this dispatch's render may install the factory
  firstWidgetInstalled = new Promise<void>((r) => { resolveFirstWidget = r; });
  process.env.ORCH_TEST_ARGV_FILE = join(fakeHome, `argv-${++argvCounter}.b64`);
  let pending: Promise<unknown> | undefined;
  try {
    pending = dispatchExecute!("test-id", { task: "in-flight\nmultiline progress", category: "quick" }, undefined, undefined, ctx);
    await firstWidgetInstalled; // resolved by ui.setWidget on first install — no timing race
    assert.ok(lastWidgetFactory, "widget must render while the sub is in flight");
    const widget = lastWidgetFactory!({}, { fg: (_t: string, s: string) => s });
    const mid = widget.render(120);
    assert.equal(mid.length, 2, "in-flight roster ⇒ 2 rows");
    for (const row of mid) {
      assert.ok(!row.includes("\n") && !row.includes("\r"), "in-flight row must be newline-free");
    }
    assert.ok(stripAnsi(mid[0]).includes("●"), "in-flight sub must show the running icon");
  } finally {
    delete process.env.ORCH_TEST_ARGV_FILE;
    clearIntervalsCreatedSince(intervalSnapshot);
    if (pending) await pending; // always settle the dispatch, even after a failed assertion
  }
});

// Post-completion re-render only: the redraw test below repaints the SAME captured widget
// after the dispatch finished (simulated elapsed-time repaints of a settled roster), not a
// live streaming delta. In-flight rendering is covered by the dedicated test above.
test("repeated progress redraws stay structurally stable (no row-count growth)", async () => {
  const rows = await dispatchAndRender("stable redraw\nmultiline task", 120);
  assert.equal(rows.length, 2);
  // Re-render through the same captured widget several times (simulated elapsed-time
  // repaints): the row set must stay 2 rows, newline-free, and prefix-stable.
  const widget = lastWidgetFactory!({}, { fg: (_t: string, s: string) => s });
  const headingPrefix = stripAnsi(rows[0]).split("·")[0];
  for (let i = 0; i < 5; i++) {
    const again = widget.render(120);
    assert.equal(again.length, 2, `redraw ${i}: row count must stay 2`);
    for (const row of again) assert.ok(!row.includes("\n") && !row.includes("\r"));
    assert.equal(stripAnsi(again[0]).split("·")[0], headingPrefix, `redraw ${i}: heading identity must persist`);
  }
});

// Honest teardown (NOT a behavior test): restore globals and env even when a test failed,
// clear any tracked interval, and remove every temp dir created by the fixture.
after(() => {
  for (const t of [...liveIntervals]) { clearInterval(t); liveIntervals.delete(t); }
  globalThis.setInterval = originalSetInterval; // exact original identity
  if (originalEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = originalEnv.HOME;
  if (originalEnv.PATH === undefined) delete process.env.PATH; else process.env.PATH = originalEnv.PATH;
  for (const k of ["ORCH_TEST_ARGV_FILE", "ORCH_TEST_DELAY_MS"] as const) {
    if (originalEnv[k] === undefined) delete process.env[k]; else process.env[k] = originalEnv[k];
  }
  for (const d of realTempDirs) rmSync(d, { recursive: true, force: true });
});
