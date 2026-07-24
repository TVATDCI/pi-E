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
import { buildInjection } from "./injection.ts";

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

  // before_agent_start: per-turn re-injection (F1). Re-read the store every turn so
  // mid-session writes (turn N) surface at turn N+1, same session.
  let lastKeptSignature = "";
  pi.on("before_agent_start", async (event) => {
    const records = await store.snapshot({ scopes: ["global"] });
    const result = buildInjection(records);
    if (result.block === "") return; // empty store -> no injection

    // Truncation log on signature change (not every turn) to avoid log spam.
    const signature = result.kept.map((r) => r.key).join(",");
    if (result.cutCount > 0 && signature !== lastKeptSignature) {
      const cutKeys = result.cut.map((r) => r.key).join(", ");
      console.warn(
        `[memory] truncation: kept ${result.keptCount}, cut ${result.cutCount} (${cutKeys})`,
      );
      lastKeptSignature = signature;
    }

    return { systemPrompt: event.systemPrompt + "\n\n" + result.block };
  });

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
        throw e;
      }
    },
  });
}
