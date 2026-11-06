// extensions/tests/mini-task-tracker.test.ts — behavior tests for the
// task-ui-toggle-spin fix (2026-11-06). Run:
//   node --experimental-strip-types extensions/tests/mini-task-tracker.test.ts
// (from anywhere; imports resolve via the agent-home node_modules upward).
//
// Pins the three fixes at the extension's own seams:
//   1. SPIN-KILLER: toggle of a done task is absorbing (the old done->idle cycle
//      re-presented finished work as incomplete forever).
//   2. RESTART-LEG: a durable sidecar (~/.pi/agent/.task-state/<sid>.json)
//      survives a fresh instance with an empty branch and wins over branch
//      replay; a missing sidecar falls back to branch replay.
//   3. NAG-LEG: the incomplete banner fires ONCE per task id, never again for a
//      done task, and a new task gets its own nudge listing only pending work.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import miniTaskTracker from "../mini-task-tracker.ts";

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

const SIDECAR_DIR = path.join(homedir(), ".pi", "agent", ".task-state");

interface Snapshot {
  tasks: Array<{ id: number; status: string; text: string }>;
  nextId: number;
}
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Snapshot;
}

interface Driver {
  sid: string;
  branch: Array<Record<string, unknown>>;
  handlers: Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown>>;
  exec: (params: Record<string, unknown>) => Promise<ToolResult>;
  sent: Array<{ customType?: string; content?: string }>;
  ctx: ExtensionContext;
  destroy: () => void;
}

