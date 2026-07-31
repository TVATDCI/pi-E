import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadChains, runChainByName, type Chain, type ChainOverrides, type ChainRunResult } from "./chain-runner.ts";
import { clarifyChain } from "./chain-clarify.ts";
import type { UsageStats, SpawnProgress } from "./orchestration-engine/spawn.ts";
import type { StepAcceptance } from "./acceptance.ts";
import { resolveBgStatus, formatBgToast, formatFleet, formatTranscript, type BgStatus } from "./background-helpers.ts";

interface StepState {
  name: string;
  status: "pending" | "running" | "done" | "error";
  output: string;
  elapsedMs: number;
  toolCount?: number;
  modelFlag?: string;
  thinkingLevel?: string;
  currentChunk?: string;
  accumulatedText?: string;
  usage?: UsageStats;
  acceptance?: StepAcceptance;
}

interface ChainState {
  id: number;
  chainName: string;
  status: "running" | "done" | "error";
  steps: StepState[];
  startedAt: number;
  elapsed: number;
  background?: boolean;
}

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_WIDGET_JOBS = 6;
const PROGRESSIVE_LIMIT = 3;
const MAX_BACKGROUND = 3; // Group 3: concurrency cap on background runs

const fmtTokens = (n?: number): string => {
  if (!n) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};
const fmtCost = (c?: number): string => {
  if (!c || c < 0.00005) return "";
  return `$${c.toFixed(c < 0.01 ? 4 : 3)}`;
};

