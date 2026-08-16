// lib/command-guard-core.ts — pure core of the command guard (no pi-package imports;
// imported directly by tests/command-guard.test.ts).
//
// Provenance: absorbed 2026-08-16 from davidondrej/skills (hooks/deny-dangerous.sh +
// global-agent-guardrails) via validate→absorb; oracle GO-WITH-CHANGES review.
// Patterns live in ~/.agents/hooks/dangerous-patterns.txt (SHARED file, one tuning
// point; Linux port + the /home tree patterns that closed the source's gap).
//
// SCOPE: catastrophic-command seatbelt (rm at root/home, dd/mkfs, fork bombs,
// curl|sh, force-push, password-manager CLIs) — NOT a sandbox, NOT parity with
// opencode's sisyphus-gates (which blocks compounds outright). By design.
//
// DOCTRINE: FAIL-OPEN — an uncompilable pattern line is skipped; a missing/broken
// patterns file must never brick bash (see handler wrapper in command-guard.ts).

import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const PATTERNS_PATH = join(homedir(), ".agents", "hooks", "dangerous-patterns.txt");

/** Strip blank lines and # comments from the patterns file. Pure. */
export function extractPatterns(fileText: string): string[] {
  return fileText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * Convert a POSIX-ERE pattern line to a JavaScript RegExp.
 * [:space:] → \s (JS has no POSIX classes); multiline flag so ^ anchors match
 * each shell line (mirrors grep -E semantics on multiline command strings).
 * Returns null for patterns that fail to compile (skip → fail-open per line).
 */
export function toJsRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern.replaceAll("[:space:]", "\\s"), "m");
  } catch {
    return null;
  }
}

export interface GuardVerdict {
  blocked: boolean;
  /** The pattern that matched, when blocked. Diagnostic for the block reason. */
  pattern?: string;
  /** Number of patterns actually compiled (diagnostic for tuning/debugging). */
  compiled: number;
}

/** Pure check: does the command match any pattern? First match wins. */
export function checkCommand(command: string, patterns: string[]): GuardVerdict {
  let compiled = 0;
  for (const pattern of patterns) {
    const re = toJsRegex(pattern);
    if (!re) continue; // uncompilable line: skip, never crash the guard
    compiled++;
    if (re.test(command)) return { blocked: true, pattern, compiled };
  }
  return { blocked: false, compiled };
}

/** Load + extract patterns from disk. Throws on read errors (caller decides fail-open). */
export function loadPatternsFromDisk(path: string = PATTERNS_PATH): string[] {
  return extractPatterns(readFileSync(path, "utf8"));
}
