// compaction-extract.ts — #4 structured compaction → store.jsonl extraction.
//
// Hooks session_compact (same event as compaction-capture, independent handler —
// no single-handler constraint applies to this event; capture handles NARRATIVE
// memory.md, this handles STRUCTURED store.jsonl). Parses the summary via the
// pure extractCandidates() core, dedups against the on-disk store (reader.ts —
// cross-process safe; an un-init'd store.map would see nothing), then writes via
// store.remember() with provenance "inferred" (E1 secret-scan + E2.1
// inferred-constraint→fact downgrade + B2 inferred-never-over-operator + audit
// all apply for free).
//
// Failure model: whole handler wrapped — extraction must NEVER break or delay a
// compaction. Telemetry: one line per compaction to ~/.pi/agent/extract.log.
//
// Module-isolation note (coordinator-arc lesson): this extension owns its OWN
// JsonlMemoryStore instance; init() at session_start hydrates the in-memory map
// for remember()'s B2 guard; cross-PROCESS dedup uses reader.ts (pure disk read).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { JsonlMemoryStore } from "./memory/store.ts";
import { LockTimeoutError } from "./memory/lock.ts";
import { readMemoryRecords } from "./memory/reader.ts";
import { extractCandidates } from "./memory/extract.ts";

const STORE_DIR = join(os.homedir(), ".pi", "agent", "memory");
const STORE_FILE = join(STORE_DIR, "store.jsonl");
const AUDIT_FILE = join(STORE_DIR, "audit.log");
const EXTRACT_LOG = join(os.homedir(), ".pi", "agent", "extract.log");

export default function (pi: ExtensionAPI) {
  const store = new JsonlMemoryStore({ filePath: STORE_FILE, auditLogPath: AUDIT_FILE });

  // Hydrate the store map so remember()'s B2 guard sees existing records.
  // (reader.ts handles the cross-process dedup below regardless.)
  pi.on("session_start", async () => {
    try {
      await store.init();
    } catch (e) {
      console.warn(`[compaction-extract] store.init failed (best-effort): ${(e as Error).message}`);
    }
  });

  pi.on("session_compact", async (event) => {
    try {
      const summary: string | undefined = event.compactionEntry?.summary;
      if (!summary || !summary.trim()) return;

      const candidates = extractCandidates(summary);
      if (candidates.length === 0) return;

      // Cross-process dedup: drop candidates whose key already exists on disk
      // (normalizeKey both sides — reader returns normalized keys; candidates may slug).
      const existing = await readMemoryRecords();
      const existingKeys = new Set(existing.map((r) => r.key));
      const fresh = candidates.filter((c) => !existingKeys.has(c.key));

      let inserted = 0;
      let updated = 0;
      let skippedGuard = 0;
      let secretSkipped = 0;
      for (const c of fresh) {
        try {
          const outcome = await store.remember({
            schemaVersion: 1,
            scope: "global",
            category: c.category,
            key: c.key,
            value: c.value,
            provenance: "inferred", // E2.1 downgrades constraint→fact for inferred records
            turn: 0,
            recordedAt: Date.now(),
          });
          if (outcome.action === "inserted") inserted++;
          else if (outcome.action === "updated") updated++;
          else skippedGuard++;
        } catch (e) {
          if (e instanceof Error && e.name === "SecretDetectedError") {
            secretSkipped++; // E1 refused — correct behavior, count and move on
          } else if (e instanceof LockTimeoutError) {
            console.warn(`[compaction-extract] lock timeout on '${c.key}' — record not saved`);
          } else {
            throw e;
          }
        }
      }

      try {
        appendFileSync(
          EXTRACT_LOG,
          `${new Date().toISOString()} candidates=${candidates.length} ` +
            `dup_skipped=${candidates.length - fresh.length} inserted=${inserted} ` +
            `updated=${updated} guard_skipped=${skippedGuard} secret_skipped=${secretSkipped} ` +
            `reason=${(event as { reason?: string }).reason ?? "unknown"}\n`,
        );
      } catch {
        /* telemetry non-critical */
      }
    } catch (e) {
      // Never break or delay a compaction over extraction.
      console.warn(`[compaction-extract] failed (compaction proceeds): ${(e as Error).message}`);
    }
  });
}
