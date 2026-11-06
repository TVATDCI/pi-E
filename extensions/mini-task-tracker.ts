// Lesson 0005 build-along: mini-task-tracker — session-scratch task list + mutation gate
// (keystone of pi session discipline). NOT a tracker of record: bd is the umbrella tracker;
// this extension never persists, syncs, or writes bd (Oracle P4 verdict 2026-09-07).
// Grounded in disler/pi-vs-claude-code tilldone.ts + Pi extensions.md.
// Corrected: typebox import (not @sinclair/typebox), Type.Union (not StringEnum),
// session_start only (session_switch/session_fork don't exist).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { SelectItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

type Status = "idle" | "inprogress" | "done";
interface Task { id: number; text: string; status: Status; }
interface TaskDetails { action: string; tasks: Task[]; nextId: number; error?: string; }

// Toggle semantics (task-ui-toggle-spin fix, 2026-11-06): done is ABSORBING.
// The old cycle (done -> idle) let the agent's own "mark done" click spin a task
// straight back to idle, which re-triggered the guard banner forever.
const NEXT: Record<Status, Status> = { idle: "inprogress", inprogress: "done", done: "done" };
const ICON: Record<Status, string> = { idle: "○", inprogress: "●", done: "✓" };
// Max pending rows shown in the always-on widget (done is collapsed into the
// count). Keeps the widget bounded; browse the full stack via the /tasks overlay.
const MAX_VISIBLE = 4;

const Params = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("toggle"),
    Type.Literal("list"),
    Type.Literal("clear"),
  ]),
  text: Type.Optional(Type.String({ description: "Task text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Task ID (for toggle)" })),
});

// Durable sidecar state (the restart leg of the toggle-spin fix): the session
// branch replay time-travels with the branch pointer, so a resumed or forked
// session could resurrect done tasks as incomplete. The sidecar holds the
// session's LAST mutation state on disk and wins over branch replay; a missing
// or unparsable sidecar falls back to the branch as before.
const SIDECAR_DIR = () => path.join(homedir(), ".pi", "agent", ".task-state");
const SIDECAR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Sidecar {
  tasks: Task[];
  nextId: number;
  savedAt: number;
}

function sidecarPath(sessionId: string): string {
  return path.join(SIDECAR_DIR(), `${sessionId}.json`);
}

