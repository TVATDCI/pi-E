// extensions/tests/backpass-watch.test.ts — invariant tests for the pure core
// of the backpass-watch statusline segment (lib/backpass-watch.ts).
//
// All date math is deterministic: `todayISO` is a fixed parameter, never a
// clock read (the lib itself contains no Date.now). Covers every boundary the
// brief names: silent (8d, boundary), countdown (7d/1d boundaries), due
// (day 0, day −3), unknown (null / garbage / malformed shapes), the backstopDays
// override, and parse-level reading of watch-state.json via parseWatchState.
//
// Standalone (node:test) — imports ONLY the zero-pi-package lib, so it runs
// without @earendil-works/* resolvable:
//
//   node --experimental-strip-types --test extensions/tests/backpass-watch.test.ts
//
// Lives in extensions/tests/ (NOT top-level) so pi's extension loader skips it
// (ADR-0011: only top-level *.ts and subdir index.ts are auto-imported).

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBackpassState, parseWatchState } from "../lib/backpass-watch.ts";

// Fixed "today" — deterministic by construction (tests never touch the clock).
const TODAY = "2026-09-18";
const DAY_MS = 86_400_000;

/** ISO date shifted by whole days (UTC midnights, mirroring the lib's math). */
const shift = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// With the default backstop of 14: lastApplied + 14 = dueDate.
const applied = (daysAgo: number): string => shift(TODAY, -daysAgo);

test("silent: > 7 days out hides the segment (8d boundary and beyond)", () => {
  // lastApplied 6d ago → due 8d OUT → daysLeft = +8 → silent (boundary: NOT countdown)
  assert.deepEqual(computeBackpassState(applied(6), TODAY), { kind: "silent" });
  // comfortably out: applied today → due 14d ahead
  assert.deepEqual(computeBackpassState(applied(0), TODAY), { kind: "silent" });
});

test("countdown: 7d boundary starts the countdown, exact daysLeft reported", () => {
  // lastApplied 7d ago → due 7d out → daysLeft = 7 (boundary: countdown, not silent)
  assert.deepEqual(computeBackpassState(applied(7), TODAY), { kind: "countdown", daysLeft: 7 });
  // mid-range
  assert.deepEqual(computeBackpassState(applied(10), TODAY), { kind: "countdown", daysLeft: 4 });
  // 1d boundary (last possible countdown day)
  assert.deepEqual(computeBackpassState(applied(13), TODAY), { kind: "countdown", daysLeft: 1 });
});

test("due: day 0 and day −3, with sinceISO = the computed dueDate", () => {
  // day 0: lastApplied exactly 14d ago → dueDate IS today → daysLeft = 0 → due
  assert.deepEqual(computeBackpassState(applied(14), TODAY), { kind: "due", sinceISO: TODAY });
  // day −3: backstop passed 3 days ago
  assert.deepEqual(computeBackpassState(applied(17), TODAY), { kind: "due", sinceISO: shift(TODAY, -3) });
  // far overdue still reports the true dueDate
  assert.deepEqual(computeBackpassState(applied(40), TODAY), { kind: "due", sinceISO: shift(TODAY, -26) });
});

test("unknown: null lastApplied (no watch state ever recorded)", () => {
  assert.deepEqual(computeBackpassState(null, TODAY), { kind: "unknown" });
});

test("unknown: garbage / malformed date strings never throw, always degrade", () => {
  const bad: string[] = [
    "not-a-date",        // garbage string
    "",                  // empty
    "2026-9-8",          // not zero-padded (strict shape)
    "2026-02-30",        // calendar overflow — rejected, not rolled to March
    "2026-13-01",        // month 13
    "2026-00-10",        // month 0
    "26-09-18",          // 2-digit year
    "2026/09/18",        // wrong separator
    "2026-09-18T00:00:00Z", // full timestamp, not a plain date
  ];
  for (const last of bad) {
    assert.deepEqual(computeBackpassState(last, TODAY), { kind: "unknown" }, `expected unknown for '${last}'`);
  }
  // a garbage `today` is also unknown — never a fabricated verdict
  assert.deepEqual(computeBackpassState(applied(10), "not-a-date"), { kind: "unknown" });
});

test("backstopDays override shifts every boundary with it", () => {
  // 3d stale, backstop 7 → dueDate 4d out → countdown 4 (same input, default 14 → silent)
  assert.deepEqual(computeBackpassState(applied(3), TODAY, 7), { kind: "countdown", daysLeft: 4 });
  assert.deepEqual(computeBackpassState(applied(3), TODAY), { kind: "silent" });
  // exactly 7d stale, backstop 7 → day 0 → due
  assert.deepEqual(computeBackpassState(applied(7), TODAY, 7), { kind: "due", sinceISO: TODAY });
  // wider backstop 30: 10d stale → dueDate 20d out → silent
  assert.deepEqual(computeBackpassState(applied(10), TODAY, 30), { kind: "silent" });
  // degenerate backstops → unknown (no sane math; fail-open, visible)
  assert.deepEqual(computeBackpassState(applied(10), TODAY, 0), { kind: "unknown" });
  assert.deepEqual(computeBackpassState(applied(10), TODAY, -14), { kind: "unknown" });
  assert.deepEqual(computeBackpassState(applied(10), TODAY, 2.5), { kind: "unknown" });
});

test("parseWatchState: valid payloads return the lastApplied string", () => {
  assert.equal(parseWatchState('{"lastApplied": "2026-09-18"}'), "2026-09-18");
  // pretty-printed / whitespace tolerated; extra keys ignored (tolerant read)
  assert.equal(parseWatchState('{\n  "lastApplied": "2026-09-18",\n  "note": "x"\n}\n'), "2026-09-18");
});

test("parseWatchState: malformed JSON / wrong shapes → null", () => {
  assert.equal(parseWatchState("{oops"), null);            // not JSON
  assert.equal(parseWatchState(""), null);                 // empty file
  assert.equal(parseWatchState("{}"), null);               // key missing
  assert.equal(parseWatchState('{"other": "x"}'), null);   // wrong key
  assert.equal(parseWatchState('{"lastApplied": 42}'), null);    // not a string
  assert.equal(parseWatchState('{"lastApplied": null}'), null); // null, not string
  assert.equal(parseWatchState('{"lastApplied": ["2026-09-18"]}'), null); // array
  assert.equal(parseWatchState("[1,2]"), null);            // top-level array
  assert.equal(parseWatchState('"2026-09-18"'), null);     // top-level string
  assert.equal(parseWatchState("42"), null);               // top-level number
});

test("integration: parse → compute chain maps each parse failure to unknown", () => {
  // the exact shapes the render wrapper feeds through: raw file text → parse → compute
  assert.deepEqual(computeBackpassState(parseWatchState('{"lastApplied": "2026-09-02"}'), TODAY), {
    kind: "due",
    sinceISO: "2026-09-16",
  });
  assert.deepEqual(computeBackpassState(parseWatchState('{"lastApplied": 7}'), TODAY), { kind: "unknown" });
  assert.deepEqual(computeBackpassState(parseWatchState("}bad{"), TODAY), { kind: "unknown" });
  // garbage STRING (parses fine as JSON, fails date validation downstream)
  assert.deepEqual(computeBackpassState(parseWatchState('{"lastApplied": "yesterday"}'), TODAY), { kind: "unknown" });
});
