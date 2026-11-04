// Unit tests for extensions/terminal-status-title.js (absorption round item C).
// Pure-function coverage: truncation, basename fallback, status→glyph mapping,
// and the composed title format. Driven through the TS runner like the rest
// of the suite.

import { basename, formatTitle, statusIndicator, truncateTitle } from "../terminal-status-title.js";
import terminalStatusTitle from "../terminal-status-title.js";

let passed = 0;
function assertEq(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const failures: string[] = [];

function run(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
  }
}

// ── truncateTitle ──
run("truncate: short title untouched", () => {
  assertEq(truncateTitle("short"), "short", "short");
});
run("truncate: long title gets ellipsis at 40", () => {
  const long = "a".repeat(60);
  const out = truncateTitle(long);
  assertEq(out.length, 40, "length");
  assertEq(out.endsWith("..."), true, "suffix");
});

// ── basename ──
run("basename: null → default π", () => {
  assertEq(basename(null), "π", "null");
});
run("basename: empty → default π", () => {
  assertEq(basename(""), "π", "empty");
});
run("basename: trailing slashes trimmed", () => {
  assertEq(basename("/home/vladi/projects/foo/"), "foo", "trailing");
});
run("basename: plain path", () => {
  assertEq(basename("/home/vladi"), "vladi", "plain");
});

// ── statusIndicator ──
run("indicator: working → spinner frame glyph", () => {
  assertEq(statusIndicator("working", 0), "⠋", "frame0");
  assertEq(statusIndicator("working", 3), "⠸", "frame3");
});
run("indicator: done → ✓", () => {
  assertEq(statusIndicator("done", 0), "✓", "done");
});
run("indicator: idle/unknown → ○", () => {
  assertEq(statusIndicator("idle", 0), "○", "idle");
  // "error" is no longer a statusIndicator state (dead branch removed — setStatus only ever
  // receives idle/working/done); unknown statuses fall through to the idle glyph.
  assertEq(statusIndicator("error", 0), "○", "error falls through to ○ (branch removed)");
});

// ── formatTitle ──
run("format: done + session name", () => {
  const pi = { getSessionName: () => "herdr round" };
  const ctx = { cwd: "/home/vladi" };
  assertEq(formatTitle(pi, ctx, "done", 0), "✓ | π | herdr round", "composed");
});
run("format: working + cwd basename fallback", () => {
  const pi = { getSessionName: () => "" };
  const ctx = { cwd: "/home/vladi/projects/foo" };
  assertEq(formatTitle(pi, ctx, "working", 0), "⠋ | π | foo", "fallback");
});
run("format: default title collapses duplicate π", () => {
  const pi = { getSessionName: () => "π" };
  const ctx = { cwd: "/nowhere" };
  assertEq(formatTitle(pi, ctx, "idle", 0), "○ | π", "collapse");
});

// ── stale-runtime writes (the captain's live-eyed find: deferred writes + spinner
// ticks can fire through a ctx replaced/reloaded between schedule and fire; the
// asserting getters throw — writeTitle must no-op, never crash) ──
//
// Drives the REAL default export with mock ctx objects whose getters mirror
// pi's assertActive contract (throw once marked stale). Real timers: the
// deferred write (0ms) and spinner ticks (120ms) must both survive a stale flip.
function makeCtx(onTitle: (t: string) => void): { ctx: object; stale: () => void; titles: () => string[] } {
  const titles: string[] = [];
  let stale = false;
  const ui = { setTitle: (t: string) => { if (stale) throw new Error("stale ui"); titles.push(t); } };
  const ctx = {
    cwd: "/home/vladi/projects/pi",
    get hasUI() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return true; },
    get ui() { if (stale) throw new Error("stale"); return ui; },
  };
  return { ctx, stale: () => { stale = true; }, titles: () => titles };
}

await (async () => {
  const handlers: Record<string, (e: unknown, ctx: object) => Promise<void> | void> = {};
  const pi = {
    on: (event: string, handler: (e: unknown, ctx: object) => Promise<void> | void) => { handlers[event] = handler; },
    getSessionName: () => "sess",
  };
  terminalStatusTitle(pi as never);
  const a = makeCtx(() => {});
  await handlers["session_start"]!(undefined, a.ctx);
  await handlers["agent_start"]!(undefined, a.ctx); // spinner running on ctx A
  const aTitlesBefore = a.titles().length;
  a.stale(); // session replaced between schedule and fire — A now throws on every getter
  await new Promise((r) => setTimeout(r, 300)); // deferred write (0ms) + spinner ticks (120ms) fire stale
  run("stale-ctx: deferred write + spinner ticks through a replaced ctx never crash", () => {
    assertEq(a.titles().length, aTitlesBefore, "no write landed through the stale ctx");
  });
  const b = makeCtx(() => {});
  await handlers["agent_settled"]!(undefined, b.ctx); // the replacement session's own event — fresh ctx B
  run("stale-ctx: the replacement session's fresh event re-titles normally", () => {
    assertEq(b.titles().length > 0, true, "fresh ctx written");
    assertEq(b.titles().at(-1)!.startsWith("✓ | π | sess"), true, "done glyph through fresh ctx");
  });
  await handlers["session_shutdown"]!(undefined, {} as object); // stop the spinner before exit
})();

if (failures.length > 0) {
  console.error(`terminal-status-title: ${failures.length}/${passed + failures.length} FAILED`);
  process.exit(1);
}
console.log(`terminal-status-title: ${passed} passed`);
