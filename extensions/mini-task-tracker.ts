// Lesson 0005 build-along: mini-task-tracker — the bd replacement (Layer 1 keystone).
// Grounded in disler/pi-vs-claude-code tilldone.ts + Pi extensions.md.
// Corrected: typebox import (not @sinclair/typebox), Type.Union (not StringEnum),
// session_start only (session_switch/session_fork don't exist).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";

type Status = "idle" | "inprogress" | "done";
interface Task { id: number; text: string; status: Status; }
interface TaskDetails { action: string; tasks: Task[]; nextId: number; error?: string; }

const NEXT: Record<Status, Status> = { idle: "inprogress", inprogress: "done", done: "idle" };
const ICON: Record<Status, string> = { idle: "○", inprogress: "●", done: "✓" };

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

export default function (pi: ExtensionAPI) {
  let tasks: Task[] = [];
  let nextId = 1;
  let nudgedThisCycle = false;

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
          return [theme.fg("muted", "📋 no tasks — use the task tool to add some")];
        const done = tasks.filter((t) => t.status === "done").length;
        const header = theme.fg("accent", `📋 tasks [${done}/${tasks.length}]`);
        const rows = tasks.map((t) => {
          const icon = theme.fg(
            t.status === "done" ? "success" : t.status === "inprogress" ? "accent" : "dim",
            ICON[t.status],
          );
          const id = theme.fg("accent", `#${t.id}`);
          const txt = theme.fg(t.status === "done" ? "dim" : "muted", t.text);
          return truncateToWidth(`  ${icon} ${id} ${txt}`, width);
        });
        return [header, ...rows];
      },
    }));
    ctx.ui.setStatus("tasks", `📋 ${tasks.length} task(s)`);
  };

  // Replay state from the session branch on startup (covers new session + /resume)
  const reconstruct = (ctx: ExtensionContext) => {
    tasks = [];
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "task") continue;
      const d = msg.details as TaskDetails | undefined;
      if (d) {
        tasks = d.tasks;
        nextId = d.nextId;
      }
    }
    render(ctx);
  };

  let lastSessionId: string | undefined;

  pi.on("session_start", async (_e, ctx) => {
    lastSessionId = ctx.sessionManager.getSessionId();
    reconstruct(ctx);
  });

  // session_start does NOT fire on /resume — detect session-ID change on every turn
  pi.on("turn_start", async (_e, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid !== lastSessionId) {
      lastSessionId = sid;
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
    const incomplete = tasks.filter((t) => t.status !== "done");
    if (incomplete.length === 0 || nudgedThisCycle) return;
    nudgedThisCycle = true;
    const list = incomplete
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

  // Only a genuine human (interactive) prompt starts a new nudge cycle.
  // The nudge's own sendMessage({triggerTurn}) fires `input` with source="extension"
  // on pi 0.80.x — resetting here would defeat the guard and loop forever.
  // (Regression from 0.79.9, where `input` only fired for human prompts — LR-0009.)
  pi.on("input", async (event) => {
    if (event.source === "interactive") nudgedThisCycle = false;
    return { action: "continue" as const };
  });

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
          // Single-inprogress enforcement: demote any other inprogress task
          if (t.status === "inprogress")
            for (const x of tasks)
              if (x.id !== t.id && x.status === "inprogress") x.status = "idle";
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
}
