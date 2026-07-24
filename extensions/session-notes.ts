// Lesson 0002 build-along: session-notes — all 5 primitives in one file.
// API verified against Pi extensions.md; patterns from theme-cycler.ts +
// the extensions.md quick-start. Import locked per LR-0001.

// Step 0 — The skeleton
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  const notes: string[] = [];
  //   What this is: the factory shell. Pi calls your default-exported function with pi (the ExtensionAPI — your handle to register everything). The notes array is the extension's in-memory state — it lives for the session, shared across all primitives. This closure-over-shared-state is how extensions coordinate: the command writes to notes, the tool writes to notes, the widget reads from notes.

  // Step 1: COMMAND — user types /note <text></text>
  // --- WIDGET HELPER (used by command + tool) ---
  function renderWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget(
      "session-notes",
      (_tui, theme) => ({
        invalidate() {},
        render(width: number): string[] {
          if (notes.length === 0) {
            return [
              truncateToWidth(
                theme.fg(
                  "muted",
                  "📓 session-notes: empty — /note <text> or the add_note tool",
                ),
                width,
              ),
            ];
          }
          return [
            truncateToWidth(
              theme.fg("accent", `📓 session-notes (${notes.length})`),
              width,
            ),
            ...notes.map((n) =>
              truncateToWidth(theme.fg("dim", `  • ${n}`), width),
            ),
          ];
        },
      }),
      { placement: "belowEditor" },
    );
  }

  //   What this is: a helper that (re)renders the widget. setWidget takes a key, a factory (not a string — it's called every render cycle), and a placement. The factory returns { invalidate, render } — same shape as setFooter from Lesson 0001. render(width) returns an array of strings, one per TUI line. theme.fg("accent", text) applies theme colors.

  //   Why a factory and not a string: the widget re-renders on every UI tick. If it were a static string, it couldn't react to notes changing. The factory closure captures notes by reference and reads it fresh each render.
  // Why this comes first: both the command (Step 2) and the tool (Step 3) call renderWidget(ctx) after mutating notes. Defining it once avoids duplication.

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

  //   What this is: the user types /note ship the Pi port. Pi parses the slash command, calls your handler with args (everything after /note ) and ctx (the ExtensionContext — UI handle, session, model, cwd). You push to notes, re-render the widget, and show a toast.
  // Key fact for the glossary gate: this is user-invoked. The LLM never sees it. tool_call hooks do NOT intercept it. That's the asymmetry you'll feel in Exercise 3.

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

  //   What this is: the LLM decides to call add_note. Pi sends the tool definition (name + description + parameters schema) to the model; when the model calls it, Pi runs your execute.
  // Type.Object(...) is TypeBox — a JSON-Schema builder. Type.Object({ text: Type.String() }) compiles to {"type":"object","properties":{"text":{"type":"string"}}}. The description field feeds the LLM's tool-use decision. TypeBox is how tool parameters are typed in Pi — you'll see it in every tool you register.
  // Key fact: this is LLM-invoked and visible to tool_call hooks. That's why the hook in Step 4 can gate it — but can't gate the /note command from Step 2.

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

  //   What this is: every tool call fires this hook BEFORE execution. You get event.toolName and event.input (the parameters the LLM passed). Returning { block: true, reason } cancels the call and feeds the reason back to the LLM. Returning nothing (undefined) lets it through.
  // This is the port-critical primitive: Sisyphus's hard-coded gate plugin → tool_call hooks. Lesson 0003 deep-dives this. Notice the gate is per-tool — you check event.toolName === "add_note" before applying the length rule. A real gate (damage-control) checks event.toolName === "bash" and inspects event.input.command for destructive patterns.
  // The asymmetry you'll test: this hook fires for add_note (tool) but NOT for /note (command). Try a 201-char note both ways in Exercise 3 — the tool call is blocked, the command sails through.

  // Step 5 — Widget initialization (session_start)
  // 4. WIDGET — initialize on session start
  pi.on("session_start", async (_event, ctx) => {
    renderWidget(ctx);
  });

  //   What this is: when Pi boots, session_start fires with a fresh ctx. You call renderWidget once to paint the empty-state ("📓 session-notes: empty — ..."). Without this, the widget wouldn't appear until the first note is added.

  // Step 6 — Prompt augmentation (before_agent_start)
  // 5. PROMPT AUGMENTATION — tell the LLM the tool exists, every turn
  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n## Session notes\nYou have an `add_note` tool and the user has `/note`. Use `add_note` to record decisions, TODOs, or context worth keeping visible this session.",
    };
  });
}
// What this is: before EVERY agent turn, Pi fires before_agent_start with the current event.systemPrompt. You return a new systemPrompt — here, the original + a section telling the LLM the tool exists. This is per-turn mutation: you can change it every turn based on state, session phase, user intent.
// This is the other port-critical primitive: Sisyphus's large fixed system prompt → before_agent_start injection. Instead of a 10K-token monolith, you inject context dynamically, per-turn, only when relevant.
