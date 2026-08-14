// Pi memory extension entry point (Tier 3 wiring).
// Wires the memory store + injection pipeline into Pi's ExtensionAPI.
//
// Hooks:
//   session_start       -> store.init() (hydrate from disk, once per session)
//   before_agent_start  -> per-turn re-injection (F1 revised): re-read store, build the
//                          <memory-context> block, append it to the system prompt.
//                          Truncation logged on signature change (not every turn).
// Tool:
//   memory_remember     -> agent supplies key+value+provenance; system classifies +
//                          stores (with E1 secret scan, E2.1 downgrade, B2 write-guard).
//                          Save-visibility surfaces the stored category (post-downgrade).
//
// Store/audit location: ~/.pi/agent/memory/{store.jsonl,audit.log} (operator choice).
//
// Note: the Pi-runtime seam itself is environmental (not unit-testable in isolation);
// the pure injection pipeline (injection.ts) IS unit-tested. See test-injection.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as os from "node:os";
import { JsonlMemoryStore, SecretDetectedError } from "./store.ts";
import { classifyCategory } from "./classifier.ts";
import { normalizeKey } from "./normalizer.ts";
import type { Category } from "./schema.ts";
import { LockTimeoutError } from "./lock.ts";

const STORE_DIR = path.join(os.homedir(), ".pi", "agent", "memory");
const STORE_FILE = path.join(STORE_DIR, "store.jsonl");
const AUDIT_FILE = path.join(STORE_DIR, "audit.log");

const Params = Type.Object({
  key: Type.String({
    description:
      "Topic-based key, lowercase_underscore, 2-5 words (e.g. strict_no_any). " +
      "Topic-based (not wording-based) so it survives rewording and dedups across sessions.",
  }),
  value: Type.String({
    description: "The fact, constraint, decision, convention, or preference to remember.",
  }),
  provenance: Type.Union([Type.Literal("operator"), Type.Literal("inferred")]),
});

export default function (pi: ExtensionAPI) {
  const store = new JsonlMemoryStore({ filePath: STORE_FILE, auditLogPath: AUDIT_FILE });

  // session_start: hydrate the in-memory Map from disk (fires once per session init).
  pi.on("session_start", async () => {
    await store.init();
  });

  // before_agent_start re-injection moved to prompt-coordinator.ts (sole registrant). The
  // coordinator reads records via memory/reader.ts (pure disk read — safe across module
  // isolation; snapshot() here is cache-dependent and would be empty in the coordinator's copy).
  // store.init() below still runs so the memory_remember / memory_forget tools work this session.

  // memory_remember tool: system derives category (A2-prime); store enforces defenses.
  pi.registerTool({
    name: "memory_remember",
    label: "Remember",
    description:
      "Persist a fact/constraint/decision/convention/preference across sessions. " +
      "Save when: the operator states a hard rule (constraint), a choice is made (decision), " +
      "a project layout convention is noted, a preference is expressed, or a neutral fact is " +
      "discovered. Use TOPIC-based keys (e.g. 'strict_no_any', 'tests_location'), not " +
      "wording-based. Set provenance='operator' when the operator stated it; 'inferred' when " +
      "read from code/repo/web. Secrets are refused. Inferred facts cannot overwrite " +
      "operator facts. The system auto-classifies the category from the value.",
    parameters: Params,
    async execute(_toolCallId, params) {
      const category = classifyCategory(params.value);
      try {
        const outcome = await store.remember({
          schemaVersion: 1,
          scope: "global",
          category,
          key: params.key,
          value: params.value,
          provenance: params.provenance,
          turn: 0, // vestigial for v1; ranking uses recordedAt (cross-session)
          recordedAt: Date.now(),
        });

        if (outcome.action === "skipped_inferred_over_operator") {
          return {
            content: [{
              type: "text" as const,
              text: `Skipped: an operator record for '${params.key}' already exists; inferred overwrite refused.`,
            }],
            details: {},
          };
        }

        // Save-visibility (E2.3): surface the STORED category (post-downgrade) + provenance.
        const stored = outcome.record;
        const verb = outcome.action === "inserted" ? "Saved" : "Updated";
        return {
          content: [{
            type: "text" as const,
            text: `${verb}: [${stored.category}] ${stored.key} (${stored.provenance})`,
          }],
          details: {},
        };
      } catch (e) {
        if (e instanceof SecretDetectedError) {
          return {
            content: [{ type: "text" as const, text: `Rejected: ${e.message}` }],
            details: {},
          };
        }
        if (e instanceof LockTimeoutError) {
          return {
            content: [{ type: "text" as const, text: `Warning: memory store was locked by another writer for >10s; fact NOT saved. Retry, or check for a stale ${STORE_FILE}.lock.` }],
            details: {},
          };
        }
        throw e;
      }
    },
  });

  // memory_forget: remove a persisted fact by key (+ optional category). store.forget() existed
  // but was never exposed — facts had no agent-driven correction path (B6).
  pi.registerTool({
    name: "memory_forget",
    label: "Forget",
    description:
      "Remove a persisted fact/constraint/decision by key. Use to correct stale or wrong facts. " +
      "Category is optional — if omitted, ALL categories for that key are removed. " +
      "Read the category from the <memory-context> block when known (e.g. 'strict_no_any' may be [constraint]).",
    parameters: Type.Object({
      key: Type.String({ description: "Topic-based key to remove (e.g. strict_no_any)" }),
      category: Type.Optional(Type.String({ description: "Optional category (constraint/decision/convention/preference/fact). If omitted, removes across all categories." })),
    }),
    async execute(_toolCallId, params) {
      const scope = "global";
      const nk = normalizeKey(params.key);
      try {
        if (params.category) {
          const removed = await store.forget(scope, params.category as Category, nk);
          return { content: [{ type: "text" as const, text: removed ? `Forgot [${params.category}] ${nk}` : `No record found for [${params.category}] ${nk}` }], details: {} };
        }
        const records = await store.snapshot({ scopes: [scope] });
        const matches = records.filter((r) => r.key === nk);
        for (const r of matches) await store.forget(scope, r.category, nk);
        return { content: [{ type: "text" as const, text: matches.length ? `Forgot ${matches.length} record(s) for key ${nk}` : `No records found for key ${nk}` }], details: {} };
      } catch (e) {
        if (e instanceof LockTimeoutError) {
          return { content: [{ type: "text" as const, text: `Warning: memory store was locked by another writer for >10s; forget NOT completed. Retry, or check for a stale ${STORE_FILE}.lock.` }], details: {} };
        }
        throw e;
      }
    },
  });
}
