import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { parse as yamlParse } from "yaml";
import { resolveAndSpawn, loadPersona, type UsageStats, type SpawnProgress } from "./orchestration-engine/spawn.ts";
import type { TaskCategory } from "./orchestration-engine/tier-map.ts";
import { READ_ONLY_CATEGORIES, tierEntryFor } from "./orchestration-engine/tier-map.ts";
import { resolveBudgets, budgetUsageState } from "./budgets/index.ts";
import { accumulateUsage, sessionUsage } from "./orchestration-engine/session-state.ts";
import {
  coerceAcceptance,
  resolveAcceptance,
  formatAcceptancePrompt,
  evaluateAcceptance,
  stripAcceptanceReport,
  inferDefaultLevel,
  type AcceptanceInput,
  type StepAcceptance,
} from "./acceptance.ts";

export interface ChainStep {
  name: string;
  agent: string;
  category?: TaskCategory;
  prompt: string;
  acceptance?: AcceptanceInput;
}

export interface Chain {
  description: string;
  default_category?: TaskCategory;
  steps: ChainStep[];
}

export interface ChainsFile {
  version?: string;
  chains: Record<string, Chain>;
}

export interface ChainStepResult {
  name: string;
  output: string;
  code: number;
  elapsedMs: number;
  toolCount?: number;
  modelFlag?: string;
  thinkingLevel?: string;
  usage?: UsageStats;
  acceptance?: StepAcceptance;
}

export interface ChainRunResult {
  ok: boolean;
  chainName: string;
  finalOutput: string;
  stepResults: ChainStepResult[];
  error?: { step: string; output: string };
}

/** Per-step overrides from the clarify-before-launch TUI. */
export interface ChainStepOverride {
  model?: string;
  thinking?: string;
  prompt?: string;
}
export interface ChainOverrides {
  task?: string;
  steps?: Record<string, ChainStepOverride>;
}

const GLOBAL_CHAINS_PATH = join(os.homedir(), ".pi", "agent", "agent-chain.yaml");

function loadChainsLayer(filepath: string): ChainsFile | null {
  if (!existsSync(filepath)) return null;
  try {
    const raw = yamlParse(readFileSync(filepath, "utf-8")) as Partial<ChainsFile> | null;
    if (!raw) return null;
    return { version: raw.version ?? "1.0", chains: raw.chains ?? {} };
  } catch {
    return null;
  }
}

function mergeChains(global: ChainsFile | null, project: ChainsFile | null): ChainsFile {
  const g = global ?? { chains: {} };
  const p = project ?? { chains: {} };
  const merged: Record<string, Chain> = {};
  for (const [name, chain] of Object.entries(g.chains)) {
    merged[name] = chain;
  }
  // Deny-additive: projects can add chains but cannot override or remove global chains.
  for (const [name, chain] of Object.entries(p.chains)) {
    if (!merged[name]) {
      merged[name] = chain;
    }
  }
  return { version: p.version ?? g.version ?? "1.0", chains: merged };
}

function normalizeChainsFile(raw: ChainsFile): ChainsFile {
  const chains: Record<string, Chain> = {};
  for (const [name, chain] of Object.entries(raw.chains ?? {})) {
    const steps = (chain.steps ?? []).map((s) => {
      const sr = s as unknown as Record<string, unknown>;
      const acceptance = coerceAcceptance(sr.acceptance);
      return {
        name: String(sr.name ?? ""),
        agent: String(sr.agent ?? ""),
        category: sr.category as TaskCategory | undefined,
        prompt: String(sr.prompt ?? ""),
        ...(acceptance ? { acceptance } : {}),
      };
    });
    chains[name] = {
      description: String(chain.description ?? ""),
      default_category: chain.default_category as TaskCategory | undefined,
      steps,
    };
  }
  return { version: raw.version ?? "1.0", chains };
}

export function loadChains(ctx: ExtensionContext): Map<string, Chain> {
  const globalChains = loadChainsLayer(GLOBAL_CHAINS_PATH);
  const projectPath = join(ctx.cwd, ".pi", "agent-chain.yaml");
  const projectChains = loadChainsLayer(projectPath);
  const merged = mergeChains(globalChains, projectChains);
  const normalized = normalizeChainsFile(merged);
  const chains = new Map<string, Chain>();
  for (const [name, chain] of Object.entries(normalized.chains)) {
    chains.set(name, chain);
  }
  return chains;
}

