import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadChains, runChainByName, type Chain } from "./chain-runner.ts";

interface StepState {
  name: string;
  status: "pending" | "running" | "done" | "error";
  output: string;
  elapsedMs: number;
}

interface ChainState {
  id: number;
  chainName: string;
  status: "running" | "done" | "error";
  steps: StepState[];
  startedAt: number;
  elapsed: number;
}

export default function (pi: ExtensionAPI) {
  const chains = new Map<string, Chain>();
  let activeChainName = "";
  let widgetCtx: ExtensionContext | undefined;
  let nextId = 1;
  const running = new Map<number, ChainState>();
  let tick: ReturnType<typeof setInterval> | undefined;

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
        if (running.size === 0) {
          return activeChainName
            ? [theme.fg("muted", `chain: ${activeChainName}`)]
            : [theme.fg("muted", "chain: idle")];
        }
        const rows: string[] = [];
        for (const c of running.values()) {
          const color = c.status === "running" ? "accent" : c.status === "done" ? "success" : "error";
          const icon = c.status === "running" ? "●" : c.status === "done" ? "✓" : "✗";
          rows.push(truncateToWidth(
            theme.fg(color, `${icon} #${c.id} ${c.chainName}`) +
            theme.fg("dim", ` · ${Math.round(c.elapsed / 1000)}s`),
            width,
          ));
          for (const s of c.steps) {
            const sc = s.status === "running" ? "accent" : s.status === "done" ? "success" : s.status === "error" ? "error" : "muted";
            const si = s.status === "running" ? "●" : s.status === "done" ? "✓" : s.status === "error" ? "✗" : "○";
            rows.push(truncateToWidth(theme.fg(sc, `  ${si} ${s.name}`), width));
          }
        }
        return rows;
      },
    }));
  };

  const startTick = () => {
    if (tick) return;
    tick = setInterval(() => {
      for (const c of running.values()) if (c.status === "running") c.elapsed = Date.now() - c.startedAt;
      render();
    }, 1000);
  };
  const stopTickIfIdle = () => {
    if (tick && ![...running.values()].some((c) => c.status === "running")) {
      clearInterval(tick); tick = undefined;
    }
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
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
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

      const id = nextId++;
      const chainState: ChainState = {
        id,
        chainName,
        status: "running",
        steps: chain.steps.map((s) => ({ name: s.name, status: "pending", output: "", elapsedMs: 0 })),
        startedAt: Date.now(),
        elapsed: 0,
      };
      running.set(id, chainState); render(); startTick();

      const stepStatusMap = new Map<string, StepState>();
      for (const s of chainState.steps) stepStatusMap.set(s.name, s);

      const result = await runChainByName(
        pi, ctx, chainName, params.task, params.cwd, params.returnAllSteps,
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
            render();
          }
        },
      );

      chainState.status = result.ok ? "done" : "error";
      chainState.elapsed = Date.now() - chainState.startedAt;
      render(); stopTickIfIdle();

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