function persistKernel(sessionId: string, state: Sidecar): boolean {
  try {
    mkdirSync(SIDECAR_DIR(), { recursive: true });
    writeFileSync(sidecarPath(sessionId), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function loadSidecar(sessionId: string): Sidecar | undefined {
  try {
    const file = sidecarPath(sessionId);
    if (!existsSync(file)) return undefined;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Sidecar;
    if (!Array.isArray(raw?.tasks)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let tasks: Task[] = [];
  let nextId = 1;
  let currentSessionId: string | undefined;
  // Nudge-once-per-task (the nag leg of the toggle-spin fix): a parked task must
  // not re-fire the incomplete banner on every turn - one nudge per task id,
  // cleared only when the list changes identity (reconstruct/clear).
  const nudgedTaskIds = new Set<number>();

  function persist(): void {
    if (!currentSessionId) return;
    persistKernel(currentSessionId, { tasks, nextId, savedAt: Date.now() });
  }

  const snapshot = (action: string, error?: string): TaskDetails => ({
    action,
    tasks: [...tasks],
    nextId,
    ...(error ? { error } : {}),
  });

  const render = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("tasks", (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        if (tasks.length === 0)
          return [theme.fg("muted", "📌 no tasks — use the task tool to add some")];
        const done = tasks.filter((t) => t.status === "done").length;
        const header = theme.fg("accent", `📌 tasks [${done}/${tasks.length}]`);
        // Compact: show pending work only (done is collapsed into the count).
        // in-progress first, then idle; cap rows so the widget never grows tall.
        const pending = tasks
          .filter((t) => t.status !== "done")
          .sort(
            (a, b) =>
              Number(b.status === "inprogress") - Number(a.status === "inprogress") ||
              a.id - b.id,
          );
        if (pending.length === 0)
          return [`${header}${theme.fg("success", " ✓ all done")}`];
        const visible = pending.slice(0, MAX_VISIBLE);
        const hidden = pending.length - visible.length;
        const rows = visible.map((t) => {
          const icon = theme.fg(t.status === "inprogress" ? "accent" : "dim", ICON[t.status]);
          const id = theme.fg("accent", `#${t.id}`);
          const txt = theme.fg(t.status === "inprogress" ? "text" : "muted", t.text);
          return truncateToWidth(`  ${icon} ${id} ${txt}`, width);
        });
        const lines = [header, ...rows];
        if (hidden > 0)
          lines.push(theme.fg("dim", `  … +${hidden} more · /tasks to browse`));
        return lines;
      },
    }));
    ctx.ui.setStatus("tasks", `📋 ${tasks.length} task(s)`);
  };

  // Replay state from the session branch on startup (covers new session + /resume),
  // then prefer the durable sidecar for this session id when one exists.
  const reconstruct = (ctx: ExtensionContext) => {
    tasks = [];
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "task") continue;
      const d = msg.details as TaskDetails | undefined;
      if (d) {
        tasks = d.tasks.map((t) => ({ ...t }));
        nextId = d.nextId;
      }
    }
    const sid = currentSessionId ?? ctx.sessionManager?.getSessionId?.();
    if (sid) {
      const sidecar = loadSidecar(sid);
      if (sidecar) {
        tasks = sidecar.tasks.map((t) => ({ ...t }));
        nextId = sidecar.nextId;
      }
    }
    nudgedTaskIds.clear();
    render(ctx);
  };

  let lastSessionId: string | undefined;

  pi.on("session_start", async (_e, ctx) => {
    currentSessionId = ctx.sessionManager.getSessionId();
    lastSessionId = currentSessionId;
    // Prune week-old sidecars: best-effort hygiene, never blocks the start.
    try {
      const dir = SIDECAR_DIR();
      if (existsSync(dir)) {
        const cutoff = Date.now() - SIDECAR_MAX_AGE_MS;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const full = path.join(dir, f);
          try {
            const st = JSON.parse(readFileSync(full, "utf8")) as Sidecar;
            if (typeof st?.savedAt === "number" && st.savedAt < cutoff) {
              try { unlinkSync(full); } catch {}
            }
          } catch {}
        }
      }
    } catch {}
    reconstruct(ctx);
  });

  // session_start does NOT fire on /resume — detect session-ID change on every turn
  pi.on("turn_start", async (_e, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid !== lastSessionId) {
      lastSessionId = sid;
      currentSessionId = sid;
      reconstruct(ctx);
    }
  });

  // Tools that never change repo state — always allowed without a task.
  // Only mutation tools (bash, write, edit) and delegation (dispatch, run_chain)
  // require an in-progress task. Information gathering informs the plan; it IS not work.
  const ALWAYS_ALLOWED = new Set([
    "task",
    "memory_remember",
    "read",
    "grep",
    "find",
    "ls",
    "search",
    "fetch",
  ]);

  pi.on("tool_call", async (event, _ctx) => {
    if (ALWAYS_ALLOWED.has(event.toolName)) return { block: false };
    const pending = tasks.filter((t) => t.status !== "done").length;
    const inprogress = tasks.filter((t) => t.status === "inprogress").length;
    if (tasks.length === 0)
      return { block: true, reason: "🚫 No tasks defined. Use task(action:add) to plan BEFORE working." };
    if (pending === 0)
      return { block: true, reason: "🛑 All tasks done. Use task(action:add) or you're finished." };
    if (inprogress === 0)
      return { block: true, reason: "🛑 No task in progress. Use task(action:toggle,id) to start one." };
    return { block: false };
  });

  pi.on("agent_end", async (_event, _ctx) => {
    const incomplete = tasks.filter(
      (t) => t.status !== "done" && !nudgedTaskIds.has(t.id),
    );
    if (incomplete.length === 0) return;
    for (const t of incomplete) nudgedTaskIds.add(t.id);
    const list = tasks
      .filter((t) => t.status !== "done")
      .map((t) => `  ${ICON[t.status]} #${t.id} [${t.status}]: ${t.text}`)
      .join("\n");
    pi.sendMessage(
      {
        customType: "tilldone-nudge",
        content: `⚠️ ${incomplete.length} incomplete task(s):\n\n${list}\n\nContinue or mark done. Don't stop until done!`,
        display: true,
      },
      { triggerTurn: true },
    );
  });

  // Nudge cadence is per-task-id (nudgedTaskIds) rather than per human turn:
  // the old per-turn reset (isHumanTurn in lib/upstream-adapter.ts, D6 seam)
  // re-fired the incomplete banner after every human message while a lawfully
  // parked task stayed open, feeding the toggle-spin loop.

  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      "Manage the session task list (replaces bd). Actions: add (text) creates an idle task; " +
      "toggle (id) cycles idle→inprogress→done; list shows all; clear wipes. " +
      "Toggle a task to inprogress BEFORE starting work on it; to done when finished. " +
      "Only one task can be inprogress at a time.",
    parameters: Params,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "add": {
          if (!params.text)
            return {
              content: [{ type: "text" as const, text: "Error: text required" }],
              details: snapshot("add", "text required"),
            };
          const t: Task = { id: nextId++, text: params.text, status: "idle" };
          tasks.push(t);
          persist();
          const r = {
            content: [{ type: "text" as const, text: `Added #${t.id}: ${t.text}` }],
            details: snapshot("add"),
          };
          render(ctx);
          return r;
        }
        case "toggle": {
          if (params.id === undefined)
            return {
              content: [{ type: "text" as const, text: "Error: id required" }],
              details: snapshot("toggle", "id required"),
            };
          const t = tasks.find((x) => x.id === params.id);
          if (!t)
            return {
              content: [{ type: "text" as const, text: `#${params.id} not found` }],
              details: snapshot("toggle", "not found"),
            };
          const prev = t.status;
          t.status = NEXT[t.status];
          if (t.status === prev && t.status === "done") {
            return {
              content: [{
                type: "text" as const,
                text: `#${t.id} is already done — done is terminal under the toggle-spin fix; use clear to reset the list.`,
              }],
              details: snapshot("toggle"),
            };
          }
          // Single-inprogress enforcement: demote any other inprogress task
          if (t.status === "inprogress")
            for (const x of tasks)
              if (x.id !== t.id && x.status === "inprogress") x.status = "idle";
          persist();
          const r = {
            content: [{ type: "text" as const, text: `#${t.id}: ${prev} → ${t.status}` }],
            details: snapshot("toggle"),
          };
          render(ctx);
          return r;
        }
        case "list": {
          const text = tasks.length
            ? tasks
                .map((t) => `[${ICON[t.status]}] #${t.id} (${t.status}): ${t.text}`)
                .join("\n")
            : "No tasks.";
          return {
            content: [{ type: "text" as const, text }],
            details: snapshot("list"),
          };
        }
        case "clear": {
          const n = tasks.length;
          tasks = [];
          nextId = 1;
          nudgedTaskIds.clear();
          persist();
          const r = {
            content: [{ type: "text" as const, text: `Cleared ${n} task(s)` }],
            details: snapshot("clear"),
          };
          render(ctx);
          return r;
        }
        default:
          return {
            content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
            details: snapshot("list", "unknown"),
          };
      }
    },
  });

  // /tasks — scrollable overlay to browse the FULL task stack. The always-on
  // widget is capped at MAX_VISIBLE pending rows; this surfaces everything.
  // Rationale: pi widgets (setWidget) are display-only and cannot take keyboard
  // input, so browsing with ↑↓ lives here in a ctx.ui.custom() SelectList.
  pi.registerCommand("tasks", {
    description:
      "Browse all session tasks in a scrollable overlay (↑↓ navigate, enter/esc to close).",
    handler: async (_args, ctx) => {
      if (tasks.length === 0) {
        ctx.ui.notify("No tasks to browse", "info");
        return;
      }
      const doneCount = tasks.filter((t) => t.status === "done").length;
      const items: SelectItem[] = tasks.map((t) => ({
        value: String(t.id),
        label: `${ICON[t.status]} #${t.id} ${t.text}`,
        description: t.status,
      }));
      await ctx.ui.custom<string | null>((tui, theme, _kb, doneCb) => {
        const container = new Container();
        container.addChild(
          new Text(
            theme.fg(
              "accent",
              theme.bold(
                `📋 tasks [${doneCount}/${tasks.length}]   ↑↓ scroll · enter/esc close`,
              ),
            ),
            1,
            0,
          ),
        );
        const list = new SelectList(items, Math.min(items.length, 8), {
          selectedPrefix: (s: string) => theme.fg("accent", s),
          selectedText: (s: string) => theme.fg("accent", s),
          description: (s: string) => theme.fg("muted", s),
          scrollInfo: (s: string) => theme.fg("dim", s),
          noMatch: (s: string) => theme.fg("warning", s),
        });
        list.onSelect = () => doneCb(null);
        list.onCancel = () => doneCb(null);
        container.addChild(list);
        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}
