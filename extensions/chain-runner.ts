import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { parse as yamlParse } from "yaml";
import { resolveAndSpawn, type UsageStats, type SpawnProgress } from "./orchestration-engine/spawn.ts";
import type { TaskCategory } from "./orchestration-engine/tier-map.ts";

export interface ChainStep {
  name: string;
  agent: string;
  category?: TaskCategory;
  prompt: string;
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
}

export interface ChainRunResult {
  ok: boolean;
  chainName: string;
  finalOutput: string;
  stepResults: ChainStepResult[];
  error?: { step: string; output: string };
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
    const steps = (chain.steps ?? []).map((s) => ({
      name: String((s as unknown as Record<string, unknown>).name ?? ""),
      agent: String((s as unknown as Record<string, unknown>).agent ?? ""),
      category: (s as unknown as Record<string, unknown>).category as TaskCategory | undefined,
      prompt: String((s as unknown as Record<string, unknown>).prompt ?? ""),
    }));
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

  const original = task;
  let input = original;
  const stepResults: ChainStepResult[] = [];
  let finalOutput = "";

  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    const category = step.category ?? chain.default_category ?? "unspecified-low";
    const prompt = step.prompt
      .replace(/\$INPUT/g, input)
      .replace(/\$ORIGINAL/g, original);

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
    );
    const stepResult: ChainStepResult = {
      name: step.name,
      output: result.output,
      code: result.code,
      elapsedMs: result.elapsedMs,
      toolCount: result.toolCount,
      modelFlag: result.modelFlag,
      thinkingLevel: result.thinkingLevel,
      ...(result.usage ? { usage: result.usage } : {}),
    };
    onStepEnd?.(step.name, stepResult);
    stepResults.push(stepResult);

    if (result.code !== 0) {
      return {
        ok: false,
        chainName,
        finalOutput,
        stepResults,
        error: { step: step.name, output: result.output },
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
