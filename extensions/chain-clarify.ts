// extensions/chain-clarify.ts — clarify-before-launch TUI for chain runs (Group 1D/1E).
//
// INVARIANTS (Oracle GO-WITH-CHANGES; ABSORPTION-PLAN.md §2):
//  1. ONE ctx.ui.custom() per interaction. Pickers are internal `editMode` sub-modes
//     ("list" | "model" | "thinking") — NEVER a nested custom(). `done()` fires exactly once.
//  2. Task/prompt editing uses an EXIT-REOPEN pattern: pressing e/p resolves the custom() with an
//     `edit` signal; clarifyChain() then opens ctx.ui.editor() while NO overlay is alive (clean
//     layering — editor renders on top, not behind) and re-opens custom() with the edit applied.
//     This is more robust than setHidden choreography (which did not reliably hide the overlay).
//  3. Abort-safe: signal.abort() ⇒ done({confirmed:false}) once; guarded; listener removed.
// Editable: task ($ORIGINAL), per-step model, per-step thinking, per-step prompt (raw, pre-sub).
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager, ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveModel, type TaskCategory } from "./orchestration-engine/tier-map.ts";
import type { Chain, ChainStepOverride } from "./chain-runner.ts";

export interface ChainClarifyEdit {
  kind: "task" | "prompt";
  stepName?: string;
}

export interface ChainClarifyResult {
  confirmed: boolean;
  /** Set when the operator pressed e/p: the caller should open ctx.ui.editor() and re-open. */
  edit?: ChainClarifyEdit;
  /** Current task/overrides — carried across the edit-reopen loop. */
  task?: string;
  steps?: Record<string, ChainStepOverride>;
}

type EditMode = "list" | "model" | "thinking";
const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

interface ModelEntry {
  value: string; // provider/id
  label: string; // id
  description: string; // provider
}

/**
 * Single Component owning one clarify interaction. Constructed inside ctx.ui.custom(); render()
 * switches on editMode; handleInput() dispatches by mode. Task/prompt edits EXIT (resolve done
 * with an `edit` signal) so the caller can open the editor with no overlay alive — see
 * clarifyChain() for the reopen loop.
 */
export class ChainClarifyComponent implements Component {
  readonly width = 84;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (r: ChainClarifyResult) => void;
  private readonly ctx: ExtensionContext;
  private readonly chainName: string;
  private readonly chain: Chain;
  private readonly initialTask: string;
  private readonly signal?: AbortSignal;
  private readonly availableModels: ModelEntry[];

  private editMode: EditMode = "list";
  private selectedStep = 0;
  private task: string;
  private stepOverrides: Record<string, ChainStepOverride>;
  private notice?: string;
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private settled = false;

  // picker sub-mode state
  private pickerKind: "model" | "thinking" = "model";
  private pickerItems: string[] = [];
  private pickerLabels: string[] = [];
  private pickerIndex = 0;

  private readonly onAbort = (): void => this.finish({ confirmed: false });

  constructor(
    tui: TUI,
    theme: Theme,
    _kb: KeybindingsManager,
    done: (r: ChainClarifyResult) => void,
    ctx: ExtensionContext,
    chainName: string,
    chain: Chain,
    task: string,
    initialSteps: Record<string, ChainStepOverride>,
    signal?: AbortSignal,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.ctx = ctx;
    this.chainName = chainName;
    this.chain = chain;
    this.initialTask = task;
    this.task = task;
    this.stepOverrides = { ...initialSteps };
    this.signal = signal;
    const avail = (ctx.modelRegistry.getAvailable?.() ?? []) as Array<{ provider: string; id: string }>;
    this.availableModels = avail.map((m) => ({ value: `${m.provider}/${m.id}`, label: m.id, description: m.provider }));
    if (signal) {
      if (signal.aborted) queueMicrotask(() => this.finish({ confirmed: false }));
      else signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  invalidate(): void {
    /* state is read live from fields on each render */
  }

  dispose(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  private finish(r: { confirmed: boolean; edit?: ChainClarifyEdit }): void {
    if (this.settled) return;
    this.settled = true;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.signal?.removeEventListener("abort", this.onAbort);
    this.done({
      confirmed: r.confirmed,
      ...(r.edit ? { edit: r.edit } : {}),
      task: this.task,
      steps: Object.keys(this.stepOverrides).length ? this.stepOverrides : undefined,
    });
  }

  private flash(msg: string): void {
    this.notice = msg;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = undefined;
      this.tui.requestRender();
    }, 1500);
    this.tui.requestRender();
  }

  private resolvedModelForStep(i: number): string {
    const step = this.chain.steps[i];
    if (!step) return "";
    const ov = this.stepOverrides[step.name]?.model;
    if (ov) return ov;
    const cat = (step.category ?? this.chain.default_category ?? "unspecified-low") as TaskCategory;
    try {
      return resolveModel(cat, this.ctx.modelRegistry).modelFlag;
    } catch {
      return String(cat);
    }
  }

  // --- input ---

  handleInput(data: string): void {
    if (this.editMode === "list") this.handleList(data);
    else this.handlePicker(data);
  }

  private handleList(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.finish({ confirmed: false });
      return;
    }
    if (matchesKey(data, "return")) {
      this.finish({ confirmed: true });
      return;
    }
    if (matchesKey(data, "up")) {
      this.selectedStep = (this.selectedStep - 1 + this.chain.steps.length) % this.chain.steps.length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selectedStep = (this.selectedStep + 1) % this.chain.steps.length;
      this.tui.requestRender();
      return;
    }
    if (data === "e") {
      // EXIT → caller opens the task editor with no overlay alive, then re-opens.
      this.finish({ confirmed: false, edit: { kind: "task" } });
      return;
    }
    if (data === "p") {
      const step = this.chain.steps[this.selectedStep];
      if (step) this.finish({ confirmed: false, edit: { kind: "prompt", stepName: step.name } });
      return;
    }
    if (data === "m") {
      this.enterModelPicker();
      return;
    }
    if (data === "t") {
      this.enterThinkingPicker();
      return;
    }
  }

