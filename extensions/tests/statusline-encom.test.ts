// Unit tests for statusline-encom.ts pure helpers (Strategy C, Phase 5).
//
// These cover the dependency-free logic: git-porcelain parsing, the solid-mode
// line fitter, token/duration formatting, settings merge, layout resolution,
// and the separator glyph map. The stateful render path (setFooter factory,
// event handlers) is intentionally NOT unit-tested here — it needs the live pi
// runtime; the pure helpers are where regressions are most likely and cheapest
// to catch.
//
// RUN (needs @earendil-works/pi-{coding-agent,tui,ai} resolvable, same as
// type-checking the extension — create local node_modules symlinks or run from
// a dir that has them):
//
//   node --experimental-strip-types --test extensions/tests/statusline-encom.test.ts
//
// This file lives in extensions/tests/ (NOT top-level) so pi's extension loader
// skips it: the loader only takes direct *.ts files and subdirs with an
// index.ts/index.js/package.json "pi" manifest — a bare tests/ dir is ignored.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitPorcelain,
  fitLines,
  humanizeTokens,
  humanizeDuration,
  mergeSettings,
  resolveLayout,
  PRESETS,
  SEP_GLYPHS,
  separatorFor,
  computeBridgeBadge,
} from "../statusline-encom.ts";

test("parseGitPorcelain: counts staged/unstaged/untracked from XY porcelain", () => {
  assert.deepEqual(parseGitPorcelain(""), { staged: 0, unstaged: 0, untracked: 0 });
  assert.deepEqual(parseGitPorcelain("?? newfile"), { staged: 0, unstaged: 0, untracked: 1 });
  // "M  a" = staged-modified (X=M, Y=space); " M b" = unstaged-modified (X=space, Y=M)
  assert.deepEqual(parseGitPorcelain("M  a\n M b"), { staged: 1, unstaged: 1, untracked: 0 });
  assert.deepEqual(parseGitPorcelain("A  staged\n M unstaged\n?? untracked"), { staged: 1, unstaged: 1, untracked: 1 });
  // a path both staged AND unstaged counts in both buckets
  assert.deepEqual(parseGitPorcelain("MM both"), { staged: 1, unstaged: 1, untracked: 0 });
  // blank lines ignored; "??" only ever untracked
  assert.deepEqual(parseGitPorcelain("\n\n?? x\n"), { staged: 0, unstaged: 0, untracked: 1 });
});

test("fitLines: greedy pack, overflow to line 2, respects maxLines", () => {
  const w = (n: number) => n;
  // items [3,3,3], gap 1, width 7 → 3+1+3=7 fits two; third spills to line 2
  const lines = fitLines([3, 3, 3], w, 1, 7);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0], [3, 3]);
  assert.deepEqual(lines[1], [3]);
  // everything fits one line
  assert.equal(fitLines([2, 2], w, 1, 10).length, 1);
  // a single item wider than width still lands (caller truncates)
  assert.deepEqual(fitLines([99], w, 1, 5), [[99]]);
  // maxLines cap: overflow beyond the cap piles onto the last line, not a 3rd
  const capped = fitLines([5, 5, 5, 5], w, 0, 6, 2);
  assert.equal(capped.length, 2);
});

test("humanizeTokens: 0 / <1K / K / M boundaries", () => {
  assert.equal(humanizeTokens(0), "0");
  assert.equal(humanizeTokens(999), "999");
  assert.equal(humanizeTokens(1000), "1K");
  assert.equal(humanizeTokens(1499), "1K"); // rounded
  assert.equal(humanizeTokens(1_200_000), "1.2M");
});

test("humanizeDuration: seconds / minutes / hours formatting", () => {
  assert.equal(humanizeDuration(0), "0s");
  assert.equal(humanizeDuration(3000), "3s");
  assert.equal(humanizeDuration(754_000), "12m 34s"); // 754s = 12m34s
  assert.equal(humanizeDuration(3_900_000), "1h 05m"); // 65m = 1h05m
});

test("mergeSettings: project overrides global; nested objects deep-merge", () => {
  const merged = mergeSettings(
    { a: 1, nested: { x: 1, y: 2 }, onlyGlobal: true },
    { b: 2, nested: { y: 9 } },
  );
  assert.equal(merged.a, 1);
  assert.equal(merged.b, 2);
  assert.equal(merged.onlyGlobal, true);
  assert.deepEqual(merged.nested, { x: 1, y: 9 }); // deep merge, project wins
});

