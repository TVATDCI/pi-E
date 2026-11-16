// extensions/tests/session-notes.test.ts — behavior tests for the
// session-notes-ui-refactor (bounded preview + /notes viewer + hide/show).
// Run:
//   node --experimental-strip-types extensions/tests/session-notes.test.ts
// (from anywhere; imports resolve via the agent-home node_modules upward).
//
// Model-free: drives the extension through its public registration seams with
// typed stubs (no `as any`), mirroring the mini-task-tracker.test.ts driver.
// Pins the approved acceptance matrix:
//   - preview is bounded: heading + latest three notes = 4 content rows max,
//     at 0/1/3/4/58/1000 notes, any width; no empty panel
//   - latest-three ordering + hidden count; multiline/Unicode safe; stored
//     note text never rewritten (flatten/truncate are display-only)
//   - /notes viewer: all notes reachable, wrapped, opens near newest,
//     Up/Down/PgUp/PgDn/Home/End browse, Escape closes; editor text untouched
//   - /notes hide|show: preview visibility only; capture continues while
//     hidden; no auto-reopen; show restores current count + latest three
//   - 200/201-char tool gate and manual /note behavior unchanged
//   - SESSION_NOTES_TEXT and add_note schema/result unchanged
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

import sessionNotes, { SESSION_NOTES_TEXT } from "../session-notes.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

// Real terminal escape sequences (xterm): matchesKey parses these.
const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  escape: "\x1b",
};

interface CapturedWidget {
  key: string;
  factory: (tui: unknown, theme: unknown) => {
    render: (width: number) => string[];
    invalidate: () => void;
  };
  options: { placement?: string } | undefined;
}

interface ViewerHandle {
  component: {
    render: (width: number) => string[];
    handleInput: (data: string) => void;
    invalidate: () => void;
  };
  closed: Promise<unknown>;
  closedValue: unknown;
}

const themeStub = { fg: (_t: string, s: string) => s, bold: (s: string) => s };

interface Driver {
  widgets: CapturedWidget[];
  handlers: Map<string, (event: unknown, ctx: ExtensionContext) => Promise<unknown>>;
  noteCommand: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  notesCommand: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  addNote: ((params: { text: string }, ctx: ExtensionContext) => Promise<ToolResult>) | undefined;
  notifications: Array<{ msg: string; kind: string }>;
  viewer: ViewerHandle | undefined;
  toolDef: { name: string; parameters: Record<string, unknown> } | undefined;
  ctx: ExtensionContext;
  lastWidget: CapturedWidget | undefined;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, never>;
}

