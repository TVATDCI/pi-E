// Lesson 0002 build-along: session-notes — all 5 primitives in one file.
// API verified against Pi extensions.md; patterns from theme-cycler.ts +
// the extensions.md quick-start. Import locked per LR-0001.
//
// session-notes-ui-refactor (2026-11-16): the widget no longer renders one row
// per note — a long notes list used to displace the editor entirely (58 notes
// = 59 widget rows). Preview is bounded (heading + latest 3 notes, 4 content
// rows max); /notes opens every held note in a read-only scrollable viewer;
// /notes hide|show toggles preview visibility only. Stored note text is never
// rewritten: flattening/truncation are display-only.

// Step 0 — The skeleton
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// Session-notes behavioral framing — consumed by prompt-coordinator.ts (sole before_agent_start
// registrant). Co-located here because the text is about the add_note tool this module owns.
export const SESSION_NOTES_TEXT =
  "## Session notes\n" +
  "You have an `add_note` tool and the user has `/note`. Use `add_note` to record decisions, TODOs, or context worth keeping visible this session.";

// Preview bound: heading + latest three notes, whatever the total. This is a
// widget-content bound, not a host-layout guarantee about surrounding gaps.
const PREVIEW_NOTE_ROWS = 3;
// Viewer viewport in content lines (plus its own header/status rows).
const VIEWER_CONTENT_ROWS = 12;
// Cells reserved for the note-index prefix inside the viewer.
const VIEWER_PREFIX_CELLS = 6;

