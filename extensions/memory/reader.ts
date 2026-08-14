// Pure disk reader for the memory store (coordinator-facing).
//
// WHY THIS EXISTS (module-isolation): JsonlMemoryStore.snapshot() (store.ts:176) reads from
// an in-memory Map hydrated by init() — it is NOT a pure disk read. Because pi loads each
// extension in an ISOLATED module graph (loader.js: per-extension createJiti, moduleCache:false;
// see stored fact `pi_extension_module_isolation`), a coordinator that imported snapshot() would
// receive its OWN un-init'd store copy → empty records → silent injection failure. This reader is
// pure (reads store.jsonl fresh every call, no module state) so it is safe to import across the
// isolation boundary — same property that makes readBridgeExport()/scanSecrets() cross-module safe.
//
// Faithfully mirrors store.ts:init() semantics: append-only JSONL, dedup by
// `${scope}:${category}:${key}` keeping the LATEST line (last-write-wins). If store.ts:init()
// changes, update this to match. isValidRecord is duplicated (not imported) to keep this module
// dependency-light and avoid pulling the store class into every consumer; the record shape is
// stable (schemaVersion:1).
//
// Mid-session writes surface at turn N+1 because remember() appends to disk synchronously under
// lock before the next before_agent_start fires — matches the F1 re-injection guarantee.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { MemoryRecord } from "./schema.ts";

const STORE_FILE = path.join(os.homedir(), ".pi", "agent", "memory", "store.jsonl");

function isValidRecord(rec: unknown): rec is MemoryRecord {
  if (typeof rec !== "object" || rec === null) return false;
  const r = rec as Record<string, unknown>;
  return (
    r.schemaVersion === 1 &&
    typeof r.scope === "string" &&
    typeof r.category === "string" &&
    typeof r.key === "string" &&
    typeof r.value === "string" &&
    (r.provenance === "operator" || r.provenance === "inferred") &&
    typeof r.turn === "number" &&
    typeof r.recordedAt === "number"
  );
}

/**
 * Read all memory records fresh from disk, deduped by scope:category:key (last-write-wins).
 * Pure: same disk state -> same output, no module state. Missing file -> [] (no throw).
 * Malformed lines are skipped (crash-safe, mirrors init()).
 */
export async function readMemoryRecords(): Promise<MemoryRecord[]> {
  let text: string;
  try {
    text = await fs.readFile(STORE_FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }

  const map = new Map<string, MemoryRecord>();
  let malformed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isValidRecord(parsed)) {
        map.set(`${parsed.scope}:${parsed.category}:${parsed.key}`, parsed);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  if (malformed > 0) {
    console.warn(`[memory/reader] skipped ${malformed} malformed line(s) from ${STORE_FILE}`);
  }
  return [...map.values()];
}
