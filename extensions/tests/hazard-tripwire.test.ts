// Unit tests for extensions/hazard-tripwire.ts (2026-09-27 incident rider).
// Pure-function coverage: loader-discovery mirror (files, dirs, package.json
// pi-manifests, symlinks, sort), baseline load/write round-trip, and the
// checkScaffolding classification for every incident damage class (missing
// store / empty store / lost .git / adoption marker / planted shim / lost
// pinned entry / unarmed). Presentation formatters get shape assertions.
//
// Run from here (or via scripts/run-tests.ts): node --experimental-strip-types hazard-tripwire.test.ts

import {
  isExtensionFile,
  readPiManifestMirror,
  resolveExtensionEntriesMirror,
  discoverExtensionEntries,
  loadBaseline,
  writeBaseline,
  checkScaffolding,
  statusKeyFor,
  formatStatusLine,
  formatWidget,
  formatHazardBlock,
} from "../hazard-tripwire.ts";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

let passed = 0;
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
function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = typeof actual === "object" && actual !== null ? JSON.stringify(actual) : actual;
  const b = typeof expected === "object" && expected !== null ? JSON.stringify(expected) : expected;
  if (a !== b) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertTrue(v: unknown, label: string): void {
  if (!v) throw new Error(`${label}: expected truthy, got ${JSON.stringify(v)}`);
}

/** Fresh fixture agent-dir with healthy scaffolding + a mini extensions tree. */
function makeAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "hazard-tripwire-test-"));
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", "store.jsonl"), '{"key":"k"}\n');
  writeFileSync(join(root, "memory.md"), "# memory\n");
  mkdirSync(join(root, ".git"));
  const ext = join(root, "extensions");
  mkdirSync(ext);
  writeFileSync(join(ext, "alpha.ts"), "export default () => {};\n");
  writeFileSync(join(ext, "zeta.js"), "export default () => {};\n");
  mkdirSync(join(ext, "pkg", "sub"), { recursive: true });
  writeFileSync(
    join(ext, "pkg", "package.json"),
    JSON.stringify({ name: "pkg", pi: { extensions: ["sub/one.ts", "gone.ts"] } }),
  );
  writeFileSync(join(ext, "pkg", "sub", "one.ts"), "export default () => {};\n");
  mkdirSync(join(ext, "indexed"));
  writeFileSync(join(ext, "indexed", "index.ts"), "export default () => {};\n");
  mkdirSync(join(ext, "plainlib"));
  writeFileSync(join(ext, "plainlib", "helper.ts"), "export default () => {};\n");
  writeFileSync(join(ext, "notes.md"), "not an extension\n");
  writeFileSync(join(ext, "quotas.json"), "{}\n");
  return root;
}

run("isExtensionFile: .ts/.js yes, others no", () => {
  assertEq(isExtensionFile("a.ts"), true, "ts");
  assertEq(isExtensionFile("a.js"), true, "js");
  assertEq(isExtensionFile("a.tsx"), false, "tsx");
  assertEq(isExtensionFile("a.json"), false, "json");
  assertEq(isExtensionFile("a.md"), false, "md");
});

run("readPiManifestMirror: pi.extensions array of strings", () => {
  const root = mkdtempSync(join(tmpdir(), "ht-mani-"));
  const p = join(root, "package.json");
  writeFileSync(p, JSON.stringify({ pi: { extensions: ["a.ts"] } }));
  assertEq(readPiManifestMirror(p), { extensions: ["a.ts"] }, "valid");
  writeFileSync(p, JSON.stringify({ pi: { extensions: ["a.ts", 3] } }));
  assertEq(readPiManifestMirror(p), null, "non-string entry → null");
  writeFileSync(p, JSON.stringify({ pi: {} }));
  assertEq(readPiManifestMirror(p), null, "empty pi → null");
  writeFileSync(p, JSON.stringify({ name: "x" }));
  assertEq(readPiManifestMirror(p), null, "no pi field → null");
  writeFileSync(p, "{corrupt");
  assertEq(readPiManifestMirror(p), null, "corrupt → null");
  writeFileSync(p, "\uFEFF" + JSON.stringify({ pi: { extensions: ["b.ts"] } }));
  assertEq(readPiManifestMirror(p), { extensions: ["b.ts"] }, "BOM stripped");
});