function makeDriver(opts?: { hasUI?: boolean; mode?: string }): Driver {
  const state: {
    widgets: CapturedWidget[];
    handlers: Driver["handlers"];
    noteCommand?: Driver["noteCommand"];
    notesCommand?: Driver["notesCommand"];
    addNote?: Driver["addNote"];
    notifications: Array<{ msg: string; kind: string }>;
    viewer?: ViewerHandle;
    toolDef?: Driver["toolDef"];
    blockedReason?: string;
  } = { widgets: [], handlers: new Map(), notifications: [] };

  const hasUI = opts?.hasUI ?? true;
  const mode = opts?.mode ?? "tui";
  const ctx: ExtensionContext = {
    hasUI,
    mode,
    cwd: "/tmp",
    ui: {
      setWidget: (key: string, factory: CapturedWidget["factory"], options?: { placement?: string }) => {
        state.widgets.push({ key, factory, options });
      },
      notify: (msg: string, kind?: string) => {
        state.notifications.push({ msg, kind: kind ?? "info" });
      },
      // ctx.ui.custom: invoke the factory immediately with stubs; the returned
      // promise resolves when the component calls done (Escape closes).
      custom: ((factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) => {
        let resolveClosed: (v: unknown) => void;
        let closedValue: unknown;
        const closed = new Promise<unknown>((resolve) => {
          resolveClosed = (v: unknown) => {
            closedValue = v;
            resolve(v);
          };
        });
        const component = factory(
          { requestRender: () => undefined },
          themeStub,
          { matches: () => false },
          resolveClosed!,
        ) as ViewerHandle["component"];
        state.viewer = { component, closed, get closedValue() { return closedValue; } };
        return closed;
      }) as never,
    },
  } as unknown as ExtensionContext;

  const api: ExtensionAPI = {
    on: ((name: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) => {
      state.handlers.set(name, fn);
      return undefined;
    }) as never,
    registerCommand: ((name: string, def: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
      if (name === "note") state.noteCommand = def.handler;
      if (name === "notes") state.notesCommand = def.handler;
      return undefined;
    }) as never,
    registerTool: ((def: {
      name: string;
      parameters: Record<string, unknown>;
      execute: (id: string, params: { text: string }, s: unknown, u: unknown, ctx: ExtensionContext) => Promise<ToolResult>;
    }) => {
      if (def.name === "add_note") {
        state.toolDef = { name: def.name, parameters: def.parameters };
        state.addNote = (params, ctx2) =>
          def.execute("tc1", params, undefined, undefined, ctx2);
      }
      return undefined;
    }) as never,
  } as unknown as ExtensionAPI;
  sessionNotes(api);

  return {
    widgets: state.widgets,
    handlers: state.handlers,
    get noteCommand() { return state.noteCommand; },
    get notesCommand() { return state.notesCommand; },
    get addNote() { return state.addNote; },
    get toolDef() { return state.toolDef; },
    notifications: state.notifications,
    get viewer() { return state.viewer; },
    ctx,
    get lastWidget(): CapturedWidget | undefined {
      return state.widgets[state.widgets.length - 1];
    },
  };
}

async function fireSessionStart(d: Driver): Promise<void> {
  await d.handlers.get("session_start")!(undefined, d.ctx);
}

function renderPreview(d: Driver, width: number): string[] {
  const w = d.lastWidget;
  if (!w) throw new Error("widget never registered");
  return w.factory(undefined, themeStub).render(width);
}

async function addNotesViaCommand(d: Driver, n: number, label = "filler"): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await d.noteCommand!(`${label}-${i}`, d.ctx);
  }
}

function openViewer(d: Driver): ViewerHandle {
  if (!d.viewer) throw new Error("viewer was never opened");
  return d.viewer;
}

const tests: Array<() => Promise<void>> = [];

// 1. Bounded preview across the count matrix.
tests.push(async () => {
  const d = makeDriver();
  await fireSessionStart(d);
  check("0 notes: no panel at all (zero rows)", renderPreview(d, 80).length === 0);
  await addNotesViaCommand(d, 1);
  check("1 note: exactly heading + 1 row (2 rows)", renderPreview(d, 80).length === 2);
  await d.noteCommand!("b-2", d.ctx);
  await d.noteCommand!("b-3", d.ctx);
  check("3 notes: exactly 4 rows", renderPreview(d, 80).length === 4);
  await d.noteCommand!("b-4", d.ctx);
  const four = renderPreview(d, 80);
  check("4 notes: still exactly 4 content rows", four.length === 4);
  check("4 notes: latest three shown in chronological order (b-2,b-3,b-4)",
    /b-2/.test(four[1]!) && /b-3/.test(four[2]!) && /b-4/.test(four[3]!));
  check("4 notes: hidden count says +1 earlier hidden", /\+1 earlier hidden/.test(four[0]!));
  await addNotesViaCommand(d, 54, "more");
  const f58 = renderPreview(d, 80);
  check("58 notes: still exactly 4 rows", f58.length === 4);
  check("58 notes: heading shows total 58", /session-notes \(58\)/.test(f58[0]!));
  check("58 notes: hidden count +55", /\+55 earlier hidden/.test(f58[0]!));
  check("58 notes: shows the latest three (more-52,53,54) in order",
    /more-52/.test(f58[1]!) && /more-53/.test(f58[2]!) && /more-54/.test(f58[3]!));
  check("58 notes: earlier notes not rendered as rows", !/more-1\b/.test(f58.join("\n")));
  for (let i = 1; i <= 942; i++) await d.noteCommand(`bulk-${i}`, d.ctx);
  const f1000 = renderPreview(d, 80);
  check("1000 notes: still exactly 4 rows (large-count regression)", f1000.length === 4);
  check("1000 notes: hidden count +997", /\+997 earlier hidden/.test(f1000[0]!));
  check("1000 notes: latest three are bulk-940,941,942 in order",
    /bulk-940/.test(f1000[1]!) && /bulk-941/.test(f1000[2]!) && /bulk-942/.test(f1000[3]!));
});

