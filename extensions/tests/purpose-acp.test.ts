// extensions/tests/purpose-acp.test.ts — PI_PURPOSE env-adoption invariant tests (design-v0.2).
// Run: node --experimental-strip-types purpose-acp.test.ts   (from extensions/tests/)
//
// Proves the 8 scenarios of design-v0.2 (all verdict conditions from sis-verdict-v0.1.md):
//   (1) rpc + env + unset purpose → ADOPTED (provenance source:"env"), NO dialog attempted.
//   (2) tui + env + unset → NOT adopted; dialog path byte-for-byte unchanged.
//   (3) env + existing purpose → existing wins (env never overrides a SET purpose).
//   (4) whitespace-only env → ignored (and the input gate still BLOCKS — adoption didn't weaken it).
//   (5) belt-and-braces: input-gate adoption when session_start did not adopt.
//   (6) cleared purpose → rpc resume + env → adoption FIRES (pinned: cleared = authoritative unset).
//   (7) json mode + env → no adoption.
//   (8) print mode + env → no adoption.
//
// Harness: drives the real extension module (default export) against a stub ExtensionAPI
// (on/registerCommand/appendEntry captured) and a stub ExtensionContext (mode/hasUI/
// sessionManager/ui recorded), exactly like chain-clarify.test.ts stubs its ctx. Entry
// shape per pi docs §1471: appendEntry(customType, data) → { type:"custom", customType, data }.
import ext, { readPurpose } from "../mini-purpose-gate.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

interface PurposeEntry {
  type: "custom";
  customType: "purpose";
  data: { text: string | null; source?: string };
}

interface Harness {
  ctx: ExtensionContext;
  entries: PurposeEntry[]; // the mock session store — readPurpose reads this too
  calls: {
    input: Array<{ prompt: string; placeholder?: string }>;
    notify: Array<[string, string]>;
    setWidget: number;
  };
  fire: (event: "session_start" | "input") => Promise<unknown>;
}

function harness(opts: {
  mode: string;
  hasUI: boolean;
  existing?: Array<{ text: string | null; source?: string }>; // pre-seeded purpose entries
}): Harness {
  const entries: PurposeEntry[] = (opts.existing ?? []).map((d) => ({
    type: "custom",
    customType: "purpose",
    data: d,
  }));
  const calls = { input: [] as Array<{ prompt: string; placeholder?: string }>, notify: [] as Array<[string, string]>, setWidget: 0 };
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>();

  const pi = {
    on: (ev: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => void handlers.set(ev, fn),
    registerCommand: (_name: string, _def: unknown) => {},
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data } as PurposeEntry);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    mode: opts.mode,
    hasUI: opts.hasUI,
    sessionManager: { getEntries: (): PurposeEntry[] => entries },
    ui: {
      input: async (prompt: string, placeholder?: string) => {
        calls.input.push({ prompt, placeholder });
        return ""; // cancelled — promptOnce's no-loop path
      },
      notify: (msg: string, kind: string) => void calls.notify.push([msg, kind]),
      setWidget: (_name: string, _factory: unknown) => void calls.setWidget++,
    },
  } as unknown as ExtensionContext;

  ext(pi); // fresh closure → fresh `purpose` state per harness

  return {
    ctx,
    entries,
    calls,
    fire: (event) => {
      const fn = handlers.get(event);
      if (!fn) throw new Error(`no handler registered for '${event}'`);
      return fn(undefined, ctx);
    },
  };
}

const ENV_NAME = "PI_PURPOSE";
const adopted = (h: Harness) => h.calls.notify.some(([m, k]) => m === "Purpose adopted from PI_PURPOSE (rpc)" && k === "info");
const lastPurpose = (h: Harness) => h.entries.filter((e) => e.customType === "purpose").at(-1)?.data;

