// compaction-capture.ts — Phase-2 memory narrative capture (C1 Part 3).
//
// Hooks pi's `session_compact` event (fires AFTER compaction, carrying the
// generated `compactionEntry.summary`) and appends that summary to memory.md as
// a dated narrative block — BEFORE compaction discards the compacted messages.
//
// This realizes AGENTS.md's "preserve what the compactor drops" intent CORRECTLY:
// pi already EMITS the structured narrative (Goal/Progress/Decisions/Next/Critical-
// Context) at compaction, but it then lives only in the session JSONL. This hook
// persists it into the durable memory.md so the session-arc survives across
// sessions/compactions. Distinct from store.jsonl (atomic structured facts) — this
// is the NARRATIVE arc.
//
// Defenses: captured summaries are run through the same `scanSecrets` as the
// structured store (a summary could echo conversation secrets) — refuse + warn on a
// hit, never append. Growth is bounded by scripts/rotate-memory-md.ts (manual).
//
// Sub-agents run --no-extensions, so only the PARENT session's compactions are
// captured (correct — we don't want per-dispatch noise polluting the narrative log).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { scanSecrets } from "./memory/scanner.ts";
import { withFileLock } from "./memory/lock.ts";

const AGENT_DIR = join(os.homedir(), ".pi", "agent");
const MEMORY_MD = join(AGENT_DIR, "memory.md");
const HEADER_BOUNDARY = "\n---\n"; // memory.md's header block ends with a --- rule; insert captures after it
const MAX_SUMMARY_CHARS = 4000; // cap one capture so a huge summary can't blow the active region

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_compact", async (event) => {
    const summary: string | undefined = event.compactionEntry?.summary;
    if (!summary || !summary.trim()) return; // nothing to capture

    // Defense: a compaction summary can echo secrets that appeared in the compacted
    // conversation. Scan + refuse (never append a likely secret to memory.md).
    const scan = scanSecrets(summary);
    if (scan.detected) {
      console.warn(
        `[compaction-capture] secret detected in compaction summary (${scan.pattern}) — NOT appending to memory.md. Review the conversation.`,
      );
      return;
    }

    const reason = (event as { reason?: string }).reason ?? "unknown";
    const body = summary.length > MAX_SUMMARY_CHARS
      ? summary.slice(0, MAX_SUMMARY_CHARS) + `\n…[compaction summary truncated ${summary.length - MAX_SUMMARY_CHARS} chars]`
      : summary;

    const block = [
      "",
      `## ✅ UPDATE ${timestamp()} — compaction capture (reason: ${reason})`,
      "",
      "> Auto-captured from pi's `session_compact` event — the narrative summary pi generated before discarding the compacted messages. Part of the memory.md narrative log; bound with `scripts/rotate-memory-md.ts`.",
      "",
      body.trim(),
      "",
      "---",
      "",
    ].join("\n");

    try {
      // Cross-process lock (W8): serialize this read→write window against
      // scripts/rotate-memory-md.ts (separate process) and any other pi process's
      // capture, so a concurrent writer can't lose this update or be lost to it.
      // Best-effort — a lock timeout falls through to the catch below.
      await withFileLock(MEMORY_MD, async () => {
        mkdirSync(AGENT_DIR, { recursive: true });
        let content = existsSync(MEMORY_MD) ? readFileSync(MEMORY_MD, "utf-8") : "";
        // Insert right after the header rule so captures land newest-first in the
        // active region. Fall back to prepend if no boundary found (fresh file).
        const idx = content.indexOf(HEADER_BOUNDARY);
        if (idx !== -1) {
          const insertAt = idx + HEADER_BOUNDARY.length;
          content = content.slice(0, insertAt) + block + content.slice(insertAt);
        } else {
          content = block + content;
        }
        writeFileSync(MEMORY_MD, content, "utf-8");
      });
    } catch (e) {
      // Best-effort — never let memory capture break or delay a compaction.
      console.warn(`[compaction-capture] failed to write memory.md: ${(e as Error).message}`);
    }
  });
}
