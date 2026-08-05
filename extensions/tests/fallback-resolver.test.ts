// extensions/tests/fallback-resolver.test.ts — PORT-PLAN-v0.40.md ③ fallback-chain tests.
// Run: node --experimental-strip-types fallback-resolver.test.ts   (from extensions/tests/)
//
// Pure tests (no spawn, no pi, no external @earendil-works deps): the orderedFallbacks() helper
// + resolveModel()'s fallbackFlags surface + the strong-model-at-judging invariant. spawn.ts's
// consumption of these (the unavailable + empty-output walks) is traced by review-loop, not here,
// because spawn.ts imports the pi core and cannot run under plain node.
import {
  orderedFallbacks,
  resolveModel,
  TIERS,
  FALLBACK,
  DEFAULT_CATEGORY,
  type ModelRegistryLike,
} from "../orchestration-engine/tier-map.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}`);
  }
}
function eq<T>(name: string, got: T, want: T): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  check(`${name}${ok ? "" : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`, ok);
}
const GLOBAL = `${FALLBACK.provider}/${FALLBACK.id}`; // "opencode-go/glm-5.1"

// ── orderedFallbacks: core ordering + tail + exclude ─────────────────────────
eq(
  "per-tier array + global tail, primary excluded",
  orderedFallbacks("zai-coding-cn/glm-5.2", ["opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code"], GLOBAL),
  ["opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code", GLOBAL],
);
eq(
  "empty tier array → just the global tail",
  orderedFallbacks("zai-coding-cn/glm-5.2", [], GLOBAL),
  [GLOBAL],
);
eq(
  "primary duplicated in tier array → excluded (not retried)",
  orderedFallbacks("opencode-go/glm-5.2", ["opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code"], GLOBAL),
  ["opencode-go/kimi-k2.7-code", GLOBAL],
);
eq(
  "global == primary → global tail dropped (not retried)",
  orderedFallbacks(GLOBAL, ["opencode-go/glm-5.2"], GLOBAL),
  ["opencode-go/glm-5.2"],
);
eq(
  "duplicates within tier array → deduped, order preserved",
  orderedFallbacks("zai-coding-cn/glm-5.2", ["opencode-go/glm-5.2", "opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code"], GLOBAL),
  ["opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code", GLOBAL],
);
eq(
  "global appears in tier array AND as tail → emitted once (tier position wins)",
  orderedFallbacks("zai-coding-cn/glm-5.2", ["opencode-go/kimi-k2.7-code", GLOBAL], GLOBAL),
  ["opencode-go/kimi-k2.7-code", GLOBAL],
);
eq(
  "exclude removes additional models (already-tried this walk)",
  orderedFallbacks("zai-coding-cn/glm-5.2", ["opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code"], GLOBAL, ["opencode-go/glm-5.2"]),
  ["opencode-go/kimi-k2.7-code", GLOBAL],
);
eq(
  "exclude can drop the global tail entirely",
  orderedFallbacks("zai-coding-cn/glm-5.2", ["opencode-go/glm-5.2"], GLOBAL, [GLOBAL]),
  ["opencode-go/glm-5.2"],
);
eq(
  "everything excluded → empty chain",
  orderedFallbacks("zai-coding-cn/glm-5.2", [], GLOBAL, [GLOBAL]),
  [],
);

// ── resolveModel: fallbackFlags surface ──────────────────────────────────────
// Mock registry: present iff provider/id in the seeded set.
function mockRegistry(present: Array<[string, string]>): ModelRegistryLike {
  const set = new Set(present.map(([p, i]) => `${p}/${i}`));
  return {
    find(provider: string, id: string) {
      return set.has(`${provider}/${id}`) ? { provider, id } : undefined;
    },
  };
}

const deepResolved = resolveModel("deep", mockRegistry([["zai-coding-cn", "glm-5.2"]]));
eq(
  "resolveModel(deep): source tier-map, modelFlag = primary",
  [deepResolved.source, deepResolved.modelFlag],
  ["tier-map", "zai-coding-cn/glm-5.2"],
);
eq(
  "resolveModel(deep): fallbackFlags = per-tier 2-elem array (NO global tail — spawn.ts appends it)",
  deepResolved.fallbackFlags,
  ["opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code"],
);
check("resolveModel(deep): fallbackFlags is an array (not undefined/string)", Array.isArray(deepResolved.fallbackFlags));