  private handlePicker(data: string): void {
    if (matchesKey(data, "escape")) {
      this.editMode = "list";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.pickerIndex = (this.pickerIndex - 1 + this.pickerItems.length) % this.pickerItems.length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.pickerIndex = (this.pickerIndex + 1) % this.pickerItems.length;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "return")) {
      this.applyPicker();
      return;
    }
  }

  // --- pickers (internal sub-modes; NO nested custom()) ---

  private enterModelPicker(): void {
    const step = this.chain.steps[this.selectedStep];
    if (!step) return;
    if (!this.availableModels.length) {
      this.flash("no models available");
      return;
    }
    this.pickerKind = "model";
    this.pickerItems = this.availableModels.map((m) => m.value);
    this.pickerLabels = this.availableModels.map((m) => `${m.label} (${m.description})`);
    this.pickerIndex = Math.max(0, this.pickerItems.indexOf(this.resolvedModelForStep(this.selectedStep)));
    this.editMode = "model";
    this.tui.requestRender();
  }

  private enterThinkingPicker(): void {
    const step = this.chain.steps[this.selectedStep];
    if (!step) return;
    this.pickerKind = "thinking";
    this.pickerItems = [...THINKING_LEVELS];
    this.pickerLabels = [...THINKING_LEVELS];
    const cur = this.stepOverrides[step.name]?.thinking ?? "off";
    this.pickerIndex = Math.max(0, this.pickerItems.indexOf(cur));
    this.editMode = "thinking";
    this.tui.requestRender();
  }

  private applyPicker(): void {
    const step = this.chain.steps[this.selectedStep];
    const value = this.pickerItems[this.pickerIndex];
    this.editMode = "list";
    if (!step || value === undefined) {
      this.tui.requestRender();
      return;
    }
    const ov: ChainStepOverride = { ...(this.stepOverrides[step.name] ?? {}) };
    if (this.pickerKind === "model") ov.model = value;
    else ov.thinking = value;
    this.stepOverrides[step.name] = ov;
    this.flash(`${this.pickerKind} → ${value}`);
  }

  // --- render ---

  render(width: number): string[] {
    const w = Math.min(this.width, Math.max(40, width));
    return this.editMode === "list" ? this.renderList(w) : this.renderPicker(w);
  }

  private renderList(w: number): string[] {
    const rows: string[] = [];
    rows.push(this.header(`clarify · ${this.chainName}`));
    if (this.chain.description) rows.push(this.row(this.theme.fg("dim", this.chain.description)));
    rows.push(this.row(""));
    rows.push(this.row(this.theme.fg("accent", "task ($ORIGINAL):")));
    const taskLines = this.task.split("\n");
    for (const line of taskLines.slice(0, 3)) rows.push(this.row(this.theme.fg("text", line || " ")));
    if (taskLines.length > 3) rows.push(this.row(this.theme.fg("dim", `  … (+${taskLines.length - 3} lines)`)));
    rows.push(this.row(""));
    this.chain.steps.forEach((step, i) => {
      const sel = i === this.selectedStep;
      const ov = this.stepOverrides[step.name];
      const model = this.resolvedModelForStep(i);
      const flags: string[] = [];
      if (ov?.model) flags.push("model");
      if (ov?.thinking) flags.push("thinking");
      if (ov?.prompt) flags.push("prompt");
      const flagStr = flags.length ? this.theme.fg("warning", ` [edited: ${flags.join(",")}]`) : "";
      const cat = step.category ?? this.chain.default_category ?? "?";
      const head = `${sel ? "▸ " : "  "}${step.agent} · ${cat} · ${model}${flagStr}`;
      rows.push(this.row(sel ? this.theme.fg("accent", head) : head));
      const firstLine = ((ov?.prompt ?? step.prompt).split("\n")[0] ?? "").slice(0, w - 6);
      rows.push(this.row(this.theme.fg("dim", `    ${firstLine || "(empty)"}`)));
    });
    if (this.notice) rows.push(this.row(this.theme.fg("warning", this.notice)));
    rows.push(this.footer("↵ run · Esc cancel · ↑↓ nav · e task · p prompt · m model · t thinking"));
    return rows;
  }

  private renderPicker(w: number): string[] {
    const rows: string[] = [];
    const step = this.chain.steps[this.selectedStep];
    rows.push(this.header(`${this.pickerKind}: ${step?.name ?? ""}`));
    rows.push(this.row(this.theme.fg("dim", "↑↓ nav · ↵ select · Esc back")));
    rows.push(this.row(""));
    const cur = this.pickerKind === "model"
      ? this.resolvedModelForStep(this.selectedStep)
      : (this.stepOverrides[step?.name ?? ""]?.thinking ?? "off");
    const max = 10;
    const start = Math.max(0, Math.min(this.pickerIndex - Math.floor(max / 2), Math.max(0, this.pickerItems.length - max)));
    const end = Math.min(start + max, this.pickerItems.length);
    for (let i = start; i < end; i++) {
      const sel = i === this.pickerIndex;
      const label = this.pickerLabels[i] ?? this.pickerItems[i] ?? "";
      const marker = this.pickerItems[i] === cur ? this.theme.fg("success", "  •current") : "";
      const body = `${sel ? "→ " : "  "}${label}${marker}`;
      rows.push(this.row(sel ? this.theme.fg("accent", body) : body));
    }
    if (this.notice) rows.push(this.row(this.theme.fg("warning", this.notice)));
    rows.push(this.footer(`${this.pickerKind} picker`));
    return rows;
  }

  // --- border helpers (self-contained; no DynamicBorder dependency) ---

  private pad(s: string, inner: number): string {
    const p = Math.max(0, inner - visibleWidth(s));
    return s + " ".repeat(p);
  }

  private row(content: string): string {
    const inner = this.width - 2;
    return this.theme.fg("border", "│") + truncateToWidth(this.pad(content, inner), inner) + this.theme.fg("border", "│");
  }

  private header(title: string): string {
    const inner = this.width - 2;
    const pad = Math.max(0, inner - visibleWidth(title));
    const left = Math.floor(pad / 2);
    return this.theme.fg("border", "╭" + "─".repeat(left)) + this.theme.fg("accent", title) + this.theme.fg("border", "─".repeat(pad - left) + "╮");
  }

  private footer(text: string): string {
    const inner = this.width - 2;
    const pad = Math.max(0, inner - visibleWidth(text));
    const left = Math.floor(pad / 2);
    return this.theme.fg("border", "╰" + "─".repeat(left)) + this.theme.fg("dim", text) + this.theme.fg("border", "─".repeat(pad - left) + "╯");
  }
}

