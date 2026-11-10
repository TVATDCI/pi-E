// prompt-chain.test.ts — handler-level pins for the drift-tripwire chain (audit F3).
// Run: node --experimental-strip-types tests/prompt-chain.test.ts
//
// prompt-hash.test.ts pins the protocol helpers on fixtures; this file drives the REAL
// handlers end-to-end:
//   - prompt-coordinator's before_agent_start: wrapper emission + position, per-project
//     insensitivity (incl. audit F2 embedded-tag projects), lane-inbox volatility through
//     the real inbox dir (audit F1), machine-turn skip, and the outer-catch shell-failure
//     path returning the bare base prompt (⇒ hash-of-empty ⇒ drift);
//   - prompt-observer's agent_start: machine-turn skip, per-session dedup, drift entry +
//     notify on a wrapper-less prompt, 1.1.0-shape events (no messageType field).
//
// HOME is redirected to a scratch dir BEFORE the coordinator is dynamically imported: the
// handler's composeFacts() telemetry appends to <homedir>/coordinator.log and reads
// memory/bridge/lane-inbox — the scratch home keeps the suite off the live desk and makes
// the composed output deterministic (no facts, no purpose; bridge placeholder + sentinel
// are both volatile-stripped).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH_HOME = mkdtempSync(join(tmpdir(), "prompt-chain-"));
process.env.HOME = SCRATCH_HOME;

const { default: registerCoordinator } = await import("../prompt-coordinator.ts");
const { default: registerObserver } = await import("../prompt-observer.ts");
const { hashPrompt, isKnownGood, OWNERSHIP_TAG } = await import("../lib/prompt-hash.ts");

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

const HASH_OF_EMPTY = "e3b0c44298fc1c14"; // sha256("") sliced to 16 hex
const BASE = "pi base system prompt (mock — pi-owned).";
const PROJ_A = '<project_instructions path="/a/AGENTS.md">\nproject A rules\n</project_instructions>';
const PROJ_B = '<project_instructions path="/b/CLAUDE.md">\nCOMPLETELY DIFFERENT project B rules\n</project_instructions>';
// Audit F2: a project whose AGENTS.md literally embeds ownership tags (paired + unpaired).
const PROJ_EMBEDS_TAGS =
  '<project_instructions path="/z/AGENTS.md">\n# pasted extension docs\n<extension-owned>note</extension-owned>\nunpaired <extension-owned> open tag\n</project_instructions>';

function captureHandlers(appendEntry?: (type: string, data: unknown) => void) {
  const handlers: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const pi = {
    on: (name: string, fn: (...args: unknown[]) => unknown) => (handlers[name] ??= []).push(fn),
    appendEntry,
  };
  return { pi, handlers };
}

// ── prompt-coordinator: before_agent_start handler ──────────────────────────────
const { pi: coordPi, handlers: coordHandlers } = captureHandlers();
registerCoordinator(coordPi as never);
const compose = async (systemPrompt: string, messageType?: string) =>
  (await coordHandlers["before_agent_start"][0]({ systemPrompt, ...(messageType ? { messageType } : {}) }, { sessionManager: { getEntries: () => [] } })) as
    | { systemPrompt: string }
    | undefined;

const outA = await compose(BASE + "\n\n" + PROJ_A, "user");
check("coordinator registered exactly one before_agent_start handler", coordHandlers["before_agent_start"].length === 1);
check("happy path returns a composed systemPrompt", typeof outA?.systemPrompt === "string");
check(
  "wrapper sits exactly at event.systemPrompt + \"\\n\\n\" (pi-side prefix preserved verbatim, wrapper after it)",
  outA!.systemPrompt.startsWith(BASE + "\n\n" + PROJ_A + `\n\n<${OWNERSHIP_TAG}>`),
);
check("wrapper closes at the end of the emitted prompt", outA!.systemPrompt.trimEnd().endsWith(`</${OWNERSHIP_TAG}>`));
check("static sections (Cost Discipline, Session notes) inside the wrapper", outA!.systemPrompt.includes("## Cost Discipline") && outA!.systemPrompt.includes("## Session notes"));

const outB = await compose(BASE + "\n\n" + PROJ_B, "user");
check(
  "END-TO-END: different project's AGENTS.md content ⇒ SAME hash through the real handler",
  hashPrompt(outA!.systemPrompt) === hashPrompt(outB!.systemPrompt),
);
const outZ = await compose(BASE + "\n\n" + PROJ_EMBEDS_TAGS, "user");
check(
  "END-TO-END (audit F2): project embedding literal owned tags ⇒ SAME hash through the real handler",
  hashPrompt(outZ!.systemPrompt) === hashPrompt(outA!.systemPrompt),
);