export default function (pi: ExtensionAPI) {
  const notes: string[] = [];
  // Preview visibility is local to the running extension; note capture continues
  // while hidden and adding a note never reopens the preview.
  let previewHidden = false;

  // Display-only whitespace flattening: embedded newlines/tabs must not expand
  // the panel. Stored note text is untouched — this only shapes the preview row.
  function flattenForPreview(text: string): string {
    return text.replace(/\s+/g, " ").trim();
  }

  // --- WIDGET HELPER (used by command + tool) ---
  function renderWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      "session-notes",
      (_tui, theme) => ({
        invalidate() {},
        render(width: number): string[] {
          // No panel at all when there are zero notes or the preview is hidden;
          // /note and /notes stay fully available either way.
          if (notes.length === 0 || previewHidden) return [];

          const total = notes.length;
          // Latest three, chronological order (oldest of the three first).
          const shown = notes.slice(-PREVIEW_NOTE_ROWS);
          const hiddenCount = total - shown.length;

          // Heading: total count always; hidden count and the /notes hint as
          // width permits (drop the hint first, then the hidden segment).
          const base = theme.fg("accent", `⚓ session-notes (${total})`);
          const withHidden =
            hiddenCount > 0
              ? `${base} ${theme.fg("muted", `· +${hiddenCount} earlier hidden`)}`
              : base;
          const hint = theme.fg("dim", `· /notes opens all`);
          let heading = `${withHidden} ${hint}`;
          if (visibleWidth(heading) > width) heading = withHidden;
          if (visibleWidth(heading) > width) heading = base;

          const rows = shown.map((n) =>
            truncateToWidth(theme.fg("dim", `  • ${flattenForPreview(n)}`), width),
          );
          return [truncateToWidth(heading, width), ...rows];
        },
      }),
      { placement: "belowEditor" },
    );
  }

  //   What this is: a helper that (re)renders the widget. setWidget takes a key, a factory (not a string — it's called every render cycle), and a placement. The factory returns { invalidate, render } — same shape as setFooter from Lesson 0001. render(width) returns an array of strings, one per TUI line. theme.fg("accent", text) applies theme colors. The factory closure captures notes by reference and reads it fresh each render.

  // --- FULL READ-ONLY VIEWER (/notes) ---
  // Opens every held note, wrapped, in a scrollable read-only screen. Rendered
  // as an overlay: pi's fullscreen renderer consumes unmodified PageUp/PageDown
  // for its own viewport scrolling before focused editor-area components see
  // input (pi-tui tui-alt-screen.ts "intentionally shadow" comment, verified
  // live in a disposable pi session); only the overlay path defers those keys
  // to the component. The overlay never replaces the editor, so editor input
  // is preserved verbatim while browsing and focus returns on close.
  function openViewer(ctx: ExtensionContext): Promise<void> {
    return ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        // Start pinned to the newest notes: the first render clamps this to the
        // bottom of the wrapped list (End behaves identically).
        let offset = Number.MAX_SAFE_INTEGER;
        let builtWidth = -1;
        let wrapped: string[] = [];

        function rebuild(width: number) {
          builtWidth = width;
          wrapped = [];
          const inner = Math.max(1, width - VIEWER_PREFIX_CELLS);
          notes.forEach((note, i) => {
            const segments = wrapTextWithAnsi(note, inner);
            segments.forEach((seg, j) => {
              const prefix =
                j === 0
                  ? theme.fg("accent", `${String(i + 1).padStart(3, " ")}· `)
                  : " ".repeat(VIEWER_PREFIX_CELLS);
              wrapped.push(`${prefix}${seg}`);
            });
          });
        }

        function maxOffset(): number {
          return Math.max(0, wrapped.length - VIEWER_CONTENT_ROWS);
        }

        return {
          render(width: number): string[] {
            if (width !== builtWidth) rebuild(width);
            offset = Math.min(Math.max(0, offset), maxOffset());
            const header = truncateToWidth(
              `${theme.fg("accent", `⚓ session notes (${notes.length})`)} ${theme.fg("dim", "· ↑↓ line · PgUp/PgDn page · Home/End ends · Esc close")}`,
              width,
            );
            const slice = wrapped.slice(offset, offset + VIEWER_CONTENT_ROWS);
            const body = slice.map((line) => truncateToWidth(line, width));
            const status = truncateToWidth(
              theme.fg(
                "dim",
                wrapped.length > 0
                  ? `[${offset + 1}–${offset + slice.length} of ${wrapped.length} lines]`
                  : "[no notes]",
              ),
              width,
            );
            return [header, ...body, status];
          },
          handleInput(data: string): void {
            if (matchesKey(data, "escape")) {
              done(undefined);
              return;
            }
            if (matchesKey(data, "up")) offset -= 1;
            else if (matchesKey(data, "down")) offset += 1;
            else if (matchesKey(data, "pageUp")) offset -= VIEWER_CONTENT_ROWS;
            else if (matchesKey(data, "pageDown")) offset += VIEWER_CONTENT_ROWS;
            else if (matchesKey(data, "home")) offset = 0;
            else if (matchesKey(data, "end")) offset = Number.MAX_SAFE_INTEGER;
            else return;
            offset = Math.min(Math.max(0, offset), maxOffset());
            tui.requestRender();
          },
          invalidate() {
            builtWidth = -1; // rebuild (and re-clamp) on the next render
          },
        };
      },
      // Centered floating panel (same pattern as chain-clarify.ts); maxHeight
      // keeps it inside small terminals.
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "70%", minWidth: 40, maxHeight: "80%" },
      },
    );
  }

  // Step 2 — Command primitive (pi.registerCommand)
  // 1. COMMAND — user types /note <text>
  pi.registerCommand("note", {
    description: "Add a session note: /note <text>",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (!text) {
        ctx.ui.notify("Usage: /note <text>", "warning");
        return;
      }
      notes.push(text);
      renderWidget(ctx);
      ctx.ui.notify(`Noted: ${text}`, "info");
    },
  });

  //   Key fact for the glossary gate: /note is user-invoked. The LLM never sees it. tool_call hooks do NOT intercept it. The add_note tool (Step 3) is LLM-invoked and gated.

  // 1b. COMMAND — /notes: browse all notes read-only; /notes hide|show toggles
  // the bounded preview (visibility only — capture continues while hidden and
  // a hidden preview is never auto-reopened by new notes).
  pi.registerCommand("notes", {
    description: "Browse all session notes (read-only) · /notes hide|show toggles the preview",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "hide") {
        previewHidden = true;
        renderWidget(ctx);
        return;
      }
      if (arg === "show") {
        previewHidden = false;
        renderWidget(ctx);
        return;
      }
      if (arg) {
        ctx.ui.notify("Usage: /notes · /notes hide · /notes show", "warning");
        return;
      }
      if (notes.length === 0) {
        ctx.ui.notify("No session notes yet — /note <text> adds one", "info");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/notes viewer requires interactive mode", "warning");
        return;
      }
      await openViewer(ctx);
    },
  });

  // Step 3 — Tool primitive (pi.registerTool)
  // 2. TOOL — the LLM calls add_note
  pi.registerTool({
    name: "add_note",
    label: "Add note",
    description: "Record a session note visible in the widget.",
    parameters: Type.Object({
      text: Type.String({ description: "The note to record" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      notes.push(params.text);
      renderWidget(ctx);
      return {
        content: [{ type: "text", text: `Added note: ${params.text}` }],
        details: {},
      };
    },
  });

  //   Key fact: this is LLM-invoked and visible to tool_call hooks. That's why the hook in Step 4 can gate it — but can't gate the /note command from Step 2.

  // Step 4 — Hook primitive (pi.on("tool_call", ...))
  // 3. HOOK — gate the add_note tool call (inline gate; deep-dive in Lesson 0003)
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName === "add_note") {
      const text = (event.input as { text?: string }).text ?? "";
      if (text.length > 200) {
        return { block: true, reason: "Note too long (200 char max)." };
      }
    }
  });

  //   The gate is per-tool — you check event.toolName === "add_note" before applying the length rule. The asymmetry: this hook fires for add_note (tool) but NOT for /note (command). A 201-char note: the tool call is blocked, the command sails through.

  // Step 5 — Widget initialization (session_start)
  // 4. WIDGET — initialize on session start
  pi.on("session_start", async (_event, ctx) => {
    renderWidget(ctx);
  });

  //   Without this the widget wouldn't be registered until the first note is added. With zero notes the widget renders zero rows — no empty panel.

  // Step 6 — Prompt augmentation moved to prompt-coordinator.ts (sole before_agent_start
  // registrant). SESSION_NOTES_TEXT (module-level export above) is the pure string it emits.
}
