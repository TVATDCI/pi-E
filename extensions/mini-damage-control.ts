// mini-damage-control — HARDENED (Decision 0002: fail-closed B + global fallback A + bootstrap D)
// Changes from Lesson 0003 original: null=deny-bash (not empty=allow-all); global+project merge; deny-additive.
// 0.80.3 re-verify fix (LR-0017 pending → verified): ctx.ui.confirm does NOT render during
// tool_call preflight on 0.80.3 (silent abort). Switched ASK branch to ctx.ui.select (matches
// canonical permission-gate.ts) + try/catch notify so failures surface instead of silently aborting.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { parse as yamlParse } from "yaml";
import { minimatch } from "minimatch";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

interface Rule {
  pattern: string;
  reason: string;
  ask?: boolean;
}
interface Rules {
  bashToolPatterns: Rule[];
  zeroAccessPaths: string[];
  readOnlyPaths: string[];
}

const GLOBAL_RULES_PATH = join(
  os.homedir(),
  ".pi",
  "agent",
  "mini-dc-rules.yaml",
);

function loadRulesLayer(filepath: string): Rules | null {
  if (!existsSync(filepath)) return null;
  try {
    const raw = yamlParse(
      readFileSync(filepath, "utf8"),
    ) as Partial<Rules> | null;
    if (!raw) return null;
    return {
      bashToolPatterns: raw.bashToolPatterns ?? [],
      zeroAccessPaths: raw.zeroAccessPaths ?? [],
      readOnlyPaths: raw.readOnlyPaths ?? [],
    };
  } catch {
    return null; // parse error → treat as absent (fail-closed for that layer)
  }
}

function mergeRules(global: Rules | null, project: Rules | null): Rules | null {
  if (!global && !project) return null; // neither found → fail-closed
  const g = global ?? { bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [] };
  const p = project ?? { bashToolPatterns: [], zeroAccessPaths: [], readOnlyPaths: [] };
  // Deny-additive: concatenate. Project can ADD deny rules but cannot REMOVE global ones.
  // Project can downgrade block→ask via ask:true on a matching pattern, but cannot allow a global deny.
  return {
    bashToolPatterns: [...g.bashToolPatterns, ...p.bashToolPatterns],
    zeroAccessPaths: [...g.zeroAccessPaths, ...p.zeroAccessPaths],
    readOnlyPaths: [...g.readOnlyPaths, ...p.readOnlyPaths],
  };
}

// ── Glob matcher for path rules (zeroAccess, readOnly, noDelete) ────────────
// Uses minimatch (verified available in the Pi extension runtime). Supports
// * / ? / ** / ~ expansion, with dotfiles enabled so .env/.ssh match.
function expandTilde(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(os.homedir(), path.slice(1));
  }
  return path;
}

function pathMatchesGlob(path: string, pattern: string): boolean {
  const expandedPattern = expandTilde(pattern);
  return minimatch(path, expandedPattern, { dot: true });
}

// ── SafetyConfirmDialog (Path B, 2026-07-10) ─────────────────────────────────
// Loud, theme-independent overlay confirm. The built-in ctx.ui.select inherits the active
// theme's border/accent (teal/blue on encom) and blended into the background — operators
// missed it. This HARD-CODES ANSI red so it pops on ANY theme. Safe default = "No, block";
// timeout / Esc / Ctrl-C → block; only an explicit "Yes" (↓ + Enter, or `y`) → proceed.
//
// Lifecycle: ctx.ui.custom(factory,{overlay}) — factory returns this; calling done(result)
// resolves the await AND dismisses the overlay. Countdown via setInterval + tui.requestRender();
// dispose() (framework calls on close) clears the timer. finish() is idempotent.
const DIALOG_ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  black: "\x1b[30m",
  barBg: "\x1b[47m",
} as const;

interface SafetyConfirmOpts {
  violation: string;
  timeoutMs: number;
  tui: TUI;
  onResult: (result: string | undefined) => void;
}

