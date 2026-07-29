// extensions/tests/chain-clarify.test.ts — render-snapshot + state-machine transition tests.
// Run: node --experimental-strip-types chain-clarify.test.ts   (from extensions/tests/)
//
// Covers the bug surface Oracle flagged: the editMode state machine (list/model/thinking) edges,
// picker exit, selection movement, and the done()-fires-once invariant. Stubs TUI/theme/ctx with
// identity theme.fg so render() output is plain deterministic text. (The editor() modal +
// real overlay are exercised by the operator smoke test, not here.)
import { ChainClarifyComponent, type ChainClarifyResult } from "../chain-clarify.ts";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme, KeybindingsManager, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Chain } from "../chain-runner.ts";

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

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";

interface Stub {
  comp: ChainClarifyComponent;
  result: () => ChainClarifyResult | undefined;
  count: () => number;
}

function makeComponent(task = "do the thing"): Stub {
  let res: ChainClarifyResult | undefined;
  let n = 0;
  const done = (r: ChainClarifyResult): void => {
    res = r;
    n++;
  };
  const tui = { requestRender(): void {} };
  const theme = { fg: (_c: string, t: string): string => t, bold: (t: string): string => t };
  const ctx = { modelRegistry: { getAvailable: (): Array<{ provider: string; id: string }> => [{ provider: "p", id: "m1" }, { provider: "p", id: "m2" }] } };
  const chain = {
    description: "test chain",
    default_category: "unspecified-low",
    steps: [
      { name: "a", agent: "keymaker", category: "unspecified-low", prompt: "find $INPUT $ORIGINAL" },
      { name: "b", agent: "trinity", prompt: "build it" },
    ],
  };
  const comp = new ChainClarifyComponent(
    tui as unknown as TUI,
    theme as unknown as Theme,
    {} as unknown as KeybindingsManager,
    done,
    ctx as unknown as ExtensionContext,
    "testchain",
    chain as unknown as Chain,
    task,
    {},
  );
  return { comp, result: () => res, count: () => n };
}

const text = (c: ChainClarifyComponent): string => c.render(84).join("\n");

// --- render snapshots ---
const a = makeComponent();
const listOut = text(a.comp);
check("snapshot[list]: chain name in header", listOut.includes("clarify · testchain"));
check("snapshot[list]: task shown", listOut.includes("do the thing"));
check("snapshot[list]: both step agents", listOut.includes("keymaker") && listOut.includes("trinity"));
check("snapshot[list]: footer key hints", listOut.includes("Esc cancel") && listOut.includes("run") && listOut.includes("model"));

const b = makeComponent();
b.comp.handleInput("m");
const pickerOut = text(b.comp);
check("snapshot[model picker]: header", pickerOut.includes("model:"));
check("snapshot[model picker]: lists available models", pickerOut.includes("m1") && pickerOut.includes("m2"));

// --- transitions (state-machine edges) ---
check("transition[select]: step 0 selected initially", text(a.comp).includes("▸ keymaker"));
const d = makeComponent();
d.comp.handleInput(DOWN);
const afterDown = text(d.comp);
check("transition[select]: down moves selection to step 1", afterDown.includes("▸ trinity") && !afterDown.includes("▸ keymaker"));

const c = makeComponent();
c.comp.handleInput("m");
check("transition[picker]: m enters model picker", text(c.comp).includes("model:"));
c.comp.handleInput(ESC);
check("transition[picker]: Esc exits picker back to list", text(c.comp).includes("clarify · testchain"));

// --- done() fires exactly once (the no-double-resolve invariant) ---
const e = makeComponent();
e.comp.handleInput(ENTER);
check("transition[confirm]: Enter confirms", e.result()?.confirmed === true);
e.comp.handleInput(ENTER);
check("INVARIANT: done() fires exactly once (no double-resolve)", e.count() === 1);

// --- Esc cancels from list ---
const f = makeComponent();
f.comp.handleInput(ESC);
check("transition[cancel]: Esc in list cancels", f.result()?.confirmed === false);

// --- model picker select applies an override, returns to list ---
const g = makeComponent();
g.comp.handleInput("m");
g.comp.handleInput(ENTER); // select current picker item → apply, back to list
check("transition[apply]: selecting in picker returns to list", text(g.comp).includes("clarify · testchain"));
check("transition[apply]: applied model flagged as edited", text(g.comp).includes("edited: model"));

// --- edit signal (exit-reopen: p/e resolve done with an `edit` so the caller opens editor alone) ---
const h = makeComponent();
h.comp.handleInput("p");
const hr = h.result();
check("transition[edit]: p signals prompt edit (exit, not confirmed)", hr?.confirmed === false && hr?.edit?.kind === "prompt" && hr?.edit?.stepName === "a");
const he = makeComponent();
he.comp.handleInput("e");
check("transition[edit]: e signals task edit (exit)", he.result()?.edit?.kind === "task");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