run("resolveExtensionEntriesMirror: precedence + fallbacks", () => {
  const root = mkdtempSync(join(tmpdir(), "ht-res-"));
  const d = join(root, "ext");
  mkdirSync(d);
  assertEq(resolveExtensionEntriesMirror(d), null, "empty dir → null");
  writeFileSync(join(d, "index.js"), "");
  assertEq(resolveExtensionEntriesMirror(d), [join(d, "index.js")], "index.js fallback");
  writeFileSync(join(d, "index.ts"), "");
  assertEq(resolveExtensionEntriesMirror(d), [join(d, "index.ts")], "index.ts wins over index.js");
  writeFileSync(
    join(d, "package.json"),
    JSON.stringify({ pi: { extensions: ["entry.ts"] } }),
  );
  writeFileSync(join(d, "entry.ts"), "");
  assertEq(resolveExtensionEntriesMirror(d), [join(d, "entry.ts")], "package.json pi field wins");
  // All declared paths missing → falls through to index
  writeFileSync(join(d, "package.json"), JSON.stringify({ pi: { extensions: ["gone.ts"] } }));
  assertEq(resolveExtensionEntriesMirror(d), [join(d, "index.ts")], "dead manifest falls to index");
});

run("discoverExtensionEntries: set, sort, ignores, symlinks", () => {
  const root = makeAgentDir();
  const ext = join(root, "extensions");
  // symlinked file extension (operator-guard.ts pattern)
  writeFileSync(join(root, "linked-target.ts"), "");
  symlinkSync(join(root, "linked-target.ts"), join(ext, "aaa-link.ts"));
  // symlinked dir with index (worktree-style package)
  mkdirSync(join(root, "linked-pkg"));
  writeFileSync(join(root, "linked-pkg", "index.ts"), "");
  symlinkSync(join(root, "linked-pkg"), join(ext, "zzz-linkpkg"));

  const got = discoverExtensionEntries(ext);
  assertEq(
    JSON.stringify(got),
    JSON.stringify([
      "aaa-link.ts",
      "alpha.ts",
      "indexed/index.ts",
      "pkg/sub/one.ts",
      "zeta.js",
      "zzz-linkpkg/index.ts",
    ]),
    "discovered set (sorted, posix)",
  );
  // absent dir
  assertEq(discoverExtensionEntries(join(root, "nope")), [], "missing ext dir → []");
  rmSync(root, { recursive: true, force: true });
});

run("loadBaseline: absent / malformed / wrong version", () => {
  const root = mkdtempSync(join(tmpdir(), "ht-base-"));
  const p = join(root, "hazard-tripwire.json");
  assertEq(loadBaseline(p).baseline, null, "absent → null, no failure");
  writeFileSync(p, "{corrupt");
  assertTrue(loadBaseline(p).failure, "corrupt → failure string");
  writeFileSync(p, JSON.stringify({ version: 99, entries: [] }));
  assertTrue(loadBaseline(p).failure, "wrong version → failure string");
  writeFileSync(p, JSON.stringify({ version: 1, entries: [1, 2] }));
  assertTrue(loadBaseline(p).failure, "non-string entries → failure");
});

run("writeBaseline → checkScaffolding: pass round-trip, then re-arm idempotent", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  const b = writeBaseline(bp, join(root, "extensions"), "testhost");
  assertTrue(b.entries.length >= 4, "pinned the fixture entries");
  const s1 = checkScaffolding(root, bp);
  assertEq(s1.status, "pass", "healthy tree → pass");
  const b2 = writeBaseline(bp, join(root, "extensions"), "testhost2");
  assertEq(b2.entries.length, b.entries.length, "re-arm pins same set");
  assertEq(checkScaffolding(root, bp).status, "pass", "still pass after re-arm");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: unarmed when no baseline, green otherwise", () => {
  const root = makeAgentDir();
  const s = checkScaffolding(root, join(root, "absent-baseline.json"));
  assertEq(s.status, "unarmed", "no baseline → unarmed, not silent pass");
  assertEq(s.failures.length, 0, "green checks stay green while unarmed");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: memory store missing → hazard", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  writeBaseline(bp, join(root, "extensions"), "t");
  rmSync(join(root, "memory", "store.jsonl"));
  const s = checkScaffolding(root, bp);
  assertEq(s.status, "hazard", "status");
  assertTrue(s.failures.some((f) => f.includes("store missing")), "failure names the store");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: EMPTY store → hazard (recreated-cache tell)", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  writeBaseline(bp, join(root, "extensions"), "t");
  writeFileSync(join(root, "memory", "store.jsonl"), "");
  const s = checkScaffolding(root, bp);
  assertEq(s.status, "hazard", "status");
  assertTrue(s.failures.some((f) => f.includes("EMPTY")), "failure says EMPTY");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: memory.md missing → hazard", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  writeBaseline(bp, join(root, "extensions"), "t");
  rmSync(join(root, "memory.md"));
  const s = checkScaffolding(root, bp);
  assertEq(s.status, "hazard", "status");
  assertTrue(s.failures.some((f) => f.includes("memory.md")), "failure names memory.md");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: .git missing → hazard (wholesale-move tell)", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  writeBaseline(bp, join(root, "extensions"), "t");
  rmSync(join(root, ".git"), { recursive: true });
  const s = checkScaffolding(root, bp);
  assertEq(s.status, "hazard", "status");
  assertTrue(s.failures.some((f) => f.includes("git identity")), "failure names .git");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: adoption marker → hazard", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  writeBaseline(bp, join(root, "extensions"), "t");
  writeFileSync(join(root, ".adopted-from-omo-flat"), "");
  const s = checkScaffolding(root, bp);
  assertEq(s.status, "hazard", "status");
  assertTrue(s.failures.some((f) => f.includes("adoption marker")), "failure names marker");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: PLANTED SHIM (.js top-level) → hazard with extra", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  writeBaseline(bp, join(root, "extensions"), "t");
  writeFileSync(join(root, "extensions", "diff.js"), "// Generated by OmO\n");
  const s = checkScaffolding(root, bp);
  assertEq(s.status, "hazard", "status");
  assertEq(JSON.stringify(s.extra), JSON.stringify(["diff.js"]), "extra names the shim");
  assertEq(s.missing.length, 0, "nothing missing");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: lost pinned entry → hazard with missing", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  writeBaseline(bp, join(root, "extensions"), "t");
  rmSync(join(root, "extensions", "alpha.ts"));
  const s = checkScaffolding(root, bp);
  assertEq(s.status, "hazard", "status");
  assertEq(JSON.stringify(s.missing), JSON.stringify(["alpha.ts"]), "missing names the entry");
  rmSync(root, { recursive: true, force: true });
});