class SafetyConfirmDialog implements Component {
  private readonly violation: string;
  private readonly tui: TUI;
  private readonly onResult: (result: string | undefined) => void;
  private readonly options = ["🛑  No, block", "🟢  Yes, proceed"];
  private selected = 0; // 0 = No (safe default); 1 = Yes
  private remainingSec: number;
  private finished = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SafetyConfirmOpts) {
    this.violation = opts.violation;
    this.tui = opts.tui;
    this.onResult = opts.onResult;
    this.remainingSec = Math.max(1, Math.round(opts.timeoutMs / 1000));
    this.timer = setInterval(() => {
      this.remainingSec -= 1;
      this.tui.requestRender();
      if (this.remainingSec <= 0) this.finish(undefined); // timeout → block
    }, 1000);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
      this.selected = 0; // No
      this.tui.requestRender();
    } else if (
      matchesKey(data, Key.down) ||
      matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab)
    ) {
      this.selected = 1; // Yes
      this.tui.requestRender();
    } else if (matchesKey(data, Key.enter)) {
      this.finish(this.selected === 1 ? "proceed" : undefined);
    } else if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.finish(undefined);
    } else if (data === "y" || data === "Y") {
      this.finish("proceed");
    } else if (data === "n" || data === "N") {
      this.finish(undefined);
    }
  }

  render(width: number): string[] {
    const w = Math.max(44, width);
    const A = DIALOG_ANSI;
    // fit(): never exceed width (truncate), then pad to full width so bg bars span the row.
    const fit = (s: string): string => {
      const t = truncateToWidth(s, w);
      return t + " ".repeat(Math.max(0, w - visibleWidth(t)));
    };
    const lines: string[] = [];

    // Title bar — solid white bg, black bold text (red 🛡️ pops on white).
    lines.push(
      fit(
        `${A.barBg}${A.black}${A.bold} 🛡️  SAFETY CONFIRM   ⏱ auto-block ${this.remainingSec}s`,
      ),
    );
    lines.push(fit(""));

    // Violation — word-wrapped, bold yellow.
    const inner = Math.max(20, w - 2);
    for (const ln of wrapTextWithAnsi(
      `${A.bold}${A.yellow}${this.violation}${A.reset}`,
      inner,
    )) {
      lines.push(fit(` ${ln}`));
    }
    lines.push(fit(""));

    // Options — selected row is a solid white bar (red 🛑 / green 🟢 pop); emojis align at col 3.
    for (let i = 0; i < this.options.length; i++) {
      const isSel = i === this.selected;
      const body = isSel ? ` ❯ ${this.options[i]}` : `   ${this.options[i]}`;
      lines.push(fit(isSel ? `${A.barBg}${A.black}${A.bold}${body}` : `${A.dim}${body}`));
    }
    lines.push(fit(""));

    // Hint line.
    lines.push(
      fit(`${A.dim} ↑/↓ move · Enter confirm · y = proceed · n / Esc = block`),
    );

    return lines;
  }

  invalidate(): void {
    /* render is pure — nothing cached */
  }

  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private finish(result: string | undefined): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    this.onResult(result);
  }
}