// save/restore env around every scenario — the suite must leave the process env untouched
const ORIG_ENV = process.env[ENV_NAME];
const setEnv = (v: string | undefined) => {
  if (v === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = v;
};

async function flush(): Promise<void> {
  // promptOnce is void-fired (not awaited by session_start) — let its microtasks settle
  await new Promise((r) => setTimeout(r, 0));
}

// --- (1) rpc + env set + no purpose → adopted, no dialog attempted ---
{
  setEnv("Refactor the auth module to use JWT");
  const h = harness({ mode: "rpc", hasUI: true });
  await h.fire("session_start");
  await flush();
  const last = lastPurpose(h);
  check("(1) rpc+env+unset: adopted with text", last?.text === "Refactor the auth module to use JWT");
  check("(1) rpc+env+unset: provenance source:\"env\"", last?.source === "env");
  check("(1) rpc+env+unset: NO dialog attempted", h.calls.input.length === 0);
  check("(1) rpc+env+unset: adoption notify (info)", adopted(h));
  check("(1) rpc+env+unset: pure reader sees it (readPurpose)", readPurpose(h.ctx) === "Refactor the auth module to use JWT");
  setEnv(ORIG_ENV);
}

// --- (2) tui + env set + no purpose → NOT adopted (dialog path unchanged) ---
{
  setEnv("env-injected purpose");
  const h = harness({ mode: "tui", hasUI: true });
  await h.fire("session_start");
  await flush();
  check("(2) tui+env: NOT adopted (no purpose entry)", h.entries.filter((e) => e.customType === "purpose").length === 0);
  check("(2) tui+env: dialog path unchanged (promptOnce fired)", h.calls.input.length === 1);
  check("(2) tui+env: no adoption notify", !adopted(h));
  setEnv(ORIG_ENV);
}

// --- (3) env set + existing purpose → existing wins ---
{
  setEnv("env should lose");
  const h = harness({ mode: "rpc", hasUI: true, existing: [{ text: "existing purpose" }] });
  await h.fire("session_start");
  await flush();
  check("(3) rpc+env+existing: no new purpose entry", h.entries.length === 1);
  check("(3) rpc+env+existing: existing text intact", lastPurpose(h)?.text === "existing purpose");
  check("(3) rpc+env+existing: no adoption notify", !adopted(h));
  check("(3) rpc+env+existing: no dialog (purpose already set)", h.calls.input.length === 0);
  setEnv(ORIG_ENV);
}

// --- (4) empty/whitespace env → ignored (gate still blocks) ---
{
  setEnv("   \t  ");
  const h = harness({ mode: "rpc", hasUI: true });
  await h.fire("session_start");
  await flush();
  check("(4) whitespace env: no adoption entry", h.entries.filter((e) => e.customType === "purpose").length === 0);
  check("(4) whitespace env: no adoption notify", !adopted(h));
  // belt-and-braces didn't weaken the gate: unset purpose + rpc + whitespace env → still BLOCKED
  const res = (await h.fire("input")) as { action: string };
  check("(4) whitespace env: input gate still blocks (handled)", res.action === "handled");
  check("(4) whitespace env: gate warning points at /purpose", h.calls.notify.some(([m, k]) => m === "Set a purpose first: /purpose <text>" && k === "warning"));
  setEnv(ORIG_ENV);
}

// --- (5) input-gate adoption when session_start didn't (belt-and-braces) ---
{
  setEnv("late adoption");
  const h = harness({ mode: "rpc", hasUI: true }); // no session_start fired — simulates missed start
  const res = (await h.fire("input")) as { action: string };
  const last = lastPurpose(h);
  check("(5) input-gate adoption: adopted in the gate", last?.text === "late adoption" && last?.source === "env");
  check("(5) input-gate adoption: prompt passes (continue)", res.action === "continue");
  check("(5) input-gate adoption: adoption notify", adopted(h));
  setEnv(ORIG_ENV);
}

// --- (6) cleared purpose → rpc resume + env → adoption fires (PINNED semantic) ---
{
  setEnv("post-clear purpose");
  const h = harness({
    mode: "rpc",
    hasUI: true,
    existing: [{ text: "old purpose" }, { text: null }], // cleared is the LATEST entry
  });
  await h.fire("session_start");
  await flush();
  const last = lastPurpose(h);
  check("(6) cleared+rpc+env: adoption fires (cleared = authoritative unset)", last?.text === "post-clear purpose");
  check("(6) cleared+rpc+env: provenance source:\"env\"", last?.source === "env");
  check("(6) cleared+rpc+env: no dialog attempted", h.calls.input.length === 0);
  setEnv(ORIG_ENV);
}

// --- (7) json mode + env set → no adoption ---
{
  setEnv("json must not adopt");
  const h = harness({ mode: "json", hasUI: false });
  await h.fire("session_start");
  await flush();
  check("(7) json mode: no adoption entry", h.entries.filter((e) => e.customType === "purpose").length === 0);
  check("(7) json mode: no adoption notify", !adopted(h));
  check("(7) json mode: no dialog (hasUI false)", h.calls.input.length === 0);
  setEnv(ORIG_ENV);
}

// --- (8) print mode + env set → no adoption ---
{
  setEnv("print must not adopt");
  const h = harness({ mode: "print", hasUI: false });
  await h.fire("session_start");
  await flush();
  check("(8) print mode: no adoption entry", h.entries.filter((e) => e.customType === "purpose").length === 0);
  check("(8) print mode: no adoption notify", !adopted(h));
  check("(8) print mode: no dialog (hasUI false)", h.calls.input.length === 0);
  setEnv(ORIG_ENV);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
