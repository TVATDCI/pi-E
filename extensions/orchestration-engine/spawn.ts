import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, statSync, renameSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import * as os from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModel, orderedFallbacks, FALLBACK, type TaskCategory } from "./tier-map.ts";
import { appendBudgetNudges, type ResolvedBudgets } from "../budgets/index.ts";

// Global FALLBACK as a "provider/id" flag string — the ordered-retry tail appended by orderedFallbacks().
const GLOBAL_FALLBACK_FLAG = `${FALLBACK.provider}/${FALLBACK.id}`;

// 0b: stable session key per {agent, project}. Sanitized git-root path → zero collision.
function findGitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

export function sessionKey(agent: string | undefined, cwd: string): string {
  const agentName = agent ?? "default";
  const root = findGitRoot(cwd) ?? cwd;
  const sanitized = root.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "");
  return `${agentName}--${sanitized}`;
}

// 0c: rotate (NOT truncate) once a session file exceeds budget. Truncation is unsafe
// for tree-structured sessions (dangling parentId refs); rotation archives the full
// file and starts fresh. renameSync is atomic on POSIX; racing callers are safe (the
// loser's ENOENT is swallowed by the catch). NOTE: repeated rotations overwrite
// .archive.jsonl — only the most recent generation is kept (older sub-agent context
// is stale anyway).
const MAX_SESSION_BYTES = 100_000; // ~25K tokens of JSONL

export function rotateIfNeeded(filePath: string): void {
  try {
    const stat = statSync(filePath);
    if (stat.size < MAX_SESSION_BYTES) return;
    const archivePath = filePath.replace(/\.jsonl$/, ".archive.jsonl");
    renameSync(filePath, archivePath);
  } catch {
    // File doesn't exist yet (first dispatch) — nothing to rotate.
  }
}

// 1a: accumulated token/cost usage for one spawn, summed across assistant turns.
// Oracle Q7 caveat: input/output summed across turns OVER-count (each turn re-sends
// full context). Rely on `cost` (summed) + `contextTokens` (last-wins) for decisions;
// raw input/output sums are advisory only.
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number; // last-wins — current context size
  turns: number;
}

/** Merge usage across primary + fallback retry. Sums cost/tokens/turns; contextTokens last-wins. */
function mergeUsage(a: UsageStats | undefined, b: UsageStats | undefined): UsageStats | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
    contextTokens: b.contextTokens, // last-wins (fallback ran last)
    turns: a.turns + b.turns,
  };
}

export interface Persona {
  name: string;
  description: string;
  tools: string;
  model?: string;
  systemPrompt: string;
}

export interface SpawnResult {
  output: string;
  code: number;
  elapsedMs: number;
  modelFlag: string;
  thinkingLevel?: string;
  rationale: string;
  source: string;
  toolCount: number;
  downshiftedFrom?: string;
  usage?: UsageStats;
}

export function loadPersona(name: string): Persona | undefined {
  const file = join(os.homedir(), ".pi", "agent", "agents", `${name}.md`);
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return undefined;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return {
    name: fm.name ?? name,
    description: fm.description ?? "",
    tools: fm.tools ?? "read,grep,find,ls",
    model: fm.model || undefined,
    systemPrompt: m[2].trim(),
  };
}

export interface SpawnProgress {
  chunk: string;
  toolCount: number;
  modelFlag?: string;
}

/** Build the full --append-system-prompt arg: persona systemPrompt + optional handoff context.
 * 4 cases: persona+context / persona-only / context-only / neither→undefined. Exported for testing. */
export function buildFullSystemPrompt(personaPrompt: string | undefined, context: string | undefined): string | undefined {
  if (personaPrompt && context) return `${personaPrompt}\n\n## Handoff Context\n${context}`;
  if (personaPrompt) return personaPrompt;
  if (context) return `## Handoff Context\n${context}`;
  return undefined;
}

const HANDOFF_CAP = 2000;

