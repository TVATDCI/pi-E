// extensions/tests/inbox-sentinel.test.ts — forced-attention producer for unread lane-inbox.
// Regression lock for the repeated turn-start discipline failures (operator corrections
// 2026-09-07 + 2026-09-15): unread ~/lane-inbox/*.md MUST surface in the system prompt.
// Pure tests: tmpdir fixtures, no home dependency.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaneInbox, formatInboxBlock, composeInboxSection } from "../lib/inbox-sentinel.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`ok - ${name}`);
  } else {
    fail++;
    console.error(`FAIL - ${name}`);
  }
}

let dir: string;
dir = mkdtempSync(join(tmpdir(), "inbox-sentinel-"));

// readLaneInbox: absent dir -> empty (fresh desk: sentinel silent)
check("absent dir -> []", readLaneInbox(join(dir, "nope")).length === 0);
// empty dir -> empty
check("empty dir -> []", readLaneInbox(dir).length === 0);
// root .md only, oldest first, size carried; subdirs (read/) excluded
writeFileSync(join(dir, "b-second.md"), "hello world");
writeFileSync(join(dir, "a-first.md"), "x");
// Deterministic mtimes: explicit and distinct — never rely on write-order timing
// or readdir hash order (CI flake root cause: same-tick mtimes + fs-dependent
// readdir order made this assertion pass-by-luck locally and fail on the runner).
const T0 = Date.now() / 1000 - 100;
utimesSync(join(dir, "a-first.md"), T0, T0);
utimesSync(join(dir, "b-second.md"), T0 + 50, T0 + 50);
writeFileSync(join(dir, "notes.txt"), "not md");
mkdirSync(join(dir, "read"));
writeFileSync(join(dir, "read", "consumed.md"), "already read");
const entries = readLaneInbox(dir);
check("collects root .md only", entries.length === 2);
check("oldest-first order", entries[0].name === "a-first.md" && entries[1].name === "b-second.md");
check("size carried", entries[1].sizeBytes === 11);

// formatInboxBlock: empty -> zero tokens
check("empty entries -> empty string", formatInboxBlock([]) === "");
// non-empty -> block names file + carries the discipline line
const block = formatInboxBlock([
  { name: "ddd-msg-v0.1.md", mtimeMs: Date.parse("2026-09-15T14:24:00Z"), sizeBytes: 2048 },
]);
check("block sentinel-wrapped", block.includes("<lane-inbox-sentinel>"));
check("block counts unread", block.includes("UNREAD (1)"));
check("block names the file", block.includes("ddd-msg-v0.1.md"));
check("block carries discipline line", block.includes("first action of EVERY turn"));

// composeInboxSection end-to-end: files -> block; fully cleared -> silence
writeFileSync(join(dir, "m.md"), "msg");
check("compose surfaces file", composeInboxSection(dir).includes("m.md"));
for (const f of readLaneInbox(dir)) rmSync(join(dir, f.name));
check("cleared dir -> silence", composeInboxSection(dir) === "");

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
