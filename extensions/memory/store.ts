// JsonlMemoryStore — append-only JSONL log, dedup-on-read (W8b fix 2026-07-28).
//
// Architecture:
//   - In-memory Map<string, MemoryRecord> keyed by "scope:category:key", hydrated at init().
//   - Disk = append-only JSONL: remember() appends ONE line; init() dedups by key keeping
//     the LATEST line (iterates + map.set overwrites). No whole-file rewrite on the write
//     path → no clobber across processes (W8b fixed) and no shared-.tmp rename race (W18 retired).
//   - forget() is rare → compaction: under withFileLock, read all → dedup-drop-key →
//     tmp+rename. Both append and compaction serialize via the SAME lock, so an append
//     can't land inside forget's read→rename window (the v1 blocker, closed).
//   - All mutations under withFileLock (extensions/memory/lock.ts). Assumes a LOCAL fs
//     (O_EXCL lockfile is unreliable on NFS).
//   - close() is a true no-op.
//
// Defenses at the storage boundary (remember()):
//   E1  secret scan -> throw SecretDetectedError (refuse + surface)
//   E2.1 inferred + constraint -> downgrade to fact (defense-in-depth)
//   B2  provenance write-guard: inferred cannot overwrite operator (asymmetric)
//
// Failure modes: remember()/forget() may throw LockTimeoutError if another writer holds
// the lock >timeoutMs (10s default; practically never uncontended). Callers tolerate it
// (surface a warning, do not crash the agent).
//
// DI seam: `rename` is injectable so the rename-failure test can force a throw in compactDrop.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Category, MemoryRecord, Scope } from "./schema.ts";
import { scanSecrets } from "./scanner.ts";
import { normalizeKey } from "./normalizer.ts";
import { withFileLock } from "./lock.ts";

export const DEFAULT_AUDIT_LOG_MAX_BYTES = 10 * 1024 * 1024; // ~10MB (Momus m3)

export class SecretDetectedError extends Error {
  pattern: string;
  constructor(pattern: string) {
    super(`Possible secret detected (${pattern}); rephrase and retry.`);
    this.name = "SecretDetectedError";
    this.pattern = pattern;
  }
}

export interface StoreOptions {
  filePath: string;
  auditLogPath?: string;
  auditLogMaxBytes?: number;
  /** DI seam: override fs.rename for the rename-failure test (compactDrop). Defaults to fs.rename. */
  rename?: (oldPath: string, newPath: string) => Promise<void>;
}

export type RememberOutcome =
  | { action: "inserted"; record: MemoryRecord }
  | { action: "updated"; record: MemoryRecord; previous: MemoryRecord }
  | { action: "skipped_inferred_over_operator"; existing: MemoryRecord };

export class JsonlMemoryStore {
  private map: Map<string, MemoryRecord> = new Map();
  private readonly filePath: string;
  private readonly auditLogPath: string | undefined;
  private readonly auditLogMaxBytes: number;
  private readonly rename: (oldPath: string, newPath: string) => Promise<void>;

  constructor(opts: StoreOptions) {
    this.filePath = opts.filePath;
    this.auditLogPath = opts.auditLogPath;
    this.auditLogMaxBytes = opts.auditLogMaxBytes ?? DEFAULT_AUDIT_LOG_MAX_BYTES;
    this.rename = opts.rename ?? ((oldPath, newPath) => fs.rename(oldPath, newPath));
  }

  private mapKey(scope: Scope, category: Category, key: string): string {
    return `${scope}:${category}:${key}`;
  }