check("machine turn (non-\"user\" messageType) skips composition — coordinator guard", (await compose(BASE, "triggerTurn")) === undefined);

// Audit F1 end-to-end: real lane-inbox dir in the scratch home — sentinel appears/disappears.
const hashNoInbox = hashPrompt(outA!.systemPrompt);
const inboxDir = join(homedir(), "lane-inbox");
mkdirSync(inboxDir, { recursive: true });
writeFileSync(join(inboxDir, "unread-lane.md"), "peer message\n", "utf8");
const outInbox = await compose(BASE + "\n\n" + PROJ_A, "user");
check("unread lane mail injects the sentinel block into the wrapper", outInbox!.systemPrompt.includes("<lane-inbox-sentinel>"));
check("END-TO-END (audit F1): sentinel present ⇒ SAME hash (routine lane traffic is not drift)", hashPrompt(outInbox!.systemPrompt) === hashNoInbox);
rmSync(join(inboxDir, "unread-lane.md"));
const outInboxCleared = await compose(BASE + "\n\n" + PROJ_A, "user");
check("END-TO-END (audit F1): sentinel consumed/absent ⇒ SAME hash", hashPrompt(outInboxCleared!.systemPrompt) === hashNoInbox);

// Shell-failure path (MUST-FIX-4 outer catch): synthetic trigger — a systemPrompt getter
// that throws on FIRST access (the shell reads it once, the catch re-reads it and returns
// it bare). Pins that the catch returns the bare base prompt with NO wrapper.
let getterCalls = 0;
const throwingEvent = {
  get systemPrompt() {
    getterCalls++;
    if (getterCalls === 1) throw new Error("synthetic shell failure");
    return BASE;
  },
  messageType: "user",
};
const outFail = (await coordHandlers["before_agent_start"][0](throwingEvent, { sessionManager: { getEntries: () => [] } })) as { systemPrompt: string };
check("outer catch fired (getter read twice: shell + catch)", getterCalls === 2);
check("shell-failure path returns the BARE base prompt — no wrapper", outFail.systemPrompt === BASE && !outFail.systemPrompt.includes(`<${OWNERSHIP_TAG}>`));
check("bare base prompt hashes to hash-of-empty and trips drift (lost scaffolding is loud)", hashPrompt(outFail.systemPrompt) === HASH_OF_EMPTY && isKnownGood(HASH_OF_EMPTY) === false);

// ── prompt-observer: agent_start handler ────────────────────────────────────────
const entries: { type: string; data: Record<string, unknown> }[] = [];
const uiMsgs: string[] = [];
const { pi: obsPi, handlers: obsHandlers } = captureHandlers((type, data) => entries.push({ type, data: data as Record<string, unknown> }));
registerObserver(obsPi as never);
const observe = async (event: Record<string, unknown>, prompt: string | undefined) =>
  await obsHandlers["agent_start"][0](event, {
    getSystemPrompt: () => prompt,
    hasUI: true,
    ui: { notify: (m: string) => uiMsgs.push(m) },
  });

observe({ messageType: "user" }, outA!.systemPrompt);
check("observer registered exactly one agent_start handler", obsHandlers["agent_start"].length === 1);
check("user turn on composed prompt ⇒ prompt-composition entry logged", entries.length === 1 && entries[0].type === "prompt-composition");
check(
  "entry carries the scoped hash, known=true, drift=false (seeded known-good set — re-seed follow-through)",
  entries[0].data.hash === hashNoInbox && entries[0].data.known === true && entries[0].data.drift === false,
);
check("no drift warning on the seeded known-good hash", uiMsgs.length === 0);
observe({ messageType: "user" }, outA!.systemPrompt);
check("identical hash within the session ⇒ deduped (no second entry)", entries.length === 1);
observe({ messageType: "triggerTurn" }, outA!.systemPrompt);
check("machine turn skipped entirely (no entry, no notify — audit F3b)", entries.length === 1 && uiMsgs.length === 0);
observe({ messageType: "user" }, BASE); // wrapper-less prompt
check("wrapper-less prompt ⇒ new drift entry with hash-of-empty", entries.length === 2 && entries[1].data.hash === HASH_OF_EMPTY && entries[1].data.drift === true);
observe({}, outA!.systemPrompt); // 1.1.0 shape: no messageType field ⇒ guard no-ops, treated as user
check("1.1.0-shape event (no messageType) still hashes (guard is a no-op there)", entries.length === 3 && entries[2].data.hash === hashNoInbox);

// ── cleanup ─────────────────────────────────────────────────────────────────────
rmSync(SCRATCH_HOME, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