// 2. Width behavior: every row fits; heading degrades by dropping hint then hidden segment.
tests.push(async () => {
  const d = makeDriver();
  await fireSessionStart(d);
  await addNotesViaCommand(d, 58, "w");
  for (const width of [30, 80, 120]) {
    const lines = renderPreview(d, width);
    check(`width ${width}: rows rendered`, lines.length === 4);
    check(`width ${width}: every row fits within ${width} cells`,
      lines.every((l) => visibleWidth(l) <= width));
  }
  const w30 = renderPreview(d, 30).join("\n");
  check("width 30: total count still visible", /58/.test(w30));
  const w8 = renderPreview(d, 8);
  check("width 8: degenerate width still renders within bounds",
    w8.length === 4 && w8.every((l) => visibleWidth(l) <= 8));
});

// 3. Multiline + tab: preview flattens to one row; stored text untouched.
tests.push(async () => {
  const d = makeDriver();
  await fireSessionStart(d);
  const raw = "line one\nline two\twith tab";
  await d.noteCommand!(raw, d.ctx);
  const preview = renderPreview(d, 80);
  check("multiline note occupies exactly one preview row", preview.length === 2);
  check("preview flattens whitespace for display only", /line one line two with tab/.test(preview[1]!));
  const tool = await d.addNote!({ text: raw }, d.ctx);
  check("tool result returns the raw stored text unchanged",
    tool.content[0]?.text === `Added note: ${raw}`);
  const after = renderPreview(d, 80);
  check("preview after tool note still one row per note", after.length === 3);
});

// 4. Unicode / wide chars: cell-aware truncation keeps rows within width.
tests.push(async () => {
  const d = makeDriver();
  await fireSessionStart(d);
  await d.noteCommand!("中文的笔记内容很长很长很长很长很长很长很长很长", d.ctx);
  await d.noteCommand!("emoji 🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀", d.ctx);
  await d.noteCommand!("mixed 中文 + emoji 🚀 + ascii tail that keeps going and going", d.ctx);
  for (const width of [20, 40, 80]) {
    const lines = renderPreview(d, width);
    check(`unicode width ${width}: 4 rows, all fit`, lines.length === 4 && lines.every((l) => visibleWidth(l) <= width));
  }
});