  /** Hydrate the Map from the JSONL file (append-only: dedups by key, LATEST line wins).
   *  Missing file = empty store (no throw). Malformed lines are skipped + warned (Momus M4):
   *  one truncated/torn trailing line must not unload the store (crash-safe). */
  async init(): Promise<void> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const lines = text.split("\n");
    let malformed = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (!this.isValidRecord(parsed)) {
          malformed++;
          continue;
        }
        this.map.set(this.mapKey(parsed.scope, parsed.category, parsed.key), parsed);
      } catch {
        malformed++;
      }
    }
    if (malformed > 0) {
      console.warn(`[memory] init: skipped ${malformed} malformed line(s) from ${this.filePath}`);
    }
  }

  private isValidRecord(rec: unknown): rec is MemoryRecord {
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

  /** Write a record through the defense pipeline. Returns the storage outcome. */
  async remember(incoming: MemoryRecord): Promise<RememberOutcome> {
    // E1: secret scan at the write boundary (refuse + surface) — VALUE and KEY
    // (keys are derived from summary text in the extract pipeline; review security-c).
    const scan = scanSecrets(incoming.value);
    if (scan.detected) {
      throw new SecretDetectedError(scan.pattern ?? "unknown");
    }
    const keyScan = scanSecrets(incoming.key);
    if (keyScan.detected) {
      throw new SecretDetectedError(keyScan.pattern ?? "unknown");
    }

    // Normalize key (safety net for agent-supplied form).
    const normKey = normalizeKey(incoming.key);

    // E2.1: inferred constraint -> downgrade to fact (defense-in-depth).
    let category = incoming.category;
    if (incoming.provenance === "inferred" && incoming.category === "constraint") {
      category = "fact";
    }
    const finalRecord: MemoryRecord = { ...incoming, key: normKey, category };
    const mk = this.mapKey(finalRecord.scope, category, normKey);

    // B2: provenance write-guard (asymmetric). inferred cannot overwrite operator —
    // INCLUDING across categories: after E2.1 downgrades an inferred constraint to fact,
    // `global:constraint:x` (operator) vs `global:fact:x` (inferred) would otherwise never
    // collide and the inferred record lands as a sibling (review security-a). Any operator
    // record with the same scope+key shields the key entirely.
    if (finalRecord.provenance === "inferred") {
      const suffix = `:${normKey}`;
      for (const [k, v] of this.map.entries()) {
        if (v.provenance === "operator" && k.endsWith(suffix)) {
          await this.audit("SKIP", k, "inferred-over-operator-cross-category", v);
          return { action: "skipped_inferred_over_operator", existing: v };
        }
      }
    }
    const existing = this.map.get(mk);
    if (existing && existing.provenance === "operator" && finalRecord.provenance === "inferred") {
      await this.audit("SKIP", mk, "inferred-over-operator", existing);
      return { action: "skipped_inferred_over_operator", existing };
    }

    this.map.set(mk, finalRecord);
    await this.appendRecord(finalRecord);

    const outcome: RememberOutcome = existing
      ? { action: "updated", record: finalRecord, previous: existing }
      : { action: "inserted", record: finalRecord };
    const auditVerb = outcome.action === "inserted" ? "INSERT" : "UPDATE";
    await this.audit(auditVerb, mk, finalRecord.provenance, finalRecord);
    return outcome;
  }

  async recall(scope: Scope, category: Category, key: string): Promise<MemoryRecord | null> {
    return this.map.get(this.mapKey(scope, category, normalizeKey(key))) ?? null;
  }

  /** Hard delete via compaction. Returns whether a record was removed. */
  async forget(scope: Scope, category: Category, key: string): Promise<boolean> {
    const mk = this.mapKey(scope, category, normalizeKey(key));
    const existed = this.map.delete(mk);
    if (existed) {
      await this.compactDrop(mk);
      await this.audit("FORGET", mk, "deleted", {
        schemaVersion: 1, scope, category, key, value: "", provenance: "operator", turn: 0, recordedAt: 0,
      });
    }
    return existed;
  }

  async snapshot(filter: { scopes: Scope[] }): Promise<MemoryRecord[]> {
    const scopes = new Set(filter.scopes);
    return [...this.map.values()].filter((r) => scopes.has(r.scope));
  }

  /** Simple substring match (case-insensitive) on value within scope filter. */
  async search(query: string, filter: { scopes: Scope[] }): Promise<MemoryRecord[]> {
    const q = query.toLowerCase();
    const scopes = new Set(filter.scopes);
    return [...this.map.values()].filter(
      (r) => scopes.has(r.scope) && r.value.toLowerCase().includes(q),
    );
  }

  /** Nothing buffered. True no-op. */
  async close(): Promise<void> {}

  /**
   * Append one record line under the cross-process lock. Append-only (W8b): no whole-file
   * rewrite, so no clobber across processes and no shared-.tmp race (W18 retired). The same
   * lock as compactDrop() → an append can't land inside forget's read→rename window.
   * LockTimeoutError propagates if the lock is held >timeoutMs (callers tolerate).
   */
  private async appendRecord(rec: MemoryRecord): Promise<void> {
    await withFileLock(this.filePath, async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, JSON.stringify(rec) + "\n", "utf8");
    });
  }

  /**
   * Compaction delete under the cross-process lock (forget is rare). Reads all lines, dedups
   * keeping the latest per key while dropping `dropKey`, then rewrites via tmp+rename. Same
   * lock as appendRecord() → the two cannot interleave (closes the v1 forget-vs-append race).
   * On rename failure: the lock is released (finally) and the file is left at its pre-call
   * state (the tmp is orphaned, harmless; the real file is untouched).
   */
  private async compactDrop(dropKey: string): Promise<void> {
    await withFileLock(this.filePath, async () => {
      let text: string;
      try {
        text = await fs.readFile(this.filePath, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // nothing to compact
        throw e;
      }
      const latest = new Map<string, MemoryRecord>();
      let malformed = 0;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (!this.isValidRecord(parsed)) {
            malformed++;
            continue;
          }
          const mk = this.mapKey(parsed.scope, parsed.category, parsed.key);
          if (mk === dropKey) continue; // drop
          latest.set(mk, parsed); // last write wins (matches init())
        } catch {
          malformed++;
        }
      }
      if (malformed > 0) {
        console.warn(`[memory] compactDrop: skipped ${malformed} malformed line(s) from ${this.filePath}`);
      }
      const lines = [...latest.values()].map((r) => JSON.stringify(r));
      const data = lines.join("\n") + (lines.length > 0 ? "\n" : "");
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, data, "utf8");
      await this.rename(tmp, this.filePath);
    });
  }

  private async audit(action: string, mk: string, detail: string, rec: MemoryRecord): Promise<void> {
    if (!this.auditLogPath) return;
    const ts = new Date().toISOString();
    const trunc = rec.value.slice(0, 60).replace(/\s+/g, " ");
    const line = `${ts} ${action} ${mk} ${detail} "${trunc}"\n`;
    await this.rotateAuditIfNeeded();
    await fs.appendFile(this.auditLogPath, line, "utf8");
  }

  /** Head-truncate when over cap: keep the most recent half of lines. */
  private async rotateAuditIfNeeded(): Promise<void> {
    if (!this.auditLogPath) return;
    let st: import("node:fs").Stats;
    try {
      st = await fs.stat(this.auditLogPath);
    } catch {
      return; // no file yet
    }
    if (st.size <= this.auditLogMaxBytes) return;
    const text = await fs.readFile(this.auditLogPath, "utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const keep = lines.slice(Math.floor(lines.length / 2));
    await fs.writeFile(this.auditLogPath, keep.join("\n") + (keep.length > 0 ? "\n" : ""), "utf8");
  }
}