run("checkScaffolding: corrupt baseline → hazard even on green tree", () => {
  const root = makeAgentDir();
  const bp = join(root, "hazard-tripwire.json");
  writeFileSync(bp, "not json at all");
  const s = checkScaffolding(root, bp);
  assertEq(s.status, "hazard", "tamper-evidence fires");
  assertTrue(s.failures.some((f) => f.includes("unparseable")), "failure names corruption");
  rmSync(root, { recursive: true, force: true });
});

run("formatters: status line / widget / hazard block shapes", () => {
  const pass = { status: "pass" as const, missing: [], extra: [], failures: [] };
  assertEq(formatStatusLine(pass), "tripwire: armed ✓", "pass line");
  const unarmed = { status: "unarmed" as const, missing: [], extra: [], failures: [] };
  assertTrue(formatStatusLine(unarmed).includes("UNARMED"), "unarmed line");
  const hz = {
    status: "hazard" as const,
    missing: ["memory.md"],
    extra: ["diff.js", "tps.js"],
    failures: ["memory store missing: memory/store.jsonl"],
  };
  const line = formatStatusLine(hz);
  assertTrue(line.includes("⛔") && line.includes("1 missing") && line.includes("2 extra"), "hazard line");
  const w = formatWidget(hz).join("\n");
  assertTrue(w.includes("HAZARD TRIPWIRE FIRED") && w.includes("diff.js"), "widget banner");
  const blk = formatHazardBlock(hz);
  assertTrue(blk.startsWith("<hazard-tripwire>") && blk.endsWith("</hazard-tripwire>"), "block tags");
  assertTrue(blk.includes("diff.js") && blk.includes("store missing"), "block carries detail");
});

run("formatters: widget truncates long lists (+N more)", () => {
  const hz = {
    status: "hazard" as const,
    missing: [],
    extra: ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js"],
    failures: [],
  };
  const w = formatWidget(hz).join("\n");
  assertTrue(w.includes("+2 more"), "truncation marker");
});

run("statusKeyFor: state→key mapping (footer color switches per state)", () => {
  const pass = { status: "pass" as const, missing: [], extra: [], failures: [] };
  assertEq(statusKeyFor(pass), "tripwire-ok", "pass → ok key (green)");
  const unarmed = { status: "unarmed" as const, missing: [], extra: [], failures: [] };
  assertEq(statusKeyFor(unarmed), "tripwire-warn", "unarmed → warn key (amber)");
  const hz = { status: "hazard" as const, missing: ["memory.md"], extra: [], failures: [] };
  assertEq(statusKeyFor(hz), "tripwire-hazard", "hazard → hazard key (red)");
});

run("symlink fixture sanity: existsSync follows links the loader way", () => {
  const root = mkdtempSync(join(tmpdir(), "ht-link-"));
  writeFileSync(join(root, "t.ts"), "");
  symlinkSync(join(root, "t.ts"), join(root, "l.ts"));
  assertTrue(existsSync(join(root, "l.ts")), "symlink resolves");
  rmSync(root, { recursive: true, force: true });
});

console.log(`\nhazard-tripwire: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
