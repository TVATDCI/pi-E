// upstream-adapter.ts — D6: shim for the pi-runtime surfaces that have broken across
// minor bumps. Callers depend on THIS local type, not the upstream type, for these seams.
// Growth policy (v1.1 probe-5): translate-only; >maxSurfaces distinct surfaces OR
// >maxLocPerSurface LOC/surface OR version-detecting across >maxConcurrentRuntimeVersions
// ⇒ FORK (pin the runtime version / propose the contract upstream). Fold-back review:
// 3rd surface added, quarterly, or per minor bump (if upstream stabilized across 2 minors
// → delete the shim branch). planning/improvement-plan-v1.md §D6 (+v1.1 probe-5).
//
// The two surfaces that actually broke (cited from source):
//   1. input.source — 0.79.9→0.80.x: a self-sent sendMessage({triggerTurn}) now fires
//      `input` with source="extension" (was: human-only). mini-task-tracker filters on
//      source==="interactive" to avoid an infinite nudge loop. ← SHIMMED HERE.
//   2. ctx.ui.confirm/select/custom during tool_call preflight — 0.80.3: confirm did NOT
//      render; mini-damage-control switched to a CUSTOM overlay (SafetyConfirmDialog).
//      That dialog is FEATURE-SPECIFIC — it stays in mini-damage-control, NOT here
//      (type-discipline: the adapter only TRANSLATES, never reimplements a component).
//      So the confirm path is NOT shimmed; only probed (probeDialogApi) for visibility.

export interface InputEvent {
  source?: string;
}

/**
 * True only for a genuine human prompt. The 0.79.9→0.80.x semantics live HERE — if a
 * future bump changes the human-prompt marker again, this is the single edit site.
 */
export function isHumanTurn(event: InputEvent): boolean {
  return event.source === "interactive";
}

export interface DialogApiSlice {
  hasUI?: boolean;
  ui: {
    confirm?: unknown;
    select?: unknown;
    custom?: unknown;
    input?: unknown;
  };
}

export interface DialogApiProbe {
  hasUI: boolean;
  hasConfirm: boolean;
  hasSelect: boolean;
  hasCustom: boolean;
  hasInput: boolean;
}

/**
 * Feature-probe the dialog API once (for startup logging — makes a bump that silently
 * drops a method audible). Does NOT decide correctness; callers still use the proven path
 * (e.g. mini-damage-control's custom overlay during preflight).
 */
export function probeDialogApi(ctx: DialogApiSlice): DialogApiProbe {
  const ui = ctx.ui ?? {};
  return {
    hasUI: ctx.hasUI === true,
    hasConfirm: typeof ui.confirm === "function",
    hasSelect: typeof ui.select === "function",
    hasCustom: typeof ui.custom === "function",
    hasInput: typeof ui.input === "function",
  };
}

// Growth-policy guard (D6 v1.1 probe-5). Breaching any ⇒ this is a fork, not a shim.
// An enforcement test asserts the adapter file stays under its LOC budget (see test).
export const ADAPTER_FORK_THRESHOLDS = {
  maxSurfaces: 5,
  maxLocPerSurface: 50,
  maxConcurrentRuntimeVersions: 2,
} as const;
