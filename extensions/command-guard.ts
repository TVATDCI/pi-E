// command-guard — catastrophic-command seatbelt for pi's bash tool.
//
// Entry point only; the pure, tested core lives in ./lib/command-guard-core.ts
// (kept package-import-free so tests can run it standalone via
// `node --experimental-strip-types tests/command-guard.test.ts`).
//
// Provenance: absorbed 2026-08-16 from davidondrej/skills hooks/ + the
// global-agent-guardrails skill, via validate→absorb + oracle GO-WITH-CHANGES.
// SCOPE (explicit asymmetry): seatbelt against ACCIDENTS, not a sandbox; not
// parity with opencode's sisyphus-gates. DOCTRINE: fail-open on adapter
// self-error — a broken patterns file must never brick every bash call.

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { checkCommand, loadPatternsFromDisk } from "./lib/command-guard-core.ts";

export default function initCommandGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    try {
      // WHOLE handler inside try: pi's emitToolCall does NOT catch handler errors, and a
      // thrown error BLOCKS the tool (fail-closed) — the opposite of this guard's doctrine.
      // (Review 2026-08-16 finding A; same pi constraint mini-damage-control documents.)
      if (!isToolCallEventType("bash", event)) return; // only guard the bash tool

      // Re-read per call: pattern edits apply instantly, no restart.
      const verdict = checkCommand(event.input.command, loadPatternsFromDisk());
      if (verdict.blocked) {
        return {
          block: true,
          terminate: true, // stop the batch — a blocked agent must not try sibling variants
          reason:
            `Blocked by the command guard (~/.agents/hooks/dangerous-patterns.txt). ` +
            `Matched pattern: ${verdict.pattern}. This is a catastrophic-command seatbelt; ` +
            `do not retry or work around it — explain the block to the operator instead.`,
        };
      }
    } catch (err) {
      // FAIL-OPEN: unreadable/missing patterns file, malformed event, anything unexpected → allow.
      console.error(`[command-guard] fail-open (allowing): ${String(err)}`);
    }
    return; // allow
  });
}