export function spawnSub(
  _category: TaskCategory,
  task: string,
  agent: string | undefined,
  ctx: ExtensionContext,
  resolved: { modelFlag: string; thinkingLevel?: string; rationale: string },
  persona: Persona | undefined,
  cwd?: string,
  onProgress?: (p: SpawnProgress) => void,
  signal?: AbortSignal,
  context?: string,
  budgets?: ResolvedBudgets,
  toolsOverride?: string,
): Promise<{ output: string; code: number; elapsedMs: number; toolCount: number; usage: UsageStats | undefined }> {
  const tools = toolsOverride ?? persona?.tools ?? "read,grep,find,ls";
  const needsBash = tools.includes("bash");

  const dir = join(os.homedir(), ".pi", "agent", "sessions", "orch-engine");
  mkdirSync(dir, { recursive: true });
  // 0b: stable session file per {agent, project} — resumable across dispatches.
  const sessionFile = join(dir, `sub-${sessionKey(agent, cwd ?? ctx.cwd)}.jsonl`);
  // 0c: rotate the stable file past budget before resuming (NOT truncate).
  rotateIfNeeded(sessionFile);

  const args = ["--mode", "json", "-p", "--session", sessionFile];
  args.push("--no-extensions");
  if (needsBash) {
    args.push("-e", join(os.homedir(), ".pi", "agent", "extensions", "mini-damage-control.ts"));
  }
  args.push("--tools", tools);
  args.push("--thinking", resolved.thinkingLevel ?? "off");
  args.push("--model", resolved.modelFlag);
  // Soft cap on handoff context: truncate + warn if exceeded (don't reject — legitimate large handoffs exist).
  let effectiveContext = context;
  if (context && context.length > HANDOFF_CAP) {
    effectiveContext = context.slice(0, HANDOFF_CAP) + `\n…[handoff truncated at ${HANDOFF_CAP} chars]`;
    if (ctx.hasUI) ctx.ui.notify(`⚠ Handoff context truncated to ${HANDOFF_CAP} chars`, "warning");
    console.warn(`[spawnSub] handoff context truncated from ${context.length} to ${HANDOFF_CAP} chars`);
  }
  const baseSystemPrompt = buildFullSystemPrompt(persona?.systemPrompt, effectiveContext);
  // ① budget nudges: turn/tool soft-wrap warnings injected at launch. Process-mode honest — the
  // hard block/kill itself can't be enforced from the parent (no mid-run channel; spawnSub runs with
  // stdin ignored), so this is a heads-up. Applied here so BOTH the primary and fallback spawns receive it.
  const fullSystemPrompt = appendBudgetNudges(baseSystemPrompt, budgets);
  if (fullSystemPrompt) args.push("--append-system-prompt", fullSystemPrompt);
  args.push(task);

  return new Promise((resolve) => {
    const proc = spawn("pi", args, { cwd: cwd ?? ctx.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });

    // TODO(Edit 7): wrap spawn in Promise.race([spawn, sleep(timeoutMs)]) when
    // dispatch gains a timeoutMs param; on expiry SIGTERM the child and return
    // {outcome: "timeout", downshiftedFrom: "timeout"} in the dispatch-log
    // receipt. Tracked in graph-engineering absorption plan; unblocks
    // review-loop Mode A hung-reviewer INCONCLUSIVE escape (Edit 4a). Until
    // this lands, the only abort is operator-Esc (manual).
    // 0a: Esc/abort must terminate the sub-agent process — no orphan subprocesses.
    let killed = false;
    const killProc = () => {
      if (killed) return;
      killed = true;
      try { proc.kill("SIGTERM"); } catch { /* already exited */ }
    };
    if (signal) {
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }

    let buf = "";
    let stderrBuf = "";
    let inbandError: string | undefined;
    const chunks: string[] = [];
    let toolCount = 0;
    const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
    const startTime = Date.now();

    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (c: string) => {
      buf += c;
      const lines = buf.split("\n"); buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
            const delta = ev.assistantMessageEvent.delta || "";
            chunks.push(delta);
            onProgress?.({ chunk: delta, toolCount });
          } else if (ev.type === "tool_execution_start") {
            toolCount++;
            onProgress?.({ chunk: "", toolCount });
          } else if (ev.type === "message_end") {
            const msg = ev.message;
            // Error detection. NOTE: path corrected to ev.message.stopReason — the prior
            // `ev.stopReason` read was at the wrong level (latent; errors fell through to
            // the code/stderr fallback). Discovered while empirically verifying 1a.
            if (msg?.stopReason === "error") {
              inbandError = msg.errorMessage || ev.errorMessage || ev.error || "agent ended with stopReason=error";
            }
            // 1a: capture usage from assistant message_end events.
            if (msg?.role === "assistant" && msg.usage) {
              const u = msg.usage;
              usage.input += u.input || 0;
              usage.output += u.output || 0;
              usage.cacheRead += u.cacheRead || 0;
              usage.cacheWrite += u.cacheWrite || 0;
              usage.cost += u.cost?.total || 0;
              usage.contextTokens = u.totalTokens || 0; // last-wins (current context size)
              usage.turns++;
            }
          }
        } catch { /* partial JSON — wait for more data */ }
      }
    });

    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (c: string) => { stderrBuf += c; });

    proc.on("close", (code) => {
      if (signal && !killed) signal.removeEventListener("abort", killProc);
      const elapsed = Date.now() - startTime;
      const raw = chunks.join("");
      const parts: string[] = [raw];
      if (inbandError) parts.push(`\n[agent error]\n${inbandError}`);
      if ((code !== 0 || parts[0].length === 0) && stderrBuf.trim()) parts.push(`\n[stderr]\n${stderrBuf.trim()}`);
      resolve({ output: parts.join("").trim(), code: code ?? 1, elapsedMs: elapsed, toolCount, usage: usage.turns > 0 ? usage : undefined });
    });

    proc.on("error", (err) => {
      if (signal && !killed) signal.removeEventListener("abort", killProc);
      const elapsed = Date.now() - startTime;
      resolve({ output: `spawn error: ${err.message}\n[stderr]\n${stderrBuf.trim() || "(none)"}`, code: 1, elapsedMs: elapsed, toolCount, usage: usage.turns > 0 ? usage : undefined });
    });
  });
}

