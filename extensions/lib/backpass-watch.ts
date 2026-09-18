// lib/backpass-watch.ts — pure core of the backpass-watch statusline segment
// (zero pi-package imports; imported directly by tests/backpass-watch.test.ts).
//
// WHAT: charter-cadence tripwire for the R4 backpass apply loop. All date math
// is on plain ISO "YYYY-MM-DD" strings — UTC-midnight differences, calendar
// days, no timezones, no clock reads. `todayISO` is a PARAMETER (the render
// wrapper in statusline-encom.ts supplies the UTC calendar date), so tests are
// fully deterministic and no Date.now ever hides in here.
//
// SEMANTICS (backstopDays, default 14):
//   lastApplied null / malformed / not a real calendar date → unknown
//     (fail-open but VISIBLE — the footer shows ⚡bp:? instead of quietly
//     pretending there is plenty of time; a dead tripwire must look dead)
//   dueDate  = lastApplied + backstopDays   (calendar days, UTC midnights)
//   daysLeft = dueDate − today
//     daysLeft > 7 → silent     (> 1 week out — zero footer noise)
//     1..7        → countdown { daysLeft }
//     ≤ 0         → due { sinceISO: dueDate }   (backstop passed)
// Never throws: any bad input degrades to { kind: "unknown" }.
//
// REMINDER display only — nothing here runs backpass, writes state, or
// auto-applies anything (R4 charter art. 0.6 is non-negotiable).

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export type BackpassState =
  | { kind: "silent" }                        // > 7 days out
  | { kind: "countdown"; daysLeft: number }   // 1..7 days out
  | { kind: "due"; sinceISO: string }         // backstop passed (sinceISO = dueDate)
  | { kind: "unknown" };                      // file missing/invalid — fail-open, visible

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Strict "YYYY-MM-DD" → UTC-midnight epoch. Null unless the string is
 *  well-formed AND a real calendar date (overflow is rejected, not rolled
 *  over: "2026-02-30" and "2026-13-01" fail, "2026-9-8" fails the strict
 *  zero-padded shape). */
function isoToUTC(iso: string): number | null {
  if (!ISO_DATE_RE.test(iso)) return null;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return ms;
}

/** UTC-midnight epoch → "YYYY-MM-DD" (toISOString is always UTC — no local drift). */
function utcToISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse raw watch-state.json contents → the lastApplied string, or null when
 *  the JSON is malformed / not an object / lastApplied missing or not a string.
 *  Date VALIDATION is deliberately not done here (that is computeBackpassState's
 *  job) — a syntactically valid but non-date string flows through as-is and
 *  lands in `unknown` there. Pure; never throws. */
export function parseWatchState(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const v = parsed.lastApplied;
  return typeof v === "string" ? v : null;
}

/** Compute the footer state. Pure and total: every bad input → unknown. */
export function computeBackpassState(
  lastAppliedISO: string | null,
  todayISO: string,
  backstopDays = 14,
): BackpassState {
  if (lastAppliedISO === null) return { kind: "unknown" };
  // Degenerate backstop (0, negative, fractional) → no sane date math exists;
  // show unknown rather than fabricate a countdown (fail-open, visible).
  if (!Number.isInteger(backstopDays) || backstopDays <= 0) return { kind: "unknown" };
  const lastMs = isoToUTC(lastAppliedISO);
  const todayMs = isoToUTC(todayISO);
  if (lastMs === null || todayMs === null) return { kind: "unknown" };
  const dueMs = lastMs + backstopDays * DAY_MS;
  // Both operands are UTC midnights → the difference is an exact whole number
  // of days; Math.round only guards against any float representation noise.
  const daysLeft = Math.round((dueMs - todayMs) / DAY_MS);
  if (daysLeft > 7) return { kind: "silent" };
  if (daysLeft >= 1) return { kind: "countdown", daysLeft };
  return { kind: "due", sinceISO: utcToISO(dueMs) };
}