export async function runChainByName(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  chainName: string,
  task: string,
  cwd: string | undefined,
  returnAllSteps?: boolean,
  onStepStart?: (name: string) => void,
  onStepEnd?: (name: string, result: ChainStepResult) => void,
  onStepProgress?: (name: string, p: SpawnProgress) => void,
  signal?: AbortSignal,
  overrides?: ChainOverrides,
  context?: string,
): Promise<ChainRunResult> {
  const chains = loadChains(ctx);
  const chain = chains.get(chainName);
  if (!chain) {
    return {
      ok: false,
      chainName,
      finalOutput: "",
      stepResults: [],
      error: { step: "(load)", output: `Chain '${chainName}' not found. Available: ${[...chains.keys()].join(", ")}` },
    };
  }
  if (chain.steps.length === 0) {
    return {
      ok: false,
      chainName,
      finalOutput: "",
      stepResults: [],
      error: { step: "(load)", output: `Chain '${chainName}' has no steps.` },
    };
  }

  const original = overrides?.task ?? task;
  let input = original;
  const stepResults: ChainStepResult[] = [];
  let finalOutput = "";

  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    const category = step.category ?? chain.default_category ?? "unspecified-low";
    const persona = step.agent ? loadPersona(step.agent) : undefined;
    const stepOverride = overrides?.steps?.[step.name];
    const stepPrompt = stepOverride?.prompt ?? step.prompt;
    // ②a pass the task text so risky-context tasks auto-badge review-required (Q2.1 suggest).
    const resolvedAcceptance = resolveAcceptance(step.acceptance, inferDefaultLevel(persona?.tools), stepPrompt);
    const prompt =
      stepPrompt.replace(/\$INPUT/g, input).replace(/\$ORIGINAL/g, original) +
      (resolvedAcceptance ? formatAcceptancePrompt(resolvedAcceptance) : "");

    // ① per-step budget resolution + usageBudget gate (PORT-PLAN §①). Mirrors dispatch (index.ts):
    // turn/tool are prompt-nudges from the step's tier-map category default. The usageBudget gate is
    // DORMANT by default (no usageBudget is passed — upstream's UsageBudgetLimitConfig requires `hard`,
    // so any default would ACTIVATE it); it reports cumulative usage always and blocks a later step
    // ONLY when a caller/config supplies a usageBudget with a hard limit (shared sessionUsage across
    // dispatch + run_chain). Runs before onStepStart so an aborted step never leaves a stale widget row.
    const stepTier = tierEntryFor(category);
    const stepBudgets = resolveBudgets({
      category,
      readOnlyCategories: READ_ONLY_CATEGORIES,
      tierTurnBudget: stepTier.turnBudget,
      tierToolBudget: stepTier.toolBudget,
    });
    const stepUbState = budgetUsageState(stepBudgets, sessionUsage);
    if (stepUbState?.exhausted) {
      const reason = stepUbState.reason === "costUsd" ? "cost" : "tokens";
      return {
        ok: false,
        chainName,
        finalOutput,
        stepResults,
        error: { step: step.name, output: `Chain aborted at step '${step.name}': session usage budget exhausted (${reason} hard limit). Cumulative: ${sessionUsage.inputTokens + sessionUsage.outputTokens} tokens, $${sessionUsage.costUsd.toFixed(4)}. Start a new session or raise the usageBudget.` },
      };
    }

    onStepStart?.(step.name);
    const result = await resolveAndSpawn(
      pi,
      prompt,
      category,
      step.agent,
      cwd,
      ctx,
      onStepProgress ? (p) => onStepProgress(step.name, p) : undefined,
      signal,
      undefined,
      { modelOverride: stepOverride?.model, thinkingOverride: stepOverride?.thinking, context, budgets: stepBudgets },
    );
    // ① accumulate this step's reported usage into the shared session total (counts toward the gate).
    accumulateUsage(result.usage);

    let stepCode = result.code;
    let stepAcceptance: StepAcceptance | undefined;
    if (resolvedAcceptance && result.code === 0) {
      stepAcceptance = await evaluateAcceptance(resolvedAcceptance, result.output, cwd ?? ctx.cwd, signal);
      if (stepAcceptance.failStep) stepCode = 1;
      // Persist provenance to dispatch-log so the badge survives widget teardown (ABSORPTION-PLAN §A).
      pi.appendEntry("dispatch-log", {
        kind: "acceptance",
        chain: chainName,
        step: step.name,
        agent: step.agent,
        level: stepAcceptance.level,
        provenance: stepAcceptance.provenance,
        inferred: stepAcceptance.inferred,
        failStep: stepAcceptance.failStep,
        ...(stepAcceptance.verifyResults ? { verifyResults: stepAcceptance.verifyResults } : {}),
      });
    }

    // Strip the fenced acceptance-report from the output so it doesn't propagate as noise into
    // the next step's $INPUT (Oracle A+C ruling). Gated on resolvedAcceptance so a level:none
    // step's literal output is never mangled.
    if (resolvedAcceptance) result.output = stripAcceptanceReport(result.output);

    const stepResult: ChainStepResult = {
      name: step.name,
      output: result.output,
      code: stepCode,
      elapsedMs: result.elapsedMs,
      toolCount: result.toolCount,
      modelFlag: result.modelFlag,
      thinkingLevel: result.thinkingLevel,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(stepAcceptance ? { acceptance: stepAcceptance } : {}),
    };
    onStepEnd?.(step.name, stepResult);
    stepResults.push(stepResult);

    if (stepCode !== 0) {
      const gateNote = stepAcceptance?.failStep
        ? `\n[acceptance gate failed: provenance=${stepAcceptance.provenance} (requested ${stepAcceptance.level})]`
        : "";
      return {
        ok: false,
        chainName,
        finalOutput,
        stepResults,
        error: { step: step.name, output: result.output + gateNote },
      };
    }

    // W6: bound inter-step context. A verbose middle step must not inflate every downstream
    // step's prompt. finalOutput keeps the FULL last-step output for the return value; only the
    // chain-propagated $INPUT is capped. (Caller can request returnAllSteps for full per-step output.)
    const STEP_INPUT_MAX = 20000;
    input = result.output.length > STEP_INPUT_MAX
      ? result.output.slice(0, STEP_INPUT_MAX) + `\n…[chain input truncated ${result.output.length - STEP_INPUT_MAX} chars]`
      : result.output;
    finalOutput = result.output;
  }

  const text = returnAllSteps
    ? stepResults.map((r) => `## ${r.name}\n\n${r.output}`).join("\n\n---\n\n")
    : finalOutput;

  return {
    ok: true,
    chainName,
    finalOutput: text,
    stepResults,
  };
}

export default function (_pi: ExtensionAPI) {}