// 5. Viewer: opens near newest, full navigation, Escape closes, notes preserved.
tests.push(async () => {
  const d = makeDriver();
  await fireSessionStart(d);
  await addNotesViaCommand(d, 57, "v");
  await d.noteCommand!("v-58 the newest note", d.ctx);
  const openP = d.notesCommand!("", d.ctx); // viewer stays open until Escape
  await new Promise<void>((resolve) => setImmediate(resolve)); // let the handler reach ctx.ui.custom
  const v = openViewer(d);
  let lines = v.component.render(80);
  check("viewer renders header + 12 content + status rows", lines.length === 14);
  check("viewer opens at the newest note (bottom of list)", /v-58 the newest note/.test(lines.join("\n")));
  check("viewer header shows total count 58", /session notes \(58\)/.test(lines[0]!));
  const beforeEnd = lines[13]!;
  v.component.handleInput(KEYS.up);
  lines = v.component.render(80);
  check("Up scrolls one line up from bottom", lines[13]! !== beforeEnd && !/v-58 the newest note/.test(lines.join("\n")));
  v.component.handleInput(KEYS.home);
  lines = v.component.render(80);
  check("Home reaches the first note", /v-1\b/.test(lines.join("\n")));
  check("Home status shows line 1", /\[1–/.test(lines[13]!));
  v.component.handleInput(KEYS.end);
  lines = v.component.render(80);
  check("End returns to the newest note", /v-58 the newest note/.test(lines.join("\n")));
  v.component.handleInput(KEYS.pageUp);
  lines = v.component.render(80);
  check("PageUp jumps a full viewport (12 lines)", /\[35–/.test(lines[13]!));
  v.component.handleInput(KEYS.pageDown);
  lines = v.component.render(80);
  check("PageDown returns to the bottom", /v-58 the newest note/.test(lines.join("\n")));
  v.component.handleInput(KEYS.escape);
  const closedValue = await v.closed;
  await openP;
  check("Escape closes the viewer", closedValue === undefined);
  // Notes survive the viewer round-trip unchanged.
  const tool = await d.addNote!({ text: "after-viewer" }, d.ctx);
  check("capture still works after closing the viewer",
    tool.content[0]?.text === "Added note: after-viewer");
  const preview = renderPreview(d, 80);
  check("preview shows the post-viewer note in the latest three", /after-viewer/.test(preview.join("\n")));
});

// 6. Viewer wraps full text: content truncated in the preview is reachable in full.
tests.push(async () => {
  const d = makeDriver();
  await fireSessionStart(d);
  const longNote =
    "This note is deliberately long so the preview truncates it: alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
  await d.noteCommand!(longNote, d.ctx);
  const preview = renderPreview(d, 60);
  check("preview truncates the long note to one row", preview.length === 2);
  check("preview row does not contain the tail", !/tango/.test(preview[1]!));
  const openP6 = d.notesCommand!("", d.ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const v = openViewer(d);
  const viewerText = v.component.render(60).join("\n");
  check("viewer contains the full long-note tail (sierra tango)", /sierra tango/.test(viewerText));
  // Concatenating the wrapped segments reconstructs the note (prefix cells skipped).
  const body = v.component.render(60).slice(1, 13);
  const recombined = body.map((l) => l.replace(/^\s*\d+· /, "").replace(/^ {6}/, "")).join(" ");
  check("wrapped segments reconstruct the stored text", recombined.startsWith("This note is deliberately long"));
  v.component.handleInput(KEYS.escape);
  await v.closed;
  await openP6;
});

// 7. /notes hide | show: preview visibility only; capture continues; no auto-reopen.
tests.push(async () => {
  const d = makeDriver();
  await fireSessionStart(d);
  await addNotesViaCommand(d, 5, "h");
  await d.notesCommand!("hide", d.ctx);
  check("hide removes the preview (zero rows)", renderPreview(d, 80).length === 0);
  await d.noteCommand!("h-6 added while hidden", d.ctx);
  check("note captured while hidden (no crash)", d.notifications.some((n) => /h-6 added while hidden/.test(n.msg)));
  check("hidden preview does not auto-reopen on add", renderPreview(d, 80).length === 0);
  const hiddenViewerOpen = d.viewer;
  check("hide/show never open the viewer", hiddenViewerOpen === undefined);
  await d.notesCommand!("show", d.ctx);
  const shown = renderPreview(d, 80);
  check("show restores the bounded preview", shown.length === 4);
  check("restored preview shows the current count 6", /session-notes \(6\)/.test(shown[0]!));
  check("restored preview shows the latest three incl. the hidden-period note",
    /h-4/.test(shown[1]!) && /h-5/.test(shown[2]!) && /h-6 added while hidden/.test(shown[3]!));
  // Unknown /notes argument is a usage hint, not a viewer open and not a toggle.
  await d.notesCommand!("banana", d.ctx);
  check("unknown /notes arg gets a usage warning",
    d.notifications[d.notifications.length - 1]?.kind === "warning");
  check("unknown /notes arg does not open the viewer", d.viewer === undefined);
});

// 8. Tool gate boundary and manual-command asymmetry (unchanged behavior).
tests.push(async () => {
  const d = makeDriver();
  await fireSessionStart(d);
  const hook = d.handlers.get("tool_call")!;
  const exactly200 = "x".repeat(200);
  const over201 = "x".repeat(201);
  const okTool = await d.addNote!({ text: exactly200 }, d.ctx);
  check("200-char tool note passes", okTool.content[0]?.text === `Added note: ${exactly200}`);
  const blocked = await hook({ toolName: "add_note", input: { text: over201 } }, d.ctx) as
    { block?: boolean; reason?: string } | undefined;
  check("201-char tool call is blocked by the hook", blocked?.block === true && /200 char max/.test(blocked?.reason ?? ""));
  const passthrough = await hook({ toolName: "bash", input: { command: "ls" } }, d.ctx) as undefined;
  check("non-add_note tool calls are untouched", passthrough === undefined);
  const longManual = "y".repeat(201);
  await d.noteCommand!(longManual, d.ctx);
  check("manual /note has no length limit (unchanged asymmetry)",
    d.notifications.some((n) => n.msg === `Noted: ${longManual}`));
  await d.noteCommand!("   ", d.ctx);
  check("blank /note still gets the usage hint", d.notifications.some((n) => n.msg === "Usage: /note <text>"));
  check("blank /note stores nothing (still just the 2 earlier notes)",
    renderPreview(d, 80).length === 3);
});

// 9. Exported prompt text and tool schema are unchanged.
tests.push(async () => {
  check("SESSION_NOTES_TEXT identical", SESSION_NOTES_TEXT ===
    "## Session notes\n" +
    "You have an `add_note` tool and the user has `/note`. Use `add_note` to record decisions, TODOs, or context worth keeping visible this session.");
  const d = makeDriver();
  await fireSessionStart(d);
  const def = d.toolDef!;
  check("tool name still add_note", def.name === "add_note");
  const params = def.parameters as {
    type: string;
    properties: { text: { type: string; description: string } };
    required: string[];
    additionalProperties?: boolean;
  };
  check("schema is object with a string text param",
    params.type === "object" && params.properties?.text?.type === "string");
  check("text is required, no extra properties",
    Array.isArray(params.required) && params.required.includes("text") &&
    params.required.length === 1 && Object.keys(params.properties).length === 1);
  check("widget placement belowEditor unchanged", d.lastWidget?.options?.placement === "belowEditor");
  check("widget key unchanged", d.lastWidget?.key === "session-notes");
});

// 10. Viewer guards: empty session and non-tui mode never open a viewer.
tests.push(async () => {
  const d0 = makeDriver();
  await fireSessionStart(d0);
  await d0.notesCommand!("", d0.ctx);
  check("/notes with zero notes: info toast, no viewer",
    d0.viewer === undefined && d0.notifications.some((n) => /No session notes yet/.test(n.msg)));
  const dr = makeDriver({ mode: "rpc" });
  await fireSessionStart(dr);
  await dr.noteCommand!("rpc-mode note", dr.ctx);
  await dr.notesCommand!("", dr.ctx);
  check("/notes in non-tui mode: warning, no viewer",
    dr.viewer === undefined && dr.notifications.some((n) => /requires interactive mode/.test(n.msg) && n.kind === "warning"));
});

// 11. Headless capture: no UI, no widget registration, both entry paths still store notes.
tests.push(async () => {
  const d = makeDriver({ hasUI: false });
  await fireSessionStart(d);
  check("headless: no widget registered", d.widgets.length === 0);
  await d.noteCommand!("headless-command", d.ctx);
  const tool = await d.addNote!({ text: "headless-tool" }, d.ctx);
  check("headless: /note still notifies", d.notifications.some((n) => /headless-command/.test(n.msg)));
  check("headless: add_note still returns its result", tool.content[0]?.text === "Added note: headless-tool");
  await d.notesCommand!("hide", d.ctx);
  await d.notesCommand!("show", d.ctx);
  check("headless: hide/show are safe no-ops", d.viewer === undefined);
});

(async () => {
  for (const t of tests) await t();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
