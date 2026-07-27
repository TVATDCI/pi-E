// scripts/rotate-memory-md.ts — bound ~/.pi/agent/memory.md (C1 Part 2).
//
// Standalone (NO pi-package dependency). Run:
//   node --experimental-strip-types scripts/rotate-memory-md.ts [activeKB]   # default 12
//
// memory.md is the session-narrative log (newest-first). This keeps the newest
// narrative blocks within an active-KB budget and archives older blocks to
// memory.md.archive-YYYY-MM.md (month-granular, append-safe, durable).
//
// - The header (everything before the first `## `) is ALWAYS kept.
// - Blocks are delimited by `## ` headers.
// - At least ONE block (the newest) is always kept, even if it alone exceeds budget.
// - Backs up to /tmp before rotating (immediate safety); the archive is the durable record.
//
// Run manually when memory.md grows past budget (the compaction-capture hook appends;
// this trims). Safe to re-run.

import { readFileSync, writeFileSync, existsSync, copyFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

const MEM = join(os.homedir(), ".pi", "agent", "memory.md");
const AGENT_DIR = join(os.homedir(), ".pi", "agent");
const ACTIVE_KB = Number(process.argv[2] ?? 12);
const budget = ACTIVE_KB * 1024;

if (!existsSync(MEM)) {
  console.log(`rotate: ${MEM} not found — nothing to do.`);
  process.exit(0);
}

const original = readFileSync(MEM, "utf-8");
const originalBytes = Buffer.byteLength(original);
if (originalBytes <= budget) {
  console.log(`rotate: memory.md is ${originalBytes}B ≤ ${budget}B budget — nothing to do.`);
  process.exit(0);
}

// Split into header + blocks (file is newest-first; blocks[0] is newest).
const lines = original.split("\n");
let header = "";
const blocks: string[] = [];
let cur = "";
let inHeader = true;
for (const line of lines) {
  if (inHeader && line.startsWith("## ")) inHeader = false;
  if (inHeader) {
    header += line + "\n";
    continue;
  }
  if (line.startsWith("## ") && cur !== "") {
    blocks.push(cur);
    cur = "";
  }
  cur += line + "\n";
}
if (cur !== "") blocks.push(cur);

if (blocks.length <= 1) {
  console.log(`rotate: only ${blocks.length} block(s) — can't trim without losing the active block. Skipping (consider raising the budget).`);
  process.exit(0);
}

// Keep newest-first (blocks[0..k]) within budget; archive the rest (older).
let kept = Buffer.byteLength(header);
let k = 0;
for (let i = 0; i < blocks.length; i++) {
  const sz = Buffer.byteLength(blocks[i]);
  if (kept + sz <= budget || i === 0) {
    k = i;
    kept += sz;
  } else {
    break;
  }
}

const active = header + blocks.slice(0, k + 1).join("");
const archived = blocks.slice(k + 1).join("");

// Immediate safety backup (transient); archive is the durable record.
const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const backup = `/tmp/memory.md.bak-${ts}`;
copyFileSync(MEM, backup);

const stamp = new Date().toISOString().slice(0, 7); // YYYY-MM
const archivePath = join(AGENT_DIR, `memory.md.archive-${stamp}.md`);
if (archived) {
  appendFileSync(
    archivePath,
    `\n# Archived ${new Date().toISOString()} — rotate kept blocks 0..${k} (${k + 1} block(s), ${Buffer.byteLength(active)}B active)\n\n` + archived,
    "utf-8",
  );
}
writeFileSync(MEM, active, "utf-8");

console.log(
  `rotate: memory.md ${originalBytes}B → ${Buffer.byteLength(active)}B active (kept blocks 0..${k} = ${k + 1}); ` +
    `archived ${Buffer.byteLength(archived)}B → ${archivePath}; backup → ${backup}`,
);