/**
 * Open the clarify overlay and loop through task/prompt edits (exit-reopen: the editor opens only
 * while no overlay is alive, so it always renders on top). Returns {confirmed:true, task?, steps?}
 * on run, or {confirmed:false} on cancel/abort. Caller gates on ctx.mode === "tui" first.
 * Shared by the run_chain tool and the /chain-clarify slash command.
 */
export async function clarifyChain(
  ctx: ExtensionContext,
  chainName: string,
  chain: Chain,
  task: string,
  signal?: AbortSignal,
): Promise<ChainClarifyResult> {
  let curTask = task;
  let curSteps: Record<string, ChainStepOverride> = {};
  for (let i = 0; i < 100; i++) {
    const r = await ctx.ui.custom<ChainClarifyResult>(
      (tui, theme, kb, done) =>
        new ChainClarifyComponent(tui, theme, kb, done, ctx, chainName, chain, curTask, curSteps, signal),
      { overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
    );
    if (r.confirmed) return { confirmed: true, task: r.task, steps: r.steps };
    if (!r.edit) return { confirmed: false }; // plain cancel/abort
    // edit requested — open editor with NO overlay alive (clean layering), then loop to re-open.
    const stepName = r.edit.stepName;
    const prefill =
      r.edit.kind === "task"
        ? curTask
        : (curSteps[stepName ?? ""]?.prompt ?? chain.steps.find((s) => s.name === stepName)?.prompt ?? "");
    const title =
      r.edit.kind === "task"
        ? "Task ($ORIGINAL for all steps)"
        : `Prompt: ${stepName ?? ""} (raw; $INPUT/$ORIGINAL substituted at run)`;
    const edited = await ctx.ui.editor(title, prefill);
    if (edited !== undefined) {
      if (r.edit.kind === "task") curTask = edited;
      else if (stepName) curSteps[stepName] = { ...(curSteps[stepName] ?? {}), prompt: edited };
    }
  }
  return { confirmed: false };
}

// Library module (imported by agent-chain.ts); empty default factory satisfies pi's extension
// loader, which scans extensions/*.ts for a default export (same pattern as chain-runner/acceptance).
export default function (_pi: ExtensionAPI) {}
