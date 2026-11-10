// prompt-observer.ts — D1 OBSERVER (v2 — ext-drift-tripwire ruling 2026-11-10, pick (b)).
// Hooks `agent_start` (fires AFTER `emitBeforeAgentStart` finalizes the prompt —
// agent-session.js:898-916) and hashes `ctx.getSystemPrompt()` = the finalized composed
// prompt. Since v2 the hash covers ONLY extension-owned regions (see lib/prompt-hash.ts):
// the <extension-owned> wrapper prompt-coordinator emits, plus registry-tagged regions
// (<hazard-tripwire>). pi's base prompt and per-project <project_instructions> content
// are out by construction — opening the agent in a different project no longer trips.
// Logs `prompt-composition {hash, known, drift}`; warns + flags drift when the hash
// isn't in the known-good set.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hashPrompt, isKnownGood } from "./lib/prompt-hash.ts";

export default function (pi: ExtensionAPI) {
  let lastHash = "";

  pi.on("agent_start", async (event, ctx) => {
    // Machine-triggered runs (pi.sendMessage triggerTurn) fire this hook with a non-"user"
    // messageType; prompt-coordinator skips them, so their prompt carries no
    // <extension-owned> wrapper and would false-trip as lost scaffolding. Hash only
    // operator-turn compositions — the turns the coordinator composes for. 1.1.0's types
    // don't declare messageType — narrow cast, no-op there (same pattern as the coordinator).
    const messageType = (event as { messageType?: string }).messageType;
    if (messageType && messageType !== "user") return;

    // Read the FINALIZED composed prompt. agent_start fires post-composition, so this is
    // the event chain's full output regardless of contributor order or load order.
    let prompt: string | undefined;
    try {
      prompt = ctx.getSystemPrompt?.();
    } catch {
      // getSystemPrompt unavailable in this pi version — skip gracefully.
      return;
    }
    if (!prompt || prompt.length === 0) return;

    const hash = hashPrompt(prompt);
    if (hash === lastHash) return; // stable this session — no per-turn log spam
    lastHash = hash;

    const known = isKnownGood(hash);
    const drift = !known;
    try {
      pi.appendEntry("prompt-composition", { hash, known, drift });
    } catch {
      /* observability is best-effort */
    }

    if (drift && ctx.hasUI) {
      ctx.ui.notify(
        `⚠ extension-owned prompt drift: extension-sections hash ${hash} not in known-good set — ` +
          `intended? (add to KNOWN_GOOD_HASHES in lib/prompt-hash.ts) or investigate. See /routing-stats.`,
        "warning",
      );
    }
  });
}
