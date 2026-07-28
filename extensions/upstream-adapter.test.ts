// D6 adapter tests + growth-policy LOC-budget enforcement.
// Run: node --experimental-strip-types upstream-adapter.test.ts
import { readFileSync } from "node:fs";
import { isHumanTurn, probeDialogApi, ADAPTER_FORK_THRESHOLDS } from "./upstream-adapter.ts";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}`);
  }
}

// isHumanTurn — the 0.79.9→0.80.x semantics (the actual break that needs one edit site).
check("human interactive prompt", isHumanTurn({ source: "interactive" }) === true);
check("extension self-sent prompt (the loop culprit)", isHumanTurn({ source: "extension" }) === false);
check("missing source is not human", isHumanTurn({}) === false);
check("unknown source is not human", isHumanTurn({ source: "rpc" }) === false);

// probeDialogApi — visibility into which dialog primitives exist (audits a silent drop).
{
  const full = probeDialogApi({
    hasUI: true,
    ui: { confirm: () => {}, select: () => {}, custom: () => {}, input: () => {} },
  });
  check("probe: full ctx", full.hasUI && full.hasConfirm && full.hasSelect && full.hasCustom && full.hasInput);
}
{
  const partial = probeDialogApi({ hasUI: true, ui: { custom: () => {} } });
  check("probe: only custom (the 0.80.3 preflight survivor)", partial.hasCustom && !partial.hasConfirm && !partial.hasSelect);
}
{
  const none = probeDialogApi({ hasUI: false, ui: {} });
  check("probe: print mode (no UI)", !none.hasUI && !none.hasConfirm);
}

// Growth-policy LOC-budget enforcement (v1.1 probe-5): the adapter must stay tight.
// Breaching the budget fails the build → forces the fork conversation rather than
// silent growth into a fork.
{
  const lines = readFileSync(new URL("./upstream-adapter.ts", import.meta.url), "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("//")).length;
  check(
    `adapter under budget (LOC ${lines} ≤ ${ADAPTER_FORK_THRESHOLDS.maxLocPerSurface})`,
    lines <= ADAPTER_FORK_THRESHOLDS.maxLocPerSurface,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
