// JsonlMemoryStore (Fork D, Option C write-through) + write-boundary defenses.
//
// Architecture:
//   - In-memory Map<string, MemoryRecord> keyed by "scope:category:key", hydrated at init().
//   - JSONL file on disk; every mutating op updates the Map THEN flushes (write-through).
//   - Flush is atomic: write to `${path}.tmp`, then fs.rename (crash leaves complete-old or
//     complete-new, never a corrupt hybrid).
//   - close() is a true no-op (nothing buffered).
//
// Write pipeline (remember()) enforces defenses at the storage boundary:
//   E1  secret scan -> throw SecretDetectedError (refuse + surface)
//   E2.1 inferred + constraint -> downgrade to fact (defense-in-depth)
//   B2  provenance write-guard: inferred cannot overwrite operator (asymmetric)
//
// DI seam: `rename` is injectable so the rename-failure test can force a throw
// (no vitest/vi.mock available in this environment).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Category, MemoryRecord, Scope } from "./schema.ts";
import { scanSecrets } from "./scanner.ts";
import { normalizeKey } from "./normalizer.ts";

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
  /** DI seam: override fs.rename for the rename-failure test. Defaults to fs.rename. */
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

  /** Hydrate the Map from the JSONL file. Missing file = empty store (no throw).
   *  Malformed lines are skipped + warned (Momus M4): one truncated line must not unload the store. */
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
    // E1: secret scan at the write boundary (refuse + surface).
    const scan = scanSecrets(incoming.value);
    if (scan.detected) {
      throw new SecretDetectedError(scan.pattern ?? "unknown");
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

    // B2: provenance write-guard (asymmetric). inferred cannot overwrite operator.
    const existing = this.map.get(mk);
    if (existing && existing.provenance === "operator" && finalRecord.provenance === "inferred") {
      await this.audit("SKIP", mk, "inferred-over-operator", existing);
      return { action: "skipped_inferred_over_operator", existing };
    }

    this.map.set(mk, finalRecord);
    await this.flush();

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

  /** Hard delete. Returns whether a record was removed. */
  async forget(scope: Scope, category: Category, key: string): Promise<boolean> {
    const mk = this.mapKey(scope, category, normalizeKey(key));
    const existed = this.map.delete(mk);
    if (existed) {
      await this.flush();
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

  /** Write-through: nothing buffered. True no-op. */
  async close(): Promise<void> {}

  /** Serialize the Map to JSONL via atomic rename (tmp -> real). */
  private async flush(): Promise<void> {
    const lines = [...this.map.values()].map((r) => JSON.stringify(r));
    const data = lines.join("\n") + (lines.length > 0 ? "\n" : "");
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, data, "utf8");
    await this.rename(tmp, this.filePath);
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