function makeDriver(): Driver {
  const drv = { sid: "fmtest-" + Math.random().toString(36).slice(2, 10) };
  const branch: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => Promise<unknown>>();
  let tool: { execute: Driver["exec"] } | undefined;
  const sent: Array<{ customType?: string; content?: string }> = [];
  // The ctx reads driver state LIVE (via drv), so tests can re-point a driver at
  // another session id after creation (the restart-persistence case does).
  const ctx: ExtensionContext = {
    hasUI: false,
    sessionManager: {
      getSessionId: () => drv.sid,
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;
  const api: ExtensionAPI = {
    on: ((name: string, fn: (event: never, ctx: ExtensionContext) => Promise<unknown>) => {
      handlers.set(name, fn);
      return undefined;
    }) as never,
    registerTool: ((def: { name: string; execute: unknown }) => {
      if (def.name === "task") tool = def as unknown as { execute: Driver["exec"] };
      return undefined;
    }) as never,
    registerCommand: (() => undefined) as never,
    sendMessage: ((msg: { customType?: string; content?: string }) => {
      sent.push(msg);
      return undefined;
    }) as never,
    appendEntry: (() => undefined) as never,
  } as unknown as ExtensionAPI;
  miniTaskTracker(api);
  return {
    get sid() {
      return drv.sid;
    },
    set sid(v: string) {
      drv.sid = v;
    },
    branch,
    handlers,
    sent,
    ctx,
    exec: (params) =>
      tool!.execute("tc1", params as never, undefined as never, undefined as never, ctx) as never,
    destroy() {
      try {
        rmSync(path.join(SIDECAR_DIR, `${drv.sid}.json`), { force: true });
      } catch {}
    },
  };
}

async function fireSessionStart(d: Driver): Promise<void> {
  await d.handlers.get("session_start")!(undefined as never, d.ctx);
}

async function fireAgentEnd(d: Driver): Promise<string | undefined> {
  await d.handlers.get("agent_end")!(undefined as never, d.ctx);
  return d.sent[d.sent.length - 1]?.content;
}

const tests: Array<() => Promise<void>> = [];

// 1. SPIN-KILLER: absorbing done.
tests.push(async () => {
  const d = makeDriver();
  try {
    await fireSessionStart(d);
    await d.exec({ action: "add", text: "work item" });
    const t1 = await d.exec({ action: "toggle", id: 1 });
    check("idle->inprogress", t1.details.tasks[0].status === "inprogress");
    const t2 = await d.exec({ action: "toggle", id: 1 });
    check("inprogress->done", t2.details.tasks[0].status === "done");
    const t3 = await d.exec({ action: "toggle", id: 1 });
    check("done absorbs (no cycle back to idle)", t3.details.tasks[0].status === "done");
    check("terminal reply names the boundary", /already done/.test(t3.content[0].text));
    check("no pending work after the absorbed click", t3.details.tasks.every((t) => t.status === "done"));
  } finally {
    d.destroy();
  }
});

// 2. RESTART-LEG: sidecar wins over an empty branch in a fresh instance.
tests.push(async () => {
  const d1 = makeDriver();
  try {
    await fireSessionStart(d1);
    await d1.exec({ action: "add", text: "persisted work" });
    await d1.exec({ action: "toggle", id: 1 });
    await d1.exec({ action: "toggle", id: 1 }); // done
    const d2 = makeDriver();
    d2.sid = d1.sid;
    d2.branch.length = 0; // fresh pane: empty branch, same session id
    try {
      await fireSessionStart(d2);
      const list = await d2.exec({ action: "list" });
      check(
        "restart keeps done state via sidecar",
        list.details.tasks.length === 1 && list.details.tasks[0].status === "done",
      );
      await d2.exec({ action: "clear" });
      const l2 = await d2.exec({ action: "list" });
      check("state is live-mutable after restart", l2.details.tasks.length === 0);
    } finally {
      d2.destroy();
    }
  } finally {
    d1.destroy();
  }
});

// 2b. Missing sidecar falls back to branch replay (the pre-fix path still works).
tests.push(async () => {
  const d = makeDriver();
  try {
    await fireSessionStart(d);
    await d.exec({ action: "add", text: "branch-only task" });
    const snap = (await d.exec({ action: "toggle", id: 1 })).details;
    d.branch.push({
      type: "message",
      message: { role: "toolResult", toolName: "task", details: snap },
    });
    rmSync(path.join(SIDECAR_DIR, `${d.sid}.json`), { force: true });
    const d2 = makeDriver();
    d2.sid = d.sid;
    d2.branch.length = 0;
    d2.branch.push(...d.branch);
    try {
      await fireSessionStart(d2);
      const l2 = await d2.exec({ action: "list" });
      check(
        "branch replay still works without a sidecar",
        l2.details.tasks.length === 1 && l2.details.tasks[0].status === "inprogress",
      );
    } finally {
      d2.destroy();
    }
  } finally {
    d.destroy();
  }
});

// 3. NAG-LEG: one banner per id; silence afterwards; done never nudges; a new
//    task gets its own nudge that lists ONLY pending work.
tests.push(async () => {
  const d = makeDriver();
  try {
    await fireSessionStart(d);
    await d.exec({ action: "add", text: "parked task" });
    await d.exec({ action: "toggle", id: 1 });
    const msg1 = await fireAgentEnd(d);
    check("first agent_end nudges the parked task", !!msg1 && /incomplete task/.test(msg1));
    const before = d.sent.length;
    await fireAgentEnd(d);
    check("second agent_end is silent for the same id", d.sent.length === before);
    await d.exec({ action: "toggle", id: 1 }); // done (absorbing)
    await fireAgentEnd(d);
    check("done task never nudges again", d.sent.length === before);
    await d.exec({ action: "add", text: "second work item" });
    const msg2 = await fireAgentEnd(d);
    check("a new task gets its own nudge", !!msg2 && /incomplete task/.test(msg2!));
    check("nudge lists only pending work (done excluded)", /^⚠️ 1 incomplete task/.test(msg2!) && /#2/.test(msg2!) && !/#1 \[/.test(msg2!));
  } finally {
    d.destroy();
  }
});

// Gate + widget contract unchanged for healthy flows.
tests.push(async () => {
  const d = makeDriver();
  try {
    await fireSessionStart(d);
    await d.exec({ action: "add", text: "gated work" });
    await d.exec({ action: "toggle", id: 1 });
    const snap = (await d.exec({ action: "toggle", id: 1 })).details;
    check("gate machinery unaffected through done", snap.tasks[0].status === "done");
    const l2 = await d.exec({ action: "list" });
    check("full list still works with all-done tasks", l2.details.tasks.length === 1);
  } finally {
    d.destroy();
  }
});

function cleanupSidecars(): void {
  try {
    for (const f of readdirSync(SIDECAR_DIR)) {
      if (f.startsWith("fmtest-") && f.endsWith(".json")) {
        try {
          rmSync(path.join(SIDECAR_DIR, f), { force: true });
        } catch {}
      }
    }
  } catch {}
}

(async () => {
  mkdirSync(SIDECAR_DIR, { recursive: true });
  try {
    for (const t of tests) await t();
  } finally {
    cleanupSidecars();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
