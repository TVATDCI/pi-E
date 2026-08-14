// mini-purpose-gate — widget + prompt augmentation + input gate + /purpose command.
// HARDENED (2026-07-07): the original `while(!purpose)` inescapable dialog loop DEADLOCKED
// after /reload. Root cause: when ctx.ui.input stale-no-ops after a bad /reload (the same
// dialog-stale-load class proven for select/confirm), the loop spun forever while the
// input-gate blocked all chat → only /quit recovered. Fix (deadlock-free by construction):
//   1. promptOnce — a SINGLE non-looped prompt (no infinite loop on dialog failure).
//   2. /purpose command — reliable setter that BYPASSES the input-gate (commands aren't
//      user messages), so it works even when dialogs are broken. Escape hatch.
//   3. Persistence — purpose stored via appendEntry + reconstructed on session_start, so
//      /reload restores it WITHOUT re-prompting (mirrors mini-task-tracker's reconstruct).
// API grounded in Pi extensions.md (appendEntry §1404, registerCommand §1457) +
// disler/pi-vs-claude-code purpose-gate.ts. LR-0017 hasUI guards retained for print mode.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * Pure reader for the latest session purpose. Reads ctx.sessionManager fresh each call (not the
 * module-scope `purpose` closure var), so it is safe to import across pi's per-extension module
 * isolation — the coordinator calls this every turn. Returns undefined if no purpose is set.
 * Mirrors reconstruct()'s scan (newest-first, latest wins).
 */
export function readPurpose(ctx: ExtensionContext): string | undefined {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as {
        type?: string;
        customType?: string;
        data?: { text?: string | null };
      };
      if (e.type === "custom" && e.customType === "purpose" && e.data) {
        return e.data.text ?? undefined; // latest wins (scanned newest-first)
      }
    }
  } catch {
    /* best-effort; no purpose recoverable */
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let purpose: string | undefined;

  // --- WIDGET: show purpose persistently below the editor ---
  function renderWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("purpose", (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const label = theme.fg("accent", "  PURPOSE: ");
        const msg = "\x1b[38;2;255;126;219m" + (purpose ?? "(not set)") + "\x1b[39m";
        return [truncateToWidth(label + msg, width)];
      },
    }));
  }

  // --- STATE COMMIT: set/clear purpose + persist for /reload reconstruct ---
  function commitPurpose(text: string | undefined, ctx: ExtensionContext) {
    purpose = text && text.trim() ? text.trim() : undefined;
    renderWidget(ctx);
    try {
      pi.appendEntry("purpose", { text: purpose ?? null });
    } catch {
      /* appendEntry best-effort; persistence is non-fatal */
    }
  }

  // --- RECONSTRUCT: restore the latest purpose from the session (survives /reload) ---
  // Delegates to the pure readPurpose() (shared with prompt-coordinator.ts) — DRY, no drift.
  function reconstruct(ctx: ExtensionContext) {
    purpose = readPurpose(ctx);
  }

  // --- SINGLE PROMPT (non-looped): if input stale-no-ops or is cancelled, do NOT loop ---
  async function promptOnce(ctx: ExtensionContext) {
    const answer = await ctx.ui.input(
      "What is the purpose of this agent?",
      "e.g. Refactor the auth module to use JWT",
    );
    if (answer && answer.trim()) {
      commitPurpose(answer, ctx);
      ctx.ui.notify(`Purpose set: ${purpose}`, "info");
    } else {
      // No loop — point the user at the reliable escape hatch.
      ctx.ui.notify("Purpose not set. Use /purpose <text> to set it.", "warning");
    }
  }

  // --- /purpose COMMAND: reliable setter (bypasses input-gate; works when dialogs break) ---
  pi.registerCommand("purpose", {
    description: "Set/show/clear the session purpose:  /purpose <text>  |  /purpose  |  /purpose clear",
    handler: async (args, ctx) => {
      const a = args.trim();
      if (!a) {
        ctx.ui.notify(`Purpose: ${purpose ?? "(not set)"}`, "info");
        return;
      }
      if (a.toLowerCase() === "clear") {
        commitPurpose(undefined, ctx);
        ctx.ui.notify("Purpose cleared.", "info");
        return;
      }
      commitPurpose(a, ctx);
      ctx.ui.notify(`Purpose set: ${purpose}`, "info");
    },
  });

  // 1. SESSION_START: reconstruct (so /reload doesn't re-prompt) → render → single prompt if still unset
  pi.on("session_start", async (_event, ctx) => {
    reconstruct(ctx);
    renderWidget(ctx);
    // LR-0017: guard dialogs in print mode. Single prompt only if interactive AND no purpose yet.
    if (ctx.hasUI && !purpose) void promptOnce(ctx);
  });

  // 2. PROMPT AUGMENTATION moved to prompt-coordinator.ts (sole before_agent_start registrant).
  //    readPurpose(ctx) above is the pure export the coordinator calls each turn.

  // 3. INPUT GATE: block prompts until a purpose is set. Points to /purpose (reliable setter).
  // LR-0017: in print mode there's no user to set a purpose → bypass (avoid swallowing every prompt).
  pi.on("input", async (_event, ctx) => {
    if (!ctx.hasUI) return { action: "continue" as const };
    if (!purpose) {
      ctx.ui.notify("Set a purpose first: /purpose <text>", "warning");
      return { action: "handled" as const };
    }
    return { action: "continue" as const };
  });
}