export interface ResolveAndSpawnOptions {
  modelOverride?: string;
  thinkingOverride?: string;
  context?: string;
  budgets?: ResolvedBudgets;
  /** F1 (②b): force a tools list overriding the persona's — used to guarantee the independent
   *  reviewer is read-only regardless of `review.agent` (integrity: it can't tamper with the work). */
  toolsOverride?: string;
}

export async function resolveAndSpawn(
  pi: ExtensionAPI,
  task: string,
  category: TaskCategory,
  agent: string | undefined,
  cwd: string | undefined,
  ctx: ExtensionContext,
  onProgress?: (p: SpawnProgress) => void,
  signal?: AbortSignal,
  agentSource?: string,
  options?: ResolveAndSpawnOptions,
): Promise<SpawnResult> {
  const { modelOverride, thinkingOverride, context, budgets, toolsOverride } = options ?? {};
  const persona = agent ? loadPersona(agent) : undefined;
  if (agent && !persona) {
    return {
      output: `Error: persona '${agent}' not found in ~/.pi/agent/agents/`,
      code: 1,
      elapsedMs: 0,
      modelFlag: "",
      rationale: "persona-not-found",
      source: "error",
      toolCount: 0,
    };
  }

  const tierDefault = resolveModel(category, ctx.modelRegistry);
  // clarify-override (interactive TUI) takes precedence over persona, then tier-map. Inherits the
  // isAvail + FALLBACK downshift below, so an unavailable override downshifts instead of failing.
  let modelFlag = modelOverride ?? persona?.model ?? tierDefault.modelFlag;
  let thinkingLevel = thinkingOverride ?? tierDefault.thinkingLevel;
  let source: string = modelOverride ? "clarify-override" : persona?.model ? "persona-override" : (agentSource ?? "tier-map");
  let rationale = modelOverride
    ? `clarify override (thinking ${thinkingLevel ?? "off"})`
    : persona?.model
      ? `persona override (thinking ${tierDefault.thinkingLevel ?? "off"} from tier-map)`
      : tierDefault.rationale;

  const available = ctx.modelRegistry.getAvailable();
  const isAvail = (mf: string) => {
    const sep = mf.indexOf("/");
    return available.some((m) => m.provider === mf.slice(0, sep) && m.id === mf.slice(sep + 1));
  };
  let downshiftedFrom: string | undefined;
  if (!isAvail(modelFlag)) {
    // Primary unavailable (no configured key). Walk the per-tier fallback chain then the global
    // FALLBACK tail, picking the FIRST available (PORT-PLAN-v0.40.md ③). Previously this leapt
    // straight to the global FALLBACK, ignoring the per-tier array entirely.
    downshiftedFrom = modelFlag;
    const candidates = orderedFallbacks(modelFlag, tierDefault.fallbackFlags, GLOBAL_FALLBACK_FLAG);
    const pick = candidates.find(isAvail);
    if (pick) {
      modelFlag = pick;
      thinkingLevel = "high";
      source = "downshift-unavailable";
      rationale = `${downshiftedFrom} unavailable (no configured key) → fell back to ${pick}`;
      if (ctx.hasUI) ctx.ui.notify(`⚠ ${downshiftedFrom} unavailable → downshifted to ${pick}`, "info");
    } else {
      return {
        output: `Dispatch aborted: '${downshiftedFrom}' is unavailable (no configured key) and no fallback in [${candidates.join(", ")}] has a key either. Run /tiers to see which models have keys.`,
        code: 1,
        elapsedMs: 0,
        modelFlag,
        thinkingLevel,
        rationale,
        source: "error",
        toolCount: 0,
      };
    }
  }

  // Inject the resolved modelFlag into every progress emission so the parent widget can show
  // the active model during a run (reads the live `modelFlag` let, so a fallback/downshift is
  // reflected on the retried spawn). spawnSub itself stays unchanged.
  const progressWithModel = onProgress ? (p: SpawnProgress) => onProgress({ ...p, modelFlag }) : undefined;
  let { output, code, elapsedMs, toolCount, usage } = await spawnSub(category, task, agent, ctx, { modelFlag, thinkingLevel, rationale }, persona, cwd, progressWithModel, signal, context, budgets, toolsOverride);

  // Cross-provider fallback chain when the primary silently returns empty (quota exhausted — the
  // Z-AI plan has NO balance fallback, so exhaustion = hard fail = empty output). Walk the per-tier
  // fallbackModels array in order, then the global FALLBACK tail, spawning each available model
  // until one produces output; merge usage/elapsed/tools across all hops. Mirrors upstream
  // "auto-trigger on rate-limit/overload" detection — empty-output is the Z-AI manifestation; live
  // 429/529 detection is deferred (PORT-PLAN-v0.40.md ③). Previously this tried exactly ONE fallback.
  if (output.length === 0 && !signal?.aborted) {
    const candidates = orderedFallbacks(modelFlag, tierDefault.fallbackFlags, GLOBAL_FALLBACK_FLAG).filter(isAvail);
    if (candidates.length > 0) {
      const exhaustedFrom = modelFlag;
      const retriedWith: string[] = [];
      for (const cand of candidates) {
        retriedWith.push(cand);
        modelFlag = cand;
        thinkingLevel = "high";
        const fbResult = await spawnSub(category, task, agent, ctx, { modelFlag, thinkingLevel, rationale }, persona, cwd, progressWithModel, signal, context, budgets, toolsOverride);
        elapsedMs += fbResult.elapsedMs;
        toolCount += fbResult.toolCount;
        usage = mergeUsage(usage, fbResult.usage);
        if (fbResult.output.length > 0) {
          output = fbResult.output;
          code = fbResult.code;
          break;
        }
      }
      downshiftedFrom = exhaustedFrom;
      source = "downshift-exhausted";
      if (output.length > 0) {
        rationale = `${exhaustedFrom} returned empty (likely quota exhausted) → retried with ${retriedWith.join(" → ")}`;
        if (ctx.hasUI) ctx.ui.notify(`⚠ ${exhaustedFrom} exhausted → retried with ${retriedWith.join(" → ")}`, "info");
      } else {
        output = `${exhaustedFrom} and fallback${retriedWith.length > 1 ? "s" : ""} ${retriedWith.join(", ")} all returned empty. Check quota or run /tiers to verify model availability.`;
        code = 1;
        rationale = `all of ${[exhaustedFrom, ...retriedWith].join(" → ")} returned empty`;
      }
    }
  }

  pi.appendEntry("dispatch-log", {
    category,
    modelFlag,
    thinkingLevel: thinkingLevel ?? "off",
    rationale,
    source,
    agent: agent ?? null,
    cwd: cwd ?? ctx.cwd,
    cwdOverride: cwd ? true : false,
    outcome: code === 0 ? "done" : "error",
    elapsedMs,
    task: task.slice(0, 200),
    ...(downshiftedFrom ? { downshiftedFrom } : {}),
    ...(usage ? { usage } : {}),
    ...(budgets ? { budget: budgets.enforcement, ...(budgets.warnings.length ? { budgetWarnings: budgets.warnings } : {}) } : {}),
  });

  return {
    output,
    code,
    elapsedMs,
    modelFlag,
    thinkingLevel,
    rationale,
    source,
    toolCount,
    ...(downshiftedFrom ? { downshiftedFrom } : {}),
    ...(usage ? { usage } : {}),
  };
}