export default function (pi: ExtensionAPI) {
  const chains = new Map<string, Chain>();
  let activeChainName = "";
  let widgetCtx: ExtensionContext | undefined;
  let nextId = 1;
  const running = new Map<number, ChainState>();
  // Group 3: per-job AbortController registry keyed by runId. Decouples background jobs from the
  // (turn-coupled) tool-call signal and backs /stop. Entry removed when the run settles.
  const bgRegistry = new Map<number, { controller: AbortController; stopped: boolean }>();
  let tick: ReturnType<typeof setInterval> | undefined;
  let frameIdx = 0;

  const refreshChains = (ctx: ExtensionContext) => {
    const loaded = loadChains(ctx);
    chains.clear();
    for (const [name, chain] of loaded.entries()) {
      chains.set(name, chain);
    }
    if (!activeChainName || !chains.has(activeChainName)) {
      activeChainName = [...loaded.keys()][0] ?? "";
    }
  };

  const render = () => {
    if (!widgetCtx?.hasUI) return;
    widgetCtx.ui.setWidget("chain", (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        const glyph = (status: StepState["status"]): string =>
          status === "running" ? RUNNING_FRAMES[frameIdx] : status === "done" ? "✓" : status === "error" ? "✗" : "○";
        const stepColor = (status: StepState["status"]) =>
          status === "running" ? "accent" : status === "done" ? "success" : status === "error" ? "error" : "muted";
        const provColor = (p: StepAcceptance["provenance"]) =>
          p === "verified" || p === "checked" ? "success" : p === "rejected" ? "error" : p === "claimed" ? "warning" : "dim";

        if (running.size === 0) {
          return activeChainName
            ? [theme.fg("muted", `chain: ${activeChainName}`)]
            : [theme.fg("muted", "chain: idle")];
        }

        // Group 3: split FOREGROUND vs BACKGROUND. Background jobs render as ONE compact dimmed
        // line and are EXCLUDED from MAX_WIDGET_JOBS so they don't collapse the foreground's rich line.
        const all = [...running.values()];
        const foreground = all.filter((c) => !c.background);
        const background = all.filter((c) => c.background);
        const bgLine = (): string | null => {
          const live = background.filter((c) => c.status === "running");
          if (live.length === 0) return null;
          return theme.fg("dim", `⟳ bg: ${live.length} running (${live[live.length - 1]!.chainName})`);
        };

        if (foreground.length === 0) {
          const bl = bgLine();
          return bl ? [truncateToWidth(bl, width)] : [theme.fg("muted", "chain: idle")];
        }

        // Foreground tier 1: narrow terminal OR too many FOREGROUND jobs → single-line summary.
        if (width < 60 || foreground.length > MAX_WIDGET_JOBS) {
          const runningN = foreground.filter((c) => c.status === "running").length;
          const cur = foreground.find((c) => c.status === "running");
          let line: string;
          if (cur) {
            const step = cur.steps.find((s) => s.status === "running");
            const idx = step ? cur.steps.indexOf(step) + 1 : 0;
            const stepPart = step && idx ? theme.fg("dim", ` · ${step.name} (${idx}/${cur.steps.length})`) : "";
            line = theme.fg("accent", `${glyph("running")} #${cur.id} ${cur.chainName}`) + stepPart + theme.fg("dim", ` · ${runningN} running`);
          } else {
            line = theme.fg("dim", `chain · ${runningN} running`);
          }
          const bl = bgLine();
          return bl ? [truncateToWidth(line, width), truncateToWidth(bl, width)] : [truncateToWidth(line, width)];
        }

        const rows: string[] = [];
        const show = foreground.length > PROGRESSIVE_LIMIT ? foreground.slice(0, PROGRESSIVE_LIMIT) : foreground;
        for (const c of show) {
          const color = c.status === "running" ? "accent" : c.status === "done" ? "success" : "error";
          const chainCost = c.steps.reduce((a, s) => a + (s.usage?.cost ?? 0), 0);
          rows.push(truncateToWidth(
            theme.fg(color, `${glyph(c.status)} #${c.id} ${c.chainName}`) +
            theme.fg("dim", ` · ${Math.round(c.elapsed / 1000)}s`) +
            (chainCost > 0 ? theme.fg("dim", ` · ${fmtCost(chainCost)}`) : ""),
            width,
          ));
          for (const s of c.steps) {
            const meta: string[] = [];
            if (s.modelFlag) {
              const slash = s.modelFlag.indexOf("/");
              meta.push(slash >= 0 ? s.modelFlag.slice(slash + 1) : s.modelFlag);
            }
            if (s.toolCount) meta.push(`${s.toolCount}🛠`);
            const tok = fmtTokens(s.usage?.contextTokens);
            if (tok) meta.push(`${tok} tok`);
            const cost = fmtCost(s.usage?.cost);
            if (cost) meta.push(cost);
            const metaStr = meta.length ? ` · ${meta.join(" · ")}` : "";
            const provTag = s.acceptance
              ? theme.fg(provColor(s.acceptance.provenance), ` · ${s.acceptance.provenance}`)
              : "";
            rows.push(truncateToWidth(theme.fg(stepColor(s.status), `  ${glyph(s.status)} ${s.name}${metaStr}`) + provTag, width));
            if (s.status === "running" && s.currentChunk && s.currentChunk.trim()) {
              rows.push(truncateToWidth(theme.fg("dim", `    ⎿ ${s.currentChunk.replace(/\s+/g, " ").trim()}`), width));
            }
          }
        }
        if (foreground.length > PROGRESSIVE_LIMIT) {
          const rest = foreground.slice(PROGRESSIVE_LIMIT);
          const rN = rest.filter((c) => c.status === "running").length;
          const dN = rest.filter((c) => c.status === "done").length;
          rows.push(theme.fg("dim", `+${rest.length} more (${rN} running, ${dN} done)`));
        }
        const bl = bgLine();
        if (bl) rows.push(truncateToWidth(bl, width));
        return rows;
      },
    }));
  };

  const startTick = () => {
    if (tick) return;
    tick = setInterval(() => {
      for (const c of running.values()) if (c.status === "running") c.elapsed = Date.now() - c.startedAt;
      frameIdx = (frameIdx + 1) % RUNNING_FRAMES.length;
      render();
    }, 180);
  };
  const stopTickIfIdle = () => {
    if (tick && ![...running.values()].some((c) => c.status === "running")) {
      clearInterval(tick); tick = undefined;
    }
  };

  // Shared widget+run core. opts.id lets a background caller pre-allocate the runId (so it can
  // register the controller before the async run starts); opts.background marks the chainState.
  const runWithWidget = async (
    ctx: ExtensionContext,
    chainName: string,
    task: string,
    cwd: string | undefined,
    returnAllSteps: boolean | undefined,
    signal: AbortSignal | undefined,
    overrides: ChainOverrides | undefined,
    opts?: { background?: boolean; id?: number },
    context?: string,
  ): Promise<ChainRunResult> => {
    widgetCtx = ctx;
    const chain = chains.get(chainName);
    const id = opts?.id ?? nextId++;
    const chainState: ChainState = {
      id,
      chainName,
      status: "running",
      steps: (chain?.steps ?? []).map((s) => ({ name: s.name, status: "pending" as const, output: "", elapsedMs: 0 })),
      startedAt: Date.now(),
      elapsed: 0,
      ...(opts?.background ? { background: true } : {}),
    };
    running.set(id, chainState); render(); startTick();

    const stepStatusMap = new Map<string, StepState>();
    for (const s of chainState.steps) stepStatusMap.set(s.name, s);

    const result = await runChainByName(
      pi, ctx, chainName, task, cwd, returnAllSteps,
      (name) => {
        const s = stepStatusMap.get(name);
        if (s) { s.status = "running"; render(); }
      },
      (name, r) => {
        const s = stepStatusMap.get(name);
        if (s) {
          s.status = r.code === 0 ? "done" : "error";
          s.output = r.output;
          s.elapsedMs = r.elapsedMs;
          s.toolCount = r.toolCount;
          s.modelFlag = r.modelFlag;
          s.thinkingLevel = r.thinkingLevel;
          if (r.usage) s.usage = r.usage;
          if (r.acceptance) s.acceptance = r.acceptance;
          render();
        }
      },
      (name: string, p: SpawnProgress) => {
        const s = stepStatusMap.get(name);
        if (!s) return;
        s.toolCount = p.toolCount;
        if (p.chunk) { s.currentChunk = p.chunk; s.accumulatedText = (s.accumulatedText ?? "") + p.chunk; }
        if (p.modelFlag) s.modelFlag = p.modelFlag;
      },
      signal,
      overrides,
      context,
    );

    chainState.status = result.ok ? "done" : "error";
    chainState.elapsed = Date.now() - chainState.startedAt;
    // Retention cap: evict oldest done/error foreground chains beyond 5 (bounds the StepState.output leak).
    if (chainState.status !== "running") {
      const settled = [...running.entries()].filter(([, c]) => c.status !== "running" && !c.background);
      if (settled.length > 5) { settled.sort((a, b) => a[1].startedAt - b[1].startedAt); for (let i = 0; i < settled.length - 5; i++) running.delete(settled[i]![0]); }
    }
    render(); stopTickIfIdle();
    return result;
  };

  // ── Group 3: background dispatch (in-parent) ──────────────────────────────────────────
  const bgToast = (ctx: ExtensionContext, chainName: string, status: BgStatus, durationMs: number, preview: string): void => {
    ctx.ui.notify(formatBgToast(chainName, status, durationMs, preview), status === "completed" ? "info" : "warning");
  };

  const onBgSettle = (
    ctx: ExtensionContext,
    id: number,
    chainName: string,
    result: ChainRunResult | undefined,
    threw: unknown,
  ): void => {
    const entry = bgRegistry.get(id);
    const stopped = entry?.stopped ?? false;
    const cs = running.get(id);
    const durationMs = cs?.elapsed ?? 0;
    bgRegistry.delete(id);
    running.delete(id); // background chain leaves the widget once settled (toast + log are the record)
    render();
    if (threw || !result) {
      bgToast(ctx, chainName, "failed", durationMs, `unexpected: ${String(threw).slice(0, 200)}`);
      pi.appendEntry("dispatch-log", { kind: "background-result", runId: id, chain: chainName, status: "failed", durationMs, error: String(threw).slice(0, 500) });
      return;
    }
    const status = resolveBgStatus(stopped, result.ok);
    const preview = (result.ok ? result.finalOutput : result.error?.output ?? "").slice(0, 600);
    bgToast(ctx, chainName, status, durationMs, preview);
    pi.appendEntry("dispatch-log", { kind: "background-result", runId: id, chain: chainName, status, durationMs, finalOutput: preview });
  };

  // Returns {runId} on accept, or {error:"cap"} when the concurrency cap is hit.
  const runBackground = (
    ctx: ExtensionContext,
    chainName: string,
    task: string,
    cwd: string | undefined,
    overrides: ChainOverrides | undefined,
  context?: string,
): { runId: number } | { error: "cap" } => {
    const activeBg = [...running.values()].filter((c) => c.background && c.status === "running").length;
    if (activeBg >= MAX_BACKGROUND) return { error: "cap" };
    const id = nextId++;
    const controller = new AbortController();
    bgRegistry.set(id, { controller, stopped: false });
    // controller.signal — NOT the tool-call signal (that is turn-coupled). Voided: returns immediately.
    void runWithWidget(ctx, chainName, task, cwd, false, controller.signal, overrides, { background: true, id }, context)
      .then((result) => onBgSettle(ctx, id, chainName, result, undefined))
      .catch((err) => onBgSettle(ctx, id, chainName, undefined, err));
    return { runId: id };
  };

  pi.on("session_start", async (_e, ctx) => {
    widgetCtx = ctx;
    refreshChains(ctx);
    if (activeChainName) ctx.ui.setStatus("chain", `chain: ${activeChainName}`);
    render();
  });

  pi.registerCommand("chain", {
    description: "Select active chain: /chain [name]",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      refreshChains(ctx);
      const requested = args.trim();
      if (!requested) {
        const active = activeChainName || "(none)";
        const list = [...chains.keys()].join(", ") || "(no chains loaded)";
        ctx.ui.notify(`Active chain: ${active}\nAvailable: ${list}`, "info");
        return;
      }
      if (!chains.has(requested)) {
        ctx.ui.notify(`Chain '${requested}' not found. Available: ${[...chains.keys()].join(", ")}`, "warning");
        return;
      }
      activeChainName = requested;
      ctx.ui.setStatus("chain", `chain: ${requested}`);
      ctx.ui.notify(`Active chain: ${requested}\n${chains.get(requested)!.description}`, "info");
    },
  });

  pi.registerCommand("chain-list", {
    description: "List all loaded chains and their steps",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      refreshChains(ctx);
      if (chains.size === 0) {
        ctx.ui.notify("No chains loaded", "warning");
        return;
      }
      const lines: string[] = [];
      for (const [name, chain] of chains.entries()) {
        lines.push(`${name}${activeChainName === name ? " (active)" : ""}: ${chain.description}`);
        for (const s of chain.steps) {
          lines.push(`  - ${s.name} → ${s.agent} (${s.category ?? chain.default_category ?? "unspecified-low"})`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("chain-clarify", {
    description: "Clarify-then-run a chain (TUI): /chain-clarify <chain> <task...>",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      refreshChains(ctx);
      if (ctx.mode !== "tui") { ctx.ui.notify("chain-clarify requires TUI mode.", "warning"); return; }
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const chainName = parts[0] ?? activeChainName;
      const task = parts.slice(1).join(" ");
      const chain = chains.get(chainName);
      if (!chain) { ctx.ui.notify(`Chain '${chainName}' not found. Available: ${[...chains.keys()].join(", ") || "(none)"}`, "warning"); return; }
      if (!task) { ctx.ui.notify("Usage: /chain-clarify <chain> <task...>", "warning"); return; }
      if (chain.steps.length === 0) { ctx.ui.notify(`Chain '${chainName}' has no steps.`, "warning"); return; }
      const clarified = await clarifyChain(ctx, chainName, chain, task);
      if (!clarified.confirmed) { ctx.ui.notify("Cancelled.", "info"); return; }
      const overrides: ChainOverrides = { ...(clarified.task ? { task: clarified.task } : {}), ...(clarified.steps ? { steps: clarified.steps } : {}) };
      const result = await runWithWidget(ctx, chainName, task, undefined, false, undefined, overrides);
      ctx.ui.notify(result.ok ? `[chain: ${chainName}] done` : `[chain: ${chainName}] failed at '${result.error?.step ?? "?"}'`, result.ok ? "info" : "error");
    },
  });

  pi.registerCommand("chain-status", {
    description: "Show all active + recent chain runs (foreground + background)",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      const lines = formatFleet([...running.values()]);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("chain-transcript", {
    description: "Tail a running chain's accumulated output: /chain-transcript <runId>",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw || !/^\d+$/.test(raw)) { ctx.ui.notify("Usage: /chain-transcript <runId>  (runId from /chain-status)", "warning"); return; }
      const id = Number(raw);
      const entry = running.get(id);
      if (!entry) { ctx.ui.notify(`No chain run #${id}. Use /chain-status to see active runs.`, "warning"); return; }
      const lines = formatTranscript(entry);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("stop", {
    description: "Stop a background chain run: /stop <runId>",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw || !/^\d+$/.test(raw)) { ctx.ui.notify("Usage: /stop <runId>  (runId from `run_chain({background:true})`)", "warning"); return; }
      const id = Number(raw);
      const entry = bgRegistry.get(id);
      if (!entry) { ctx.ui.notify(`No active background run #${id}.`, "warning"); return; }
      entry.stopped = true; // distinct from a natural failure
      entry.controller.abort(); // → SIGTERM via the existing spawn path
      ctx.ui.notify(`Stopping background run #${id}…`, "info");
    },
  });

  pi.registerTool({
    name: "run_chain",
    label: "Run Chain",
    description:
      "Execute a sequential agent pipeline from agent-chain.yaml. Each step dispatches to an agent; " +
      "output flows via $INPUT to the next step. $ORIGINAL is always the initial task. " +
      "Uses the active chain if no chain name is given.",
    parameters: Type.Object({
      task: Type.String({ description: "The initial task/prompt for the chain" }),
      chain: Type.Optional(Type.String({ description: "Chain name from agent-chain.yaml. Uses active chain if omitted." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for all chain steps. Defaults to the parent's cwd." })),
      returnAllSteps: Type.Optional(Type.Boolean({ description: "Return every step's output in the response text (default: false, only final step returned)." })),
      clarify: Type.Optional(Type.Boolean({ description: "If true, show a preview/edit overlay (task + per-step model/thinking/prompt) before running. TUI mode only; no-op otherwise. Esc/abort cancels with no spawn." })),
      background: Type.Optional(Type.Boolean({ description: "If true, run in the background (fire-and-forget): returns immediately with a runId, shows in the widget, notifies on completion. TUI mode only. /stop <runId> cancels. Max " + MAX_BACKGROUND + " concurrent." })),
      context: Type.Optional(Type.String({ description: "Handoff context — appended to every step's system prompt as '## Handoff Context'. Findings, constraints, prior decisions. Keep concise (truncated >2000 chars)." })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      widgetCtx = ctx;
      refreshChains(ctx);
      const chainName = params.chain ?? activeChainName;
      const chain = chainName ? chains.get(chainName) : undefined;
      if (!chain) {
        const available = [...chains.keys()].join(", ") || "(none)";
        return {
          content: [{ type: "text" as const, text: `Error: chain '${chainName || "(active)"}' not found. Available: ${available}` }],
          details: { error: "chain-not-found", available: [...chains.keys()] },
        };
      }
      if (chain.steps.length === 0) {
        return {
          content: [{ type: "text" as const, text: `Error: chain '${chainName}' has no steps.` }],
          details: { error: "chain-empty" },
        };
      }

      // Clarify BEFORE background (clarify is foreground-blocking; then background the resolved run).
      let overrides: ChainOverrides | undefined;
      if (params.clarify && ctx.mode === "tui") {
        const clarified = await clarifyChain(ctx, chainName, chain, params.task, signal);
        if (!clarified.confirmed) {
          return {
            content: [{ type: "text" as const, text: `Chain '${chainName}' cancelled in clarify (no steps ran).` }],
            details: { cancelled: true, chain: chainName },
          };
        }
        overrides = { ...(clarified.task ? { task: clarified.task } : {}), ...(clarified.steps ? { steps: clarified.steps } : {}) };
      }

      // Background (fire-and-forget). Returns immediately with a runId; completion → toast + dispatch-log.
      if (params.background && ctx.mode === "tui") {
        const bg = runBackground(ctx, chainName, params.task, params.cwd, overrides, params.context);
        if ("error" in bg) {
          return {
            content: [{ type: "text" as const, text: `Background cap reached (${MAX_BACKGROUND} concurrent). Wait for one to finish or /stop one, then retry.` }],
            details: { error: "background-cap", cap: MAX_BACKGROUND },
          };
        }
        return {
          content: [{ type: "text" as const, text: `Backgrounded chain '${chainName}' — runId #${bg.runId}. You'll be notified when it completes. Cancel with: /stop ${bg.runId}` }],
          details: { background: true, runId: bg.runId, chain: chainName },
        };
      }

      const result = await runWithWidget(ctx, chainName, params.task, params.cwd, params.returnAllSteps, signal, overrides, undefined, params.context);

      if (!result.ok) {
        const trimmed = result.error?.output && result.error.output.length > 3000
          ? result.error.output.slice(0, 3000) + "\n...[truncated]"
          : result.error?.output ?? "";
        return {
          content: [{ type: "text" as const, text: `Chain '${chainName}' failed at step '${result.error?.step ?? "unknown"}':\n\n${trimmed}` }],
          details: { error: "step-failed", chain: chainName, step: result.error?.step ?? "unknown", stepResults: result.stepResults },
        };
      }

      const trimmed = result.finalOutput.length > 6000 ? result.finalOutput.slice(0, 6000) + "\n...[truncated]" : result.finalOutput;
      return {
        content: [{ type: "text" as const, text: `[chain: ${chainName}] done\n\n${trimmed}` }],
        details: { chain: chainName, stepResults: result.stepResults },
      };
    },
  });
}