test("PRESETS: default/minimal/full are distinct and well-formed", () => {
  assert.equal(Object.keys(PRESETS).length, 3);
  assert.ok(PRESETS.default.length > PRESETS.minimal.length);
  assert.ok(PRESETS.full.length > PRESETS.default.length);
  // full is the only preset with the Phase 2 extras
  assert.ok(PRESETS.full.includes("cache_write") && PRESETS.full.includes("time_spent"));
  assert.ok(!PRESETS.default.includes("cache_write"));
});

test("resolveLayout: unconfigured ≡ default preset (byte-identical to V8)", () => {
  assert.deepEqual(resolveLayout({}), PRESETS.default);
});

test("resolveLayout: preset switch + disabledSegments + layout override + customItems", () => {
  assert.deepEqual(resolveLayout({ preset: "minimal" }), ["dir", "git", "context"]);
  // disabled removes from the resolved list
  const trimmed = resolveLayout({ preset: "default", disabledSegments: ["cost", "session"] });
  assert.ok(!trimmed.includes("cost") && !trimmed.includes("session"));
  assert.ok(trimmed.includes("dir"));
  // layout.left fully overrides the preset order
  assert.deepEqual(resolveLayout({ layout: { left: ["dir", "clock"] } }), ["dir", "clock"]);
  // custom items appended as custom:<id>
  assert.deepEqual(
    resolveLayout({ preset: "minimal", customItems: [{ id: "ci" }] }),
    ["dir", "git", "context", "custom:ci"],
  );
  // a disabled custom item is dropped
  assert.deepEqual(
    resolveLayout({ preset: "minimal", customItems: [{ id: "ci" }], disabledSegments: ["custom:ci"] }),
    ["dir", "git", "context"],
  );
});

test("computeBridgeBadge: fresh -> hidden (null)", () => {
  const now = 1_800_000_000_000;
  assert.equal(computeBridgeBadge(now - 3_600_000, now - 3_600_000, now), null); // same age = fresh
  assert.equal(computeBridgeBadge(now - 86_400_000, null, now), null); // 1d old, no db found
});

test("computeBridgeBadge: bd newer than export (+60s grace) -> red stale!", () => {
  const now = 1_800_000_000_000;
  const exportAt = now - 7_200_000;
  const withinGrace = computeBridgeBadge(exportAt, exportAt + 30_000, now); // db 30s newer than export
  assert.equal(withinGrace, null); // inside 60s grace: not stale
  const stale = computeBridgeBadge(exportAt, now, now); // db 2h newer than export
  assert.ok(stale && stale.text === "⛓ stale!" && stale.fg === "error");
});

test("computeBridgeBadge: export age >= 3d -> amber Nd; missing -> red no-export", () => {
  const now = 1_800_000_000_000;
  const d4 = computeBridgeBadge(now - 4 * 86_400_000, now - 5 * 86_400_000, now); // db older than export
  assert.ok(d4 && d4.text === "⛓ 4d" && d4.fg === "warning");
  const d2 = computeBridgeBadge(now - 2 * 86_400_000, now - 3 * 86_400_000, now);
  assert.equal(d2, null); // under 3d stays hidden
  const missing = computeBridgeBadge(null, now, now);
  assert.ok(missing && missing.text === "⛓ no-export" && missing.fg === "error");
});

test("PRESETS + registry: bridge segment wired into default and full", () => {
  assert.ok(PRESETS.default.includes("bridge") && PRESETS.full.includes("bridge"));
  assert.ok(!PRESETS.minimal.includes("bridge")); // minimal stays 3-segment
});

test("SEP_GLYPHS: all 10 styles, each with a nerd + plain form", () => {
  assert.equal(Object.keys(SEP_GLYPHS).length, 10);
  for (const [style, glyph] of Object.entries(SEP_GLYPHS)) {
    assert.equal(typeof glyph.nerd, "string", `${style} missing nerd form`);
    assert.equal(typeof glyph.plain, "string", `${style} missing plain form`);
    assert.ok(glyph.nerd.length > 0 && glyph.plain.length > 0, `${style} has empty form`);
  }
});

test("separatorFor: default preserves V3–V9 (E0B1 nerd / U+203A plain)", () => {
  assert.equal(separatorFor("powerline-thin", true), " \uE0B1 ");
  assert.equal(separatorFor("powerline-thin", false), " \u203A ");
  assert.equal(separatorFor("slash", true), " / ");
  assert.equal(separatorFor("dot", false), " \u00B7 ");
  // nerd vs plain differ for the powerline styles
  assert.notEqual(separatorFor("powerline", true), separatorFor("powerline", false));
});
