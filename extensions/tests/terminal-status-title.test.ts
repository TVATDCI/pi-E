// Unit tests for extensions/terminal-status-title.js (absorption round item C).
// Pure-function coverage: truncation, basename fallback, status→glyph mapping,
// and the composed title format. Driven through the TS runner like the rest
// of the suite.

import { basename, formatTitle, statusIndicator, truncateTitle } from "../terminal-status-title.js";

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
run("indicator: error → ✗", () => {
  assertEq(statusIndicator("error", 0), "✗", "error");
});
run("indicator: idle/unknown → ○", () => {
  assertEq(statusIndicator("idle", 0), "○", "idle");
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

if (failures.length > 0) {
  console.error(`terminal-status-title: ${failures.length}/${passed + failures.length} FAILED`);
  process.exit(1);
}
console.log(`terminal-status-title: ${passed} passed`);