const quickResolved = resolveModel("quick", mockRegistry([["opencode", "deepseek-v4-flash-free"]]));
eq(
  "resolveModel(quick): single-element fallbackFlags",
  quickResolved.fallbackFlags,
  ["opencode/ling-3.0-flash-free"],
);

// Primary not in registry, global present → source "fallback", fallbackFlags STILL the per-tier array.
const deepFallback = resolveModel("deep", mockRegistry([[FALLBACK.provider, FALLBACK.id]]));
eq(
  "resolveModel(deep) primary-missing: source fallback, modelFlag = global",
  [deepFallback.source, deepFallback.modelFlag],
  ["fallback", GLOBAL],
);
eq(
  "resolveModel(deep) primary-missing: fallbackFlags still the per-tier array",
  deepFallback.fallbackFlags,
  ["opencode-go/glm-5.2", "opencode-go/kimi-k2.7-code"],
);

// Unknown category → DEFAULT_CATEGORY (unspecified-low), whose fallback is opencode/deepseek-v4-flash-free.
const unknownResolved = resolveModel("nonsense-category", mockRegistry([["zai-coding-cn", "glm-4.7"]]));
eq(
  "resolveModel(unknown): falls to DEFAULT_CATEGORY primary",
  [unknownResolved.category, unknownResolved.modelFlag],
  [DEFAULT_CATEGORY, "zai-coding-cn/glm-4.7"],
);
eq(
  "resolveModel(unknown): DEFAULT_CATEGORY fallbackFlags",
  unknownResolved.fallbackFlags,
  ["opencode/deepseek-v4-flash-free"],
);

// Registry missing find() → throws (contract guard).
let threwNoFind = false;
try {
  // biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard path
  resolveModel("deep", {} as ModelRegistryLike);
} catch {
  threwNoFind = true;
}
check("resolveModel: throws when registry lacks find()", threwNoFind);

// Neither primary nor global in registry → throws.
let threwNeither = false;
try {
  resolveModel("deep", mockRegistry([]));
} catch {
  threwNeither = true;
}
check("resolveModel: throws when neither primary nor global resolves", threwNeither);

// ── Strong-model-at-judging invariant (data guard) ───────────────────────────
// The 3 judging categories' fallback arrays (deep/ultrabrain/unspecified-high) MUST land only on
// glm-5.x / kimi — never FREE/cheap tiers. Plus every category must have ≥1 fallback (global tail is
// spawn.ts's concern, but the per-tier array should be non-empty for resilience).
const JUDGING = ["deep", "ultrabrain", "unspecified-high"] as const;
const STRONG_MODEL_RE = /^glm-5(\.\d)?(-highspeed)?(\/.*)?$|^kimi-/;
let allJudgingStrong = true;
let allJudgingNonEmpty = true;
for (const cat of JUDGING) {
  const arr = TIERS[cat].fallbackModels ?? [];
  if (arr.length === 0) allJudgingNonEmpty = false;
  for (const fm of arr) {
    const flag = `${fm.provider}/${fm.id}`;
    // strong = id starts with glm-5 (any variant) or kimi
    if (!/^glm-5\b/.test(fm.id) && !/^kimi-/.test(fm.id)) {
      allJudgingStrong = false;
      console.log(`    ✗ ${cat} fallback ${flag} is NOT strong-tier`);
    }
  }
}
check("INVARIANT: all judging-category fallbacks are glm-5.x/kimi", allJudgingStrong);
check("INVARIANT: all judging categories have ≥1 per-tier fallback", allJudgingNonEmpty);

// Global FALLBACK itself must be strong (it's the tail for judging categories too).
check(
  "INVARIANT: global FALLBACK is glm-5.x (strong) — safe tail for judging categories",
  /^glm-5\b/.test(FALLBACK.id),
);

// Every non-judging category also has a non-empty fallbackModels array (resilience floor).
const allCategories = Object.keys(TIERS) as Array<keyof typeof TIERS>;
const allNonEmpty = allCategories.every((c) => (TIERS[c].fallbackModels ?? []).length > 0);
check("FLOOR: every category has ≥1 per-tier fallback entry", allNonEmpty);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
