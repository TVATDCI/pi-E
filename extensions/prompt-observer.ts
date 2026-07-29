// prompt-observer.ts — D1 OBSERVER (partial-revert v1.3).
// Hooks `agent_start` (fires AFTER `emitBeforeAgentStart` finalizes the prompt —
// agent-session.js:898-916) and hashes `ctx.getSystemPrompt()` = the finalized composed
// prompt (runner.js:522 → agent-session.js:1922 `() => this.systemPrompt`). This observes
// the EVENT CHAIN's OUTPUT, order-independent — no registry, no flusher, no module-
// isolation dependency. Logs `prompt-composition {hash, known, drift}`; warns + flags
// drift when the hash isn't in the known-good set.
//
// Defensive: if ctx.getSystemPrompt is unavailable/empty in a future pi version, the
// observer no-ops (never crashes a turn over observability).
//
// Background (the failed mechanism this replaces): planning/improvement-plan-v1.md §D1
// (v1.2: live-verified failure via `pi_extension_module_isolation`).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hashPrompt, isKnownGood } from "./lib/prompt-hash.ts";

export default function (pi: ExtensionAPI) {
  let lastHash = "";

  pi.on("agent_start", async (_event, ctx) => {
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
        `⚠ prompt drift: composed-prompt hash ${hash} not in known-good set — ` +
          `intended? (add to KNOWN_GOOD_HASHES in lib/prompt-hash.ts) or investigate. See /routing-stats.`,
        "warning",
      );
    }
  });
}