export default function (pi: ExtensionAPI) {
  // Part B: null = unloaded = DENY BASH BY DEFAULT (fail-closed)
  let rules: Rules | null = null;
  let rulesSource: "none" | "global" | "project" | "merged" = "none";
  let mode: "abort" | "continue" = "abort";

  pi.on("session_start", async (_event, ctx) => {
    // Part A: load global floor + project override, merge deny-additive
    const globalRules = loadRulesLayer(GLOBAL_RULES_PATH);
    const projectPath = join(ctx.cwd, ".pi", "mini-dc-rules.yaml");
    const projectRules = loadRulesLayer(projectPath);

    rules = mergeRules(globalRules, projectRules);

    if (!rules) {
      rulesSource = "none";
    } else if (globalRules && projectRules) {
      rulesSource = "merged";
    } else if (globalRules) {
      rulesSource = "global";
    } else {
      rulesSource = "project";
    }

    const count = rules
      ? rules.bashToolPatterns.length +
        rules.zeroAccessPaths.length +
        rules.readOnlyPaths.length
      : 0;
    if (rules) {
      ctx.ui.notify(`🛡️ mini-dc: ${count} rules (${rulesSource})`, "info");
    } else {
      ctx.ui.notify(
        `🛡️ mini-dc: NO RULES LOADED — bash will be DENIED. Add ~/.pi/agent/mini-dc-rules.yaml (global) or .pi/mini-dc-rules.yaml (project).`,
        "warning",
      );
    }
    const statusText = rules
      ? `🛡️ mini-dc: ${count} rules (${rulesSource}, ${mode})`
      : `🛡️ mini-dc: DENY-BASH (no rules, ${mode})`;
    ctx.ui.setStatus("mini-dc", statusText);
  });

  pi.registerCommand("dc-mode", {
    description: "Toggle mini-dc mode: /dc-mode abort|continue",
    handler: async (args, ctx) => {
      const m = args.trim();
      if (m === "abort" || m === "continue") {
        mode = m;
        const count = rules
          ? rules.bashToolPatterns.length +
            rules.zeroAccessPaths.length +
            rules.readOnlyPaths.length
          : 0;
        ctx.ui.setStatus(
          "mini-dc",
          `🛡️ mini-dc: ${rules ? `${count} rules` : "DENY-BASH"} (${mode})`,
        );
        ctx.ui.notify(`mode → ${mode}`, "info");
      } else {
        ctx.ui.notify("Usage: /dc-mode abort|continue", "warning");
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    // Part B: FAIL-CLOSED — if rules are null (unloaded), DENY bash; allow read/write/edit (non-destructive)
    if (isToolCallEventType("bash", event) && rules === null) {
      const reason =
        `🛑 BLOCKED by mini-dc: no rules loaded (no global ~/.pi/agent/mini-dc-rules.yaml, ` +
        `no project .pi/mini-dc-rules.yaml). bash is DENIED until rules are configured. ` +
        `Add a rules file or run with --no-extensions to bypass.`;
      pi.appendEntry("mini-dc-log", {
        tool: event.toolName,
        input: event.input,
        rule: "fail-closed (no rules)",
        mode,
      });
      ctx.ui.notify("🛑 mini-dc: bash DENIED — no rules loaded", "error");
      if (mode === "abort") ctx.abort();
      return { block: true, reason };
    }

    let violation: string | null = null;
    let ask = false;
    const r = rules!; // safe — bash is blocked above if null; read/write/edit with null rules → no patterns → allow

    // Tier 1: zero-access paths on read/write/edit (blocks read AND write)
    if (
      isToolCallEventType("read", event) ||
      isToolCallEventType("write", event) ||
      isToolCallEventType("edit", event)
    ) {
      for (const zap of r.zeroAccessPaths) {
        if (pathMatchesGlob(event.input.path, zap)) {
          violation = `zero-access path: ${zap}`;
          break;
        }
      }
    }

    // Tier 1b: read-only paths on write/edit only (reads allowed; edits/writes blocked)
    if (
      !violation &&
      (isToolCallEventType("write", event) ||
        isToolCallEventType("edit", event))
    ) {
      for (const rop of r.readOnlyPaths) {
        if (pathMatchesGlob(event.input.path, rop)) {
          violation = `read-only path: ${rop}`;
          break;
        }
      }
    }

    // Tier 2: bash regex patterns
    if (!violation && isToolCallEventType("bash", event)) {
      for (const rule of r.bashToolPatterns) {
        if (new RegExp(rule.pattern).test(event.input.command)) {
          violation = rule.reason;
          ask = !!rule.ask;
          break;
        }
      }
    }

    if (!violation) return { block: false };

    if (ask) {
      // Custom overlay confirm (Path B, 2026-07-10): loud + theme-independent; safe default = No.
      // Replaces the built-in ctx.ui.select (which inherited encom's teal border and blended in).
      // Preflight render precedent: ctx.ui.* dialogs render during tool_call preflight (0.80.3-verified);
      // try/catch → block on any error (safe-fallback posture).
      try {
        const choice = await ctx.ui.custom<string | undefined>(
          (tui, _theme, _kb, done) =>
            new SafetyConfirmDialog({
              violation,
              timeoutMs: 60000,
              tui,
              onResult: done,
            }),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "60%",
              minWidth: 52,
              margin: 2,
            },
          },
        );
        if (choice === "proceed") return { block: false };
      } catch (e) {
        ctx.ui.notify(`🛡️ mini-dc dialog error: ${String(e)}`, "error");
      }
    }

    pi.appendEntry("mini-dc-log", {
      tool: event.toolName,
      input: event.input,
      rule: violation,
      mode,
    });

    const reason = `🛑 BLOCKED by mini-dc: ${violation}. DO NOT work around this — tell the user.`;
    if (mode === "abort") {
      ctx.abort();
      return { block: true, reason };
    }
    return { block: true, reason };
  });
}
