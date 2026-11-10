// extensions/tests/fallback-carry-thinking.test.ts — F1 2026-11-10 ruling regression:
// the fallback ladder preserves the primary's (tier's) thinking level through EVERY retry
// rung — union-max doctrine stays true as written.
// Run: node --experimental-strip-types fallback-carry-thinking.test.ts   (from extensions/tests/)
//
// HOW THIS RUNS (unlike the older pure tests): it imports spawn.ts for real. spawn.ts's only
// pi-core import is `import type` (erased under --experimental-strip-types), so resolveAndSpawn
// IS runnable under plain node — the old "cannot run under plain node" header claim on other
// test files held when spawn.ts still had a VALUE import from the pi package.
//
// Mechanism under test, end-to-end and fully mocked (no live model calls, no network):
//   - a fake `pi` executable is prepended to PATH: it logs the exact launch argv per
//     invocation (the request/launch options that reach the retry executor) and plays a
//     scripted per-invocation outcome (empty = quota-empty soft failure, ok = success).
//   - HOME is pointed at a scratch dir so spawnSub's session bookkeeping never touches the
//     live ~/.pi tree.
//   - a mock model registry decides availability.
//
// The pre-fix counterfactual this file pins (found by bounded reproduction through the real
// path): when the tier primary was NOT in the registry, resolveModel's registry-fallback
// branch returned no thinkingLevel — the resolved primary spawned `--thinking off` and every
// retry rung fell to the "high" floor, so a deep walk ran @off/@high instead of @max (and an
// ultrabrain walk instead of @xhigh). Fixed in tier-map.ts (F1 2026-11-10): the
// registry-fallback resolution carries the tier's declared thinkingLevel, so the primary AND
// every hop keep it (hopThinkingLevel reads it as tierThinkingLevel).
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndSpawn } from "../orchestration-engine/spawn.ts";
import { TIERS, FALLBACK } from "../orchestration-engine/tier-map.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}
function eq<T>(name: string, got: T, want: T): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(`${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, ok);
}

// ── scratch world: HOME + fake pi on PATH ────────────────────────────────────
const SCRATCH = mkdtempSync(join(tmpdir(), "fm-f1-fallback-"));
process.env.HOME = SCRATCH; // BEFORE any spawn: session files land in scratch, never the live tree
const SHIM_DIR = join(SCRATCH, "shim");
mkdirSync(SHIM_DIR, { recursive: true });
// Fake `pi`: logs argv (JSON line) → plays the next scripted outcome (empty | ok | error).
const SHIM = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_PI_ARGVLOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const n = parseInt((fs.readFileSync(process.env.FAKE_PI_COUNTER, "utf8") || "0").trim() || "0", 10);
fs.writeFileSync(process.env.FAKE_PI_COUNTER, String(n + 1));
const outcomes = fs.readFileSync(process.env.FAKE_PI_OUTCOMES, "utf8").split("\\n").filter(Boolean);
const outcome = outcomes[n] || "empty";
if (outcome === "ok") {
  console.log('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"rescued output"}}');
  console.log('{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":20,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.001},"totalTokens":30}}}');
} else if (outcome === "error") {
  console.log('{"type":"message_end","message":{"stopReason":"error","errorMessage":"GoUsageLimitError: 429 monthly cap"}}');
}
process.exit(0);
`;
writeFileSync(join(SHIM_DIR, "pi"), SHIM);
chmodSync(join(SHIM_DIR, "pi"), 0o755);
process.env.PATH = `${SHIM_DIR}:${process.env.PATH}`;

// ── mock registry + pi/ctx mocks ─────────────────────────────────────────────
function mockRegistry(present: string[]) {
  const list = present.map((mf) => { const i = mf.indexOf("/"); return { provider: mf.slice(0, i), id: mf.slice(i + 1) }; });
  const set = new Set(present);
  return {
    find: (provider: string, id: string) => (set.has(`${provider}/${id}`) ? { provider, id } : undefined),
    getAvailable: () => list,
  };
}
const piMock = {
  entries: [] as Array<Record<string, unknown>>,
  appendEntry(type: string, data: Record<string, unknown>) { this.entries.push({ type, ...data }); },
};
const ctxOf = (registry: ReturnType<typeof mockRegistry>) =>
  ({ modelRegistry: registry, cwd: SCRATCH, hasUI: false }) as unknown as Parameters<typeof resolveAndSpawn>[5];

interface Invocation { model: string; thinking: string; argv: string[] }
async function runScenario(name: string, category: string, registryModels: string[], outcomes: string[], options?: { thinkingOverride?: string }) {
  const argvLog = join(SCRATCH, `argv-${name}.log`);
  const outcomesFile = join(SCRATCH, `outcomes-${name}.txt`);
  const counter = join(SCRATCH, `counter-${name}.txt`);
  writeFileSync(outcomesFile, outcomes.join("\n") + "\n");
  writeFileSync(counter, "0");
  process.env.FAKE_PI_ARGVLOG = argvLog;
  process.env.FAKE_PI_OUTCOMES = outcomesFile;
  process.env.FAKE_PI_COUNTER = counter;
  const result = await resolveAndSpawn(piMock as never, `task-${name}`, category as never, undefined, SCRATCH, ctxOf(mockRegistry(registryModels)), undefined, undefined, undefined, options);
  const invocations: Invocation[] = readFileSync(argvLog, "utf-8").split("\n").filter(Boolean).map((l) => {
    const argv: string[] = JSON.parse(l);
    return { model: argv[argv.indexOf("--model") + 1], thinking: argv[argv.indexOf("--thinking") + 1], argv };
  });
  return { result, invocations };
}

const globalFlag = `${FALLBACK.provider}/${FALLBACK.id}`;
function tierModels(cat: keyof typeof TIERS): string[] {
  const e = TIERS[cat] as unknown as { provider: string; id: string; fallbackModels?: Array<{ provider: string; id: string }> };
  return [`${e.provider}/${e.id}`, ...(e.fallbackModels ?? []).map((f) => `${f.provider}/${f.id}`), globalFlag];
}
/** Assert every invocation launched with exactly [name, model, thinking-level] — the launch
 *  options that reached the retry executor, not a displayed label. */
function pinRungs(name: string, invocations: Invocation[], want: Array<{ model: string; thinking: string }>) {
  eq(`${name}: invocation count (primary + retry rungs)`, invocations.length, want.length);
  eq(`${name}: every rung's --model/--thinking launch pair`, invocations.map((i) => ({ model: i.model, thinking: i.thinking })), want);
}

// ── S1: ultrabrain mainline exhausted-walk — xhigh through 3 successive retry rungs ──
{
  const { result, invocations } = await runScenario("s1", "ultrabrain", tierModels("ultrabrain"), ["empty", "empty", "empty", "ok"]);
  pinRungs("S1 ultrabrain walk @xhigh", invocations, [
    { model: "opencode-go/kimi-k3.1-pro", thinking: "xhigh" },
    { model: "opencode-go/grok-4.7", thinking: "xhigh" },
    { model: "opencode-go/kimi-k3", thinking: "xhigh" },
    { model: "opencode-go/qwen3.8-max", thinking: "xhigh" },
  ]);
  check("S1: ≥2 successive retry rungs pinned", invocations.length >= 3);
  eq("S1: result carries the walked level (xhigh) + downshift source", [result.source, result.thinkingLevel], ["downshift-exhausted", "xhigh"]);
}
// ── S2: deep mainline exhausted-walk — max through 3 successive retry rungs ──
{
  const { result, invocations } = await runScenario("s2", "deep", tierModels("deep"), ["empty", "empty", "empty", "ok"]);
  pinRungs("S2 deep walk @max", invocations, [
    { model: "zai-coding-cn/glm-5.3", thinking: "max" },
    { model: "opencode-go/glm-5.2", thinking: "max" },
    { model: "opencode/glm-5.2", thinking: "max" },
    { model: globalFlag, thinking: "max" },
  ]);
  check("S2: ≥2 successive retry rungs pinned", invocations.length >= 3);
  eq("S2: result carries the walked level (max) + downshift source", [result.source, result.thinkingLevel], ["downshift-exhausted", "max"]);
}
// ── S3 (THE REGRESSION, red pre-fix): deep registry-fallback — tier primary unregistered,
// resolveModel resolves to the global FALLBACK; primary + 2 retry rungs must stay @max.
// Pre-fix: primary @off + rungs @high (tier level dropped in the fallback resolution). ──
{
  const e = TIERS.deep as unknown as { fallbackModels: Array<{ provider: string; id: string }> };
  const models = [globalFlag, `${e.fallbackModels[0].provider}/${e.fallbackModels[0].id}`, `${e.fallbackModels[1].provider}/${e.fallbackModels[1].id}`];
  const { result, invocations } = await runScenario("s3", "deep", models, ["empty", "empty", "ok"]);
  pinRungs("S3 deep registry-fallback walk @max (regression)", invocations, [
    { model: globalFlag, thinking: "max" },
    { model: "opencode-go/glm-5.2", thinking: "max" },
    { model: "opencode/glm-5.2", thinking: "max" },
  ]);
  check("S3: 2 successive retry rungs pinned", invocations.length === 3);
  eq("S3: result level max + downshift source", [result.source, result.thinkingLevel], ["downshift-exhausted", "max"]);
}
// ── S4 (regression twin, xhigh side): ultrabrain registry-fallback walk stays @xhigh ──
{
  const e = TIERS.ultrabrain as unknown as { fallbackModels: Array<{ provider: string; id: string }> };
  const models = [globalFlag, `${e.fallbackModels[1].provider}/${e.fallbackModels[1].id}`, `${e.fallbackModels[2].provider}/${e.fallbackModels[2].id}`];
  const { result, invocations } = await runScenario("s4", "ultrabrain", models, ["empty", "empty", "ok"]);
  pinRungs("S4 ultrabrain registry-fallback walk @xhigh (regression)", invocations, [
    { model: globalFlag, thinking: "xhigh" },
    { model: "opencode-go/kimi-k3", thinking: "xhigh" },
    { model: "opencode-go/qwen3.8-max", thinking: "xhigh" },
  ]);
  eq("S4: result level xhigh + downshift source", [result.source, result.thinkingLevel], ["downshift-exhausted", "xhigh"]);
}
// ── S5: direct-success path unchanged — single invocation at the tier level, no walk ──
{
  const u = await runScenario("s5a", "ultrabrain", tierModels("ultrabrain"), ["ok"]);
  pinRungs("S5a ultrabrain direct success (unchanged)", u.invocations, [{ model: "opencode-go/kimi-k3.1-pro", thinking: "xhigh" }]);
  eq("S5a: source tier-map, level xhigh", [u.result.source, u.result.thinkingLevel], ["tier-map", "xhigh"]);
  const d = await runScenario("s5b", "deep", tierModels("deep"), ["ok"]);
  pinRungs("S5b deep direct success (unchanged)", d.invocations, [{ model: "zai-coding-cn/glm-5.3", thinking: "max" }]);
  eq("S5b: source tier-map, level max", [d.result.source, d.result.thinkingLevel], ["tier-map", "max"]);
}
// ── S6: lower-level behavior unchanged — quick tier is @off; hops stay @off (no silent upgrade) ──
{
  const { result, invocations } = await runScenario("s6", "quick", tierModels("quick"), ["empty", "ok"]);
  pinRungs("S6 quick walk stays @off (unchanged)", invocations, [
    { model: "zai-coding-cn/glm-5.3-flash", thinking: "off" },
    { model: "opencode-go/gpt-5.6-luna", thinking: "off" },
  ]);
  eq("S6: result level off", result.thinkingLevel, "off");
}
// ── S7: caller thinkingOverride still WINS on every rung (override semantics unchanged) ──
{
  const { result, invocations } = await runScenario("s7", "deep", tierModels("deep"), ["empty", "ok"], { thinkingOverride: "high" });
  pinRungs("S7 deep @high override carried on primary + rung (unchanged)", invocations, [
    { model: "zai-coding-cn/glm-5.3", thinking: "high" },
    { model: "opencode-go/glm-5.2", thinking: "high" },
  ]);
  eq("S7: result level high (override wins over tier max)", result.thinkingLevel, "high");
}
// ── dispatch-log receipt: the logged level matches the launched level (label = invocation) ──
{
  const last = piMock.entries.filter((e) => e.type === "dispatch-log").at(-1) as { thinkingLevel?: string } | undefined;
  check("dispatch-log receipt carries the same level that reached the executor", last?.thinkingLevel === "high");
}

rmSync(SCRATCH, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
