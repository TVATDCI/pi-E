// statusline-encom.ts — single-line, encom-themed statusline footer.
// REPLACES Pi's built-in footer via ctx.ui.setFooter (the canonical API).
//
// Render: <dir> <git> <ctx %> <tokens> <model · thinking> <tps> <cost> <HH:MM:SS>
//   Segments joined by a thin powerline separator (U+E0B1 with a Nerd Font, ›
//   otherwise); dir / branch / clock / model gain icons in Nerd-font mode.
// Example: "pi-agent › main *2 +1 ?3 › 16.0% › 160K › zai-coding-cn/glm-5.2 · high › 42.3 tps › $0.04 › 14:32:07"
//
// ── Canonical API (verified against Pi 0.80.3) ──────────────────────────────
//   ctx.ui.setFooter(factory)              — extensions.md:2303-2310
//     factory: (tui, theme, footerData) => Component & { dispose?() }
//                                            — types.d.ts:106-108
//   footerData.getGitBranch(): string | null — footer-data-provider.d.ts:26
//     (ReadonlyFooterDataProvider pick: footer-data-provider.d.ts:53)
//   ctx.getContextUsage(): ContextUsage | undefined — types.d.ts:236
//     ContextUsage = { tokens: number|null, contextWindow, percent: number|null }
//                                            — types.d.ts:192-198
//     NOTE: .percent is the USED percentage of the window (not remaining).
//   ctx.model: Model<any> | undefined       — types.d.ts:222
//     Model { provider, id, contextWindow } — pi-ai types.d.ts:567-589
//
// ── Lessons applied ─────────────────────────────────────────────────────────
//   • setFooter, NOT setWidget. setWidget renders an ADDITIONAL widget next to
//     the built-in footer (the footer-status.ts.disabled bug). setFooter
//     REPLACES the built-in footer entirely (extensions.md:2303-2304).
//   • Print-mode guard: `if (!c.hasUI) return` before setFooter/setInterval.
//     ctx.ui throws in print/RPC mode (LR-0017; rpc.md:1060).
//   • Model seed bug (footer #1): model_select fires only on CHANGE, so a fresh
//     session showed "—" until the user cycled models. Fix: read ctx.model LIVE
//     in render() — the accessor is always current, so no closure seed is needed
//     and no model_select handler is required.
//
// ── Theme ───────────────────────────────────────────────────────────────────
//   Option A (reuse): every segment token already exists in encom.json
//   (mdLink, mdHeading, accent, muted, borderMuted, success/warning/error).
//   No theme edits required.
//
// ── V2 (built 2026-07-07) ────────────────────────────────────────────────────
//   cost ($)  — sum of event.message.usage.cost.{input,output,cacheRead,cacheWrite}
//               across assistant message_end events (session-running total).
//   tps       — output tokens / generation time (first text_delta → message_end),
//               rolling avg over the last 5 assistant responses.
//   CPU/MEM%, PR# — deferred (low value / external deps); see statusline-pi if needed.
//
// ── V3 (built 2026-07-16) — powerline restyle (cherry-picked from pi-powerline-footer) ─
//   separators  thin powerline glyph (U+E0B1) between segments in Nerd-font mode;
//                a › chevron (U+203A) that renders in any font otherwise.
//   icons        folder (U+F115) / branch (U+F126) / clock (U+F017) / chip (U+EC19)
//                prefix their segments — Nerd-font mode only (no tofu in plain fonts).
//   detection    PI_ENCOM_NERD=1|0 forces a mode (POWERLINE_NERD_FONTS alias);
//                auto-detects Ghostty/wezterm/kitty/iTerm/Alacritty; tmux-safe.
//   live toggle  /encom-nerd on|off|auto — overrides env at runtime (no relaunch;
//                resets to auto on /reload). Plain terminals = chevrons + color.
//
// ── V4 (built 2026-07-16) — git dirty-state (cherry-picked from git-status.ts) ──
//   footerData exposes only the branch; we poll `git status --porcelain` async
//   (2s TTL, 400ms cap, fire-and-forget) and render *N unstaged (warning) ·
//   +N staged (success) · ?N untracked (muted) after the branch. Hidden when
//   clean; non-git dirs → cached zeros. Invalidated on branch switch.
//
// ── V5 (built 2026-07-16) — solid bg-block powerline (toggle: /encom-style) ───
//   An alternative LOOK (not replacing thin): each segment is a filled bg block
//   from the encom palette, joined by U+E0B0 arrows (fg=prev-bg trick) in Nerd
//   mode, or a default-bg gap otherwise. Raw 24-bit ANSI (theme.bg = only 6
//   tokens). Single palette fg per block. /encom-style solid|thin switches live;
//   default = thin. Isolated render path — the thin look is untouched.
//
// ── V6 (built 2026-07-16) — responsive 2-line overflow (solid mode) ──────────
//   When the terminal is too narrow for all blocks on one line, a greedy fitter
//   (fitLines) spills the overflow to a second footer line (max 2). Each line is
//   its own powerline strip (own closing arrow). Thin mode stays single-line —
//   its text truncation is already graceful (no mid-block cut).
//
// ── V7 (built 2026-07-16) — segment registry + unified render (Strategy C, Phase 1) ─
//   The 8 segments are now a SEGMENT REGISTRY (order = data, paving the way for
//   Phase 3 config/presets + Phase 3 customItems). Each segment is a pure
//   fn(SegmentCtx) → SegmentContent that emits BOTH the thin form (themed parts,
//   can be multi-color) and the solid form (plain block text + bg/fg) from ONE
//   data computation. This removes the V2–V6 duplication between the per-segment
//   renderX() helpers and buildSolidCells(), and makes segments independently
//   testable. Output is byte-identical to V6 in both styles.

// ── V8 (built 2026-07-16) — new segments (Strategy C, Phase 2) ──────────────
//   Added to the registry: session (short id), cache_read / cache_write
//   (accumulated prompt-cache TOKEN totals from top-level Usage.cacheRead /
//   cacheWrite — distinct from the usage.cost dollars the cost segment sums),
//   and time_spent (wall-clock since session start). Default layout gains
//   session + cache_read (high-signal, cheap); cache_write + time_spent are
//   registered for the Phase 3 `full` preset. subagents DEFERRED — pi exposes
//   no subagent count (the reference ships a no-op segment too). humanizeTokens
//   extracted so tokens / cache share one formatter.
//
// ── V9 (built 2026-07-16) — config + presets + customItems (Strategy C, Phase 3) ─
//   The footer is now user-configurable via the `encomStatusline` block in
//   ~/.pi/agent/settings.json (or $PI_CODING_AGENT_DIR), with a project override at
//   <cwd>/.pi/settings.json (merged, project wins). Supports: preset
//   (default|minimal|full), layout.left (segment-order override), disabledSegments,
//   and customItems (promote any extension's ctx.ui.setStatus(key) into a footer
//   segment — read via footerData.getExtensionStatuses()). Commands: /encom-preset,
//   /encom. Settings are read via node:fs (no ctx.settings accessor) and cached at
//   session start; /encom-preset persists to the global settings file.
//
// ── V10 (built 2026-07-16) — separator switch + streaming ticker (Phase 4) ────
//   /encom-sep <style> swaps the thin-path separator glyph (powerline-thin |
//   powerline | chevron | slash | pipe | dot | star | block | none | ascii), with a
//   Nerd-font form + a renders-anywhere plain form per style. Default
//   "powerline-thin" preserves V3–V9 exactly. The render ticker is now
//   streaming-aware: 1s idle, ~250ms while a response streams (agent_start→
//   agent_end) so context % / tokens move live. (Deferred: auto-compact indicator
//   — settingsManager isn't on the typed ctx + pi defaults to compaction-on, so the
//   marker is low-signal; render-scheduler/layout-cache — pi already coalesces.)

import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

type Theme = ExtensionContext["ui"]["theme"];

const CLOCK_INTERVAL_MS = 1000;

// ── V3: powerline visual layer (cherry-picked from pi-powerline-footer) ─────
// Nerd-font glyphs (powerline separators + icons) live in Unicode's Private
// Use Area, so they only render with a Nerd/Powerline-patched font. Detect one,
// or let the operator force a mode; otherwise fall back to glyphs that render in
// ANY monospace font so xterm-256color / tmux still looks intentional.
//
//   PI_ENCOM_NERD=1   force Nerd-font rendering (separators + icons)
//   PI_ENCOM_NERD=0   force plain rendering (chevrons, no icons)
//   unset             auto-detect (Ghostty/wezterm/kitty/iTerm/Alacritty)
function hasNerdFonts(): boolean {
  const env = process.env.PI_ENCOM_NERD ?? process.env.POWERLINE_NERD_FONTS;
  if (env === "1") return true;
  if (env === "0") return false;
  if (process.env.GHOSTTY_RESOURCES_DIR) return true; // survives into tmux
  const term = (process.env.TERM_PROGRAM || "").toLowerCase();
  return ["iterm", "wezterm", "kitty", "ghostty", "alacritty"].some((t) => term.includes(t));
}

// null = follow auto-detection; true/false = explicit override. The /encom-nerd
// command flips `nerdOverride` live so the operator can iterate without
// relaunching pi (env vars are only read at launch; this overrides at runtime).
let nerdOverride: boolean | null = null;
const nerdOn = (): boolean => nerdOverride ?? hasNerdFonts();

// Thin-path inter-segment separator, switchable via /encom-sep (Phase 4). The
// "nerd" form uses Private-Use-Area codepoints (Nerd Font only); the "plain" form
// renders in any monospace font. Default "powerline-thin" preserves V3–V9 exactly
// (U+E0B1 / ›). Only affects the thin path — solid bg-block mode uses arrows.
type SepStyle = "powerline-thin" | "powerline" | "chevron" | "slash" | "pipe" | "dot" | "star" | "block" | "none" | "ascii";
export const SEP_GLYPHS: Record<SepStyle, { nerd: string; plain: string }> = {
  "powerline-thin": { nerd: " \uE0B1 ", plain: " \u203A " }, // thin triangle / ›
  "powerline":      { nerd: " \uE0B0 ", plain: " ▶ " },      // solid triangle / play
  "chevron":        { nerd: " \u203A ", plain: " \u203A " }, // › (always)
  "slash":          { nerd: " / ", plain: " / " },
  "pipe":           { nerd: " | ", plain: " | " },
  "dot":            { nerd: " \u00B7 ", plain: " \u00B7 " }, // ·
  "star":           { nerd: " \u2726 ", plain: " * " },      // ✦ nerd, * plain
  "block":          { nerd: " \u2588 ", plain: " | " },      // █ nerd, | plain
  "none":           { nerd: " ", plain: " " },               // single space
  "ascii":          { nerd: " > ", plain: " > " },           // ascii-safe
};
let sepStyle: SepStyle = "powerline-thin";   // default preserves V3–V9 output
// Pure core of separator() — exported for testing (the stateful separator() below
// just binds it to the live sepStyle + nerd-font detection).
export const separatorFor = (style: SepStyle, nerd: boolean): string =>
  SEP_GLYPHS[style][nerd ? "nerd" : "plain"];
const separator = (): string => separatorFor(sepStyle, nerdOn());

// Segment icons (Nerd-font codepoints from pi-powerline-footer/icons.ts). Empty
// in plain mode → iconPrefixed() is a no-op, so no tofu in unpatched fonts.
type IconSet = { folder: string; branch: string; clock: string; model: string };
const iconSet = (): IconSet =>
  nerdOn()
    ? { folder: "\uF115", branch: "\uF126", clock: "\uF017", model: "\uEC19" }
    : { folder: "", branch: "", clock: "", model: "" };

// Prepend "<icon> " only when an icon is set; otherwise return text unchanged.
const iconPrefixed = (icon: string, text: string): string => (icon ? `${icon} ${text}` : text);

// ── V5: solid bg-block powerline style (toggle: /encom-style solid|thin) ─────
// theme.bg() only exposes 6 tokens — not enough for a colorful powerline — so we
// emit 24-bit bg/fg directly from the encom palette (raw ANSI, like the reference
// colors.ts). Each segment is a filled block; Nerd mode joins them with U+E0B0
// arrows using the fg=prev-bg trick; non-nerd joins with a default-bg gap.
// Default is "thin" (the V3 separator look); solid is opt-in and isolated.
let styleOverride: "solid" | "thin" | null = null;

const RESET = "\x1b[0m";
const ARROW = "\uE0B0";            // U+E0B0 right-pointing solid triangle (Nerd Font)
const TERM_BG = "#0E0C15";          // encom pageBg — closing arrow fades into the footer bg

const hexRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const ansiFg = (hex: string): string => { const [r, g, b] = hexRgb(hex); return `\x1b[38;2;${r};${g};${b}m`; };
const ansiBg = (hex: string): string => { const [r, g, b] = hexRgb(hex); return `\x1b[48;2;${r};${g};${b}m`; };

// Per-segment {bg, fg}: bg from encom accent hues, fg high-contrast on each bg.
const SOLID: Record<string, { bg: string; fg: string }> = {
  dir:     { bg: "#00B0FF", fg: "#0E0C15" }, // blue bg, near-black fg
  branch:  { bg: "#9acd32", fg: "#0E0C15" }, // teal/lime
  context: { bg: "#FFD000", fg: "#0E0C15" }, // yellow
  tokens:  { bg: "#1b1b2e", fg: "#BBBBBB" }, // surface bg, light fg
  model:   { bg: "#BC00CA", fg: "#FFFDE1" }, // purple bg, white fg
  tps:     { bg: "#1b1b2e", fg: "#BBBBBB" },
  cost:    { bg: "#1b1b2e", fg: "#BBBBBB" },
  clock:   { bg: "#0E0C15", fg: "#777777" }, // page bg, dim fg
};

// A solid powerline block: bg fill + fg + inner content (icons/text).
type SolidCell = { bg: string; fg: string; content: string };

// Greedy line-fit: pack items into up to `maxLines` lines of <= `width` cells,
// adding `gap` cells between items on the same line. An item wider than `width`
// still lands on its line (the caller truncates). Used for solid 2-line overflow.
export const fitLines = <T>(items: T[], widthOf: (t: T) => number, gap: number, width: number, maxLines = 2): T[][] => {
  const lines: T[][] = [];
  let current: T[] | null = null;
  let cur = 0;
  for (const item of items) {
    const w = widthOf(item);
    if (current === null) { current = [item]; cur = w; }
    else if (cur + gap + w <= width) { current.push(item); cur += gap + w; }
    else if (lines.length + 1 < maxLines) { lines.push(current); current = [item]; cur = w; }
    else { current.push(item); cur += gap + w; }
  }
  if (current !== null) lines.push(current);
  return lines;
};

// Render one powerline strip from cells: blocks joined by U+E0B0 arrows
// (fg=prev-bg trick), closed with an arrow fading into TERM_BG. Non-nerd =
// default-bg gap between blocks. Used once per output line (V6 wraps to 2).
const renderSolidLine = (cells: SolidCell[]): string => {
  const useArrow = nerdOn();
  let out = "";
  cells.forEach((s, i) => {
    const next = cells[i + 1];
    const isLast = next === undefined;
    // Fade-on-glass (V5.1): the trailing TERM_BG block (clock) renders as bare
    // text over the translucent terminal bg — no opaque fill — and the arrow
    // pointing into it floats without a bg, so the strip dissolves into glass.
    if (isLast && s.bg === TERM_BG) {
      out += RESET + " " + ansiFg(s.fg) + s.content + " ";
      return;
    }
    out += ansiBg(s.bg) + " " + ansiFg(s.fg) + s.content + " ";
    if (useArrow) {
      if (!next || next.bg === TERM_BG) {
        out += ansiFg(s.bg) + ARROW + RESET; // floating fade-on-glass
      } else {
        out += ansiFg(s.bg) + ansiBg(next.bg) + ARROW;
      }
    } else {
      out += RESET + " ";
    }
  });
  return out + RESET;
};

// pi thinking level (pi-ai types.d.ts:21-22) → encom theme token.
// encom.json ships one color per level (off→borderMuted … high→amber, xhigh→red, max→pink).
// max added 2026-09-03: z.ai glm-5.3 recommends reasoning_effort max for coding; pi accepts
// --thinking max. Without this entry max fell through to thinkingOff (near-invisible).
const THINKING_TOKEN: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

const fmtClock = (): string => {
  const t = new Date();
  return [t.getHours(), t.getMinutes(), t.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};

// Porcelain format: "XY path". X = index (staged), Y = worktree (unstaged),
// "??" = untracked. Counts each path once per category it matches. Module-scope
// + pure so Phase 5 tests can exercise it directly without the pi runtime.
export const parseGitPorcelain = (out: string): { staged: number; unstaged: number; untracked: number } => {
  let staged = 0, unstaged = 0, untracked = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const x = line[0], y = line[1];
    if (x === "?" && y === "?") { untracked++; continue; }
    if (x && x !== " " && x !== "?") staged++;
    if (y && y !== " ") unstaged++;
  }
  return { staged, unstaged, untracked };
};

// Humanize a token count: 0 → "0", 999 → "999", 1200 → "1K", 1_200_000 → "1.2M".
// Shared by the tokens / cache_read / cache_write segments (DRY).
export const humanizeTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n);

// Humanize a duration in ms: "3s", "12m 04s", "1h 05m".
export const humanizeDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${String(rem).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
};

// ── V7: segment registry ────────────────────────────────────────────────────
// A segment is a pure fn(SegmentCtx) → SegmentContent | null. It computes its
// data ONCE and emits BOTH render forms, so thin and solid never drift and the
// V2–V6 duplication (renderX vs buildSolidCells) is gone. Segment order is data
// (DEFAULT_LAYOUT) — Phase 3 will make it user-configurable (layout/presets).
type SegPart = { text: string; fg: ThemeColor };
type SegmentContent = {
  thinParts: SegPart[];   // thin path: each part themed via theme.fg, concatenated (supports multi-color)
  solidText: string;      // solid path: plain block content
  solidBg: string;        // solid block bg (raw hex)
  solidFg: string;        // solid block fg (raw hex)
};
type RuntimeStats = {
  sessionCost: number;
  tpsAvg: number | null;            // null = no samples → "-- tps"
  git: { staged: number; unstaged: number; untracked: number };
  thinkingLevel: string | undefined;
  cacheRead: number;                // accumulated cache-read tokens (V8)
  cacheWrite: number;               // accumulated cache-write tokens (V8)
  sessionStartMs: number;           // session timer anchor (V8)
};
type SegmentCtx = {
  ctx: ExtensionContext;
  footerData: { getGitBranch(): string | null };
  theme: Theme;
  icon: IconSet;
  rt: RuntimeStats;
};
type SegmentDef = { id: string; render: (s: SegmentCtx) => SegmentContent | null };

// Most segments are single-color text + a solid block. Helper keeps them terse
// and guarantees thin/solid share the same `text`.
const single = (text: string, fg: ThemeColor, solid: { bg: string; fg: string }): SegmentContent => ({
  thinParts: [{ text, fg }],
  solidText: text,
  solidBg: solid.bg,
  solidFg: solid.fg,
});

const dirSegment: SegmentDef = {
  id: "dir",
  render: (s) => single(
    iconPrefixed(s.icon.folder, path.basename(s.ctx.cwd) || s.ctx.cwd),
    "mdLink",
    SOLID.dir,
  ),
};

const gitSegment: SegmentDef = {
  id: "git",
  render: (s) => {
    const branchName = s.footerData.getGitBranch();
    const base = iconPrefixed(s.icon.branch, branchName ?? "no-git");
    const parts: SegPart[] = [{ text: base, fg: "mdHeading" }];
    let solidExtra = "";
    if (branchName) {
      const { staged, unstaged, untracked } = s.rt.git;
      const inds: { t: string; fg: ThemeColor }[] = [];
      if (unstaged > 0) inds.push({ t: `*${unstaged}`, fg: "warning" });
      if (staged > 0) inds.push({ t: `+${staged}`, fg: "success" });
      if (untracked > 0) inds.push({ t: `?${untracked}`, fg: "muted" });
      if (inds.length > 0) {
        // thin: branch, dim space, indicators joined by dim spaces (matches V6)
        parts.push({ text: " ", fg: "dim" });
        inds.forEach((i, idx) => {
          if (idx > 0) parts.push({ text: " ", fg: "dim" });
          parts.push({ text: i.t, fg: i.fg });
        });
        // solid: plain " *N +N ?N"
        solidExtra = " " + inds.map((i) => i.t).join(" ");
      }
    }
    return { thinParts: parts, solidText: base + solidExtra, solidBg: SOLID.branch.bg, solidFg: SOLID.branch.fg };
  },
};

const contextSegment: SegmentDef = {
  id: "context",
  render: (s) => {
    const pct = s.ctx.getContextUsage()?.percent;
    if (pct == null) return single("—", "muted", SOLID.context);
    const color: ThemeColor = pct >= 95 ? "error" : pct >= 85 ? "warning" : "success";
    return single(`${pct.toFixed(1)}%`, color, SOLID.context);
  },
};

const tokensSegment: SegmentDef = {
  id: "tokens",
  render: (s) => {
    const tokens = s.ctx.getContextUsage()?.tokens;
    if (tokens == null || tokens <= 0) return single("0", "dim", SOLID.tokens);
    return single(humanizeTokens(tokens), "muted", SOLID.tokens);
  },
};

const modelSegment: SegmentDef = {
  id: "model",
  render: (s) => {
    const m = s.ctx.model;
    // no-model: preserve the V6 quirk byte-for-byte (thin = no icon, solid = icon).
    if (!m) return {
      thinParts: [{ text: "no-model", fg: "accent" }],
      solidText: iconPrefixed(s.icon.model, "no-model"),
      solidBg: SOLID.model.bg, solidFg: SOLID.model.fg,
    };
    const id = m.id.replace(/^models\//, "");
    const base = iconPrefixed(s.icon.model, `${m.provider}/${id}`);
    const level = s.rt.thinkingLevel;
    if (!level) return single(base, "accent", SOLID.model);
    const token = THINKING_TOKEN[level] ?? "thinkingOff";
    return {
      thinParts: [
        { text: base, fg: "accent" },
        { text: " · ", fg: "dim" },
        { text: level, fg: token },
      ],
      solidText: `${base} · ${level}`,
      solidBg: SOLID.model.bg, solidFg: SOLID.model.fg,
    };
  },
};

const tpsSegment: SegmentDef = {
  id: "tps",
  render: (s) => {
    if (s.rt.tpsAvg == null) return single("-- tps", "dim", SOLID.tps);
    const color: ThemeColor = s.rt.tpsAvg >= 20 ? "success" : s.rt.tpsAvg >= 5 ? "accent" : "warning";
    return single(`${s.rt.tpsAvg.toFixed(1)} tps`, color, SOLID.tps);
  },
};

const costSegment: SegmentDef = {
  id: "cost",
  render: (s) => {
    const c = s.rt.sessionCost;
    if (c <= 0) return single("$0.00", "dim", SOLID.cost);
    const text = c < 0.01 ? c.toFixed(4) : c.toFixed(2);
    return single(`$${text}`, "muted", SOLID.cost);
  },
};

const clockSegment: SegmentDef = {
  id: "clock",
  render: (s) => single(iconPrefixed(s.icon.clock, fmtClock()), "muted", SOLID.clock),
};

// ── V8 new segments (Phase 2) ───────────────────────────────────────────────
// session: short session-id hash (first 7 chars) so you can tell sessions apart.
const sessionSegment: SegmentDef = {
  id: "session",
  render: (s) => {
    const id = s.ctx.sessionManager?.getSessionId();
    if (!id) return null;                    // hide until a session id is available
    return single(id.length > 7 ? id.slice(0, 7) : id, "dim", SOLID.tokens);
  },
};

// cache_read / cache_write: accumulated prompt-cache TOKEN totals this session.
// Top-level Usage.cacheRead/cacheWrite are TOKEN counts (distinct from usage.cost.*
// which are dollars). Hidden until the model actually reports cached tokens.
const cacheReadSegment: SegmentDef = {
  id: "cache_read",
  render: (s) => {
    const n = s.rt.cacheRead;
    if (n <= 0) return null;
    return single(`CR ${humanizeTokens(n)}`, "muted", SOLID.tokens);
  },
};
const cacheWriteSegment: SegmentDef = {
  id: "cache_write",
  render: (s) => {
    const n = s.rt.cacheWrite;
    if (n <= 0) return null;
    return single(`CW ${humanizeTokens(n)}`, "muted", SOLID.tokens);
  },
};

// time_spent: wall-clock elapsed since session start.
const timeSpentSegment: SegmentDef = {
  id: "time_spent",
  render: (s) => single(humanizeDuration(Date.now() - s.rt.sessionStartMs), "muted", SOLID.clock),
};

// ── V10: bridge staleness badge (operator-ruled reminder, 2026-08-14) ───────
// NO cron — the operator runs bridge/export-bd-global.sh by hand; this segment
// is the reminder. Mirrors bd-bridge.ts checkStale()'s db candidates + 60s grace:
//   hidden    export fresh (< 3d) and bd not newer — zero noise when healthy
//   amber     "⛓ 4d"  export older than 3 days
//   red       "⛓ stale!"  bd db mtime > export mtime + 60s (bd changed since export)
//   red       "⛓ no-export"  export file missing/unstatable
// Pure core (computeBridgeBadge) is unit-tested with synthetic mtimes; the
// wrapper stats real paths under a 2s TTL (footer renders every tick).
export type BridgeBadge = { text: string; fg: ThemeColor } | null;

export function computeBridgeBadge(
  exportMtime: number | null,
  dbMtime: number | null,
  now: number,
): BridgeBadge {
  if (exportMtime == null) return { text: "⛓ no-export", fg: "error" };
  if (dbMtime != null && dbMtime > exportMtime + 60_000) return { text: "⛓ stale!", fg: "error" };
  const ageDays = (now - exportMtime) / 86_400_000;
  if (ageDays >= 3) return { text: `⛓ ${Math.floor(ageDays)}d`, fg: "warning" };
  return null; // fresh → hidden
}

let bridgeCache: { at: number; badge: BridgeBadge } = { at: 0, badge: null };
const BRIDGE_TTL_MS = 2_000;

function bridgeBadge(): BridgeBadge {
  const now = Date.now();
  if (now - bridgeCache.at < BRIDGE_TTL_MS) return bridgeCache.badge;
  let badge: BridgeBadge;
  try {
    const home = os.homedir();
    const exportPath = path.join(home, ".pi", "agent", "bridge", "global-export.jsonl");
    badge = computeBridgeBadge(statSync(exportPath).mtimeMs, bridgeDbMtime(), now);
  } catch {
    badge = computeBridgeBadge(null, null, now);
  }
  bridgeCache = { at: now, badge };
  return badge;
}

// First existing bd db path's mtime (candidates mirror checkStale; null if none).
function bridgeDbMtime(): number | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Main-vault", ".beads", "embeddeddolt"),
    path.join(home, ".beads", "beads_global.db"),
    path.join(home, ".local", "share", "beads", "beads_global.db"),
  ];
  for (const p of candidates) {
    try { return statSync(p).mtimeMs; } catch { /* next candidate */ }
  }
  return null;
}

const bridgeSegment: SegmentDef = {
  id: "bridge",
  render: () => {
    const b = bridgeBadge();
    if (!b) return null; // fresh → hidden (byte-identical footer when healthy)
    return single(b.text, b.fg, SOLID.tokens);
  },
};

// Registry + default order. Phase 3 will let the operator override the order via
// the encomStatusline.layout / preset settings. Unknown ids are silently dropped.
const SEGMENT_REGISTRY: Record<string, SegmentDef> = {
  dir: dirSegment, git: gitSegment, context: contextSegment, tokens: tokensSegment,
  cache_read: cacheReadSegment, cache_write: cacheWriteSegment, bridge: bridgeSegment,
  model: modelSegment, tps: tpsSegment, cost: costSegment, time_spent: timeSpentSegment,
  session: sessionSegment, clock: clockSegment,
};

// ── V9: config + presets + customItems (Phase 3) ────────────────────────────
// A custom item promotes any extension's published status (ctx.ui.setStatus) into
// its own footer segment. color is a theme token in Phase 3 (hex is a future nicety).
type CustomItem = {
  id: string;                 // unique item id
  statusKey?: string;         // extension status key to read (defaults to id)
  prefix?: string;            // label shown before the value
  color?: ThemeColor;         // theme token for the thin path
  hideWhenMissing?: boolean;  // hide when no status published (default true)
};
type EncomConfig = {
  preset?: string;                  // "default" | "minimal" | "full"
  layout?: { left?: string[] };     // override segment order (single footer line)
  disabledSegments?: string[];      // hide built-in or "custom:<id>" segments
  customItems?: CustomItem[];
};

// Preset → ordered segment-id list. "default" mirrors the V8 layout, so an
// unconfigured footer is byte-identical to V8. "full" adds cache_write + time_spent.
export const PRESETS: Record<string, string[]> = {
  default: ["dir", "git", "bridge", "context", "tokens", "cache_read", "model", "tps", "cost", "session", "clock"],
  minimal: ["dir", "git", "context"],
  full: ["dir", "git", "bridge", "context", "tokens", "cache_read", "cache_write", "model", "tps", "cost", "time_spent", "session", "clock"],
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const agentSettingsPath = (): string => {
  const dir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(dir, "settings.json");
};
const projectSettingsPath = (cwd: string): string => path.join(cwd, ".pi", "settings.json");

const readSettingsFile = (p: string): Record<string, unknown> => {
  try {
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};  // malformed user file → defaults; never crash the UI on bad JSON
  }
};

export const mergeSettings = (base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = out[k];
    out[k] = isRecord(b) && isRecord(v) ? mergeSettings(b, v) : v;
  }
  return out;
};

// Read + merge global+project settings; return the encomStatusline block (or {}).
// Cast is safe-by-shape: segments null-guard bad values, so malformed user JSON
// degrades gracefully rather than crashing.
const readEncomConfig = (cwd: string): EncomConfig => {
  const merged = mergeSettings(readSettingsFile(agentSettingsPath()), readSettingsFile(projectSettingsPath(cwd)));
  const block = merged.encomStatusline;
  return isRecord(block) ? (block as EncomConfig) : {};
};

// Resolve the active segment-id list: preset (or layout.left override), then
// disabledSegments removed, then custom items appended as "custom:<id>".
export const resolveLayout = (cfg: EncomConfig): string[] => {
  const base = cfg.layout?.left ?? PRESETS[cfg.preset ?? "default"] ?? PRESETS.default;
  const disabled = new Set(cfg.disabledSegments ?? []);
  const ids = base.filter((id) => !disabled.has(id));
  for (const ci of cfg.customItems ?? []) {
    if (disabled.has(`custom:${ci.id}`)) continue;
    ids.push(`custom:${ci.id}`);
  }
  return ids;
};

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  let clockTick: ReturnType<typeof setInterval> | undefined;
  // Render trigger captured from the footer factory so the 1s clock tick can
  // force a redraw. Set when Pi first invokes the factory (may be lazy).
  let requestRender: (() => void) | undefined;

  // V10: streaming-aware ticker — 1s idle, ~250ms while a response streams, so
  // context % / tokens move live during generation instead of waiting for turn end.
  let isStreaming = false;
  const STATUS_RENDER_MS = 250;
  const tickMs = (): number => (isStreaming ? STATUS_RENDER_MS : CLOCK_INTERVAL_MS);
  const startTicker = (): void => {
    if (clockTick) clearInterval(clockTick);
    clockTick = setInterval(() => requestRender?.(), tickMs());
  };

  // ── V2/V8 runtime stats (cost + tps + cache tokens + session timer) ────────
  let sessionCost = 0;                     // running $ spend this session (since load)
  let firstTokenMs: number | undefined;    // first output token time (gen-speed timing)
  const tpsSamples: number[] = [];        // rolling window of recent response tps
  const TPS_WINDOW = 5;
  let cacheReadTokens = 0;                 // accumulated prompt-cache-read tokens (V8)
  let cacheWriteTokens = 0;                // accumulated prompt-cache-write tokens (V8)
  let sessionStartMs = 0;                  // session timer anchor (V8)

  // ── V9 config (cached at session start; refreshed by /encom-preset) ────────
  let encomConfig: EncomConfig = {};
  // Persist preset to the GLOBAL settings file via read-modify-write so other keys
  // (theme, defaultModel, …) are preserved. Project .pi/settings.json is read-only.
  const persistPreset = (preset: string, c: ExtensionContext): void => {
    try {
      const p = agentSettingsPath();
      const obj = readSettingsFile(p);
      obj.encomStatusline = { ...(isRecord(obj.encomStatusline) ? obj.encomStatusline : {}), preset };
      writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    } catch (e) {
      c.ui.notify(`encom: could not save preset (${e instanceof Error ? e.message : "write error"})`, "error");
    }
  };

  // ── V4 git dirty-state (cherry-picked from pi-powerline-footer/git-status.ts) ─
  // footerData exposes only the branch name; to show working-tree state we poll
  // `git status --porcelain` asynchronously. render() reads the last cached counts
  // and schedules a refresh (fire-and-forget); completion calls requestRender().
  // Non-git dirs / missing git → cached zeros (no error spam). 2s TTL, 400ms cap.
  let gitCache: { cwd: string; staged: number; unstaged: number; untracked: number; ts: number } | null = null;
  let gitPending = false;
  const GIT_TTL_MS = 2000;

  // Spawn `git <args>` in `cwd`, cap at 400ms, return stdout or null on any
  // failure (non-repo, missing git, timeout). Caller treats null as "no data".
  const runGit = (args: string[], cwd: string): Promise<string | null> =>
    new Promise((resolve) => {
      let stdout = "";
      let done = false;
      const finish = (r: string | null): void => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
      const proc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], cwd });
      const timer = setTimeout(() => { proc.kill(); finish(null); }, 400);
      proc.on("error", () => finish(null));
      proc.on("close", (code: number | null) => finish(code === 0 ? stdout : null));
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (d: string) => { stdout += d; });
    });

  // Refresh the cache async if stale; no-op while a fetch is in flight. Cached
  // per-cwd so cd-ing into another repo re-fetches instead of showing stale counts.
  const pollGitStatus = (cwd: string): void => {
    const now = Date.now();
    const stale = !gitCache || gitCache.cwd !== cwd || now - gitCache.ts > GIT_TTL_MS;
    if (!stale || gitPending) return;
    gitPending = true;
    runGit(["status", "--porcelain"], cwd).then((out) => {
      gitCache = out == null
        ? { cwd, staged: 0, unstaged: 0, untracked: 0, ts: Date.now() }
        : { cwd, ...parseGitPorcelain(out), ts: Date.now() };
      gitPending = false;
      requestRender?.();
    });
  };

  const gitDirty = (): { staged: number; unstaged: number; untracked: number } =>
    gitCache ?? { staged: 0, unstaged: 0, untracked: 0 };

  const mount = (c: ExtensionContext): void => {
    ctx = c;

    c.ui.setFooter((tui, theme, footerData) => {
      // Reactive git: re-render + drop cached dirty counts on checkout/branch switch.
      const unsubscribeBranch = footerData.onBranchChange(() => { gitCache = null; tui.requestRender(); });
      // Expose a render trigger to the outer clock interval.
      requestRender = () => tui.requestRender();

      // Resolve the active layout to SegmentContent[] (nulls dropped), computing
      // each segment's data ONCE. Both render forms (thin/solid) consume this.
      const buildContents = (): SegmentContent[] => {
        if (!ctx) return [];
        const rt: RuntimeStats = {
          sessionCost,
          tpsAvg: tpsSamples.length > 0 ? tpsSamples.reduce((a, b) => a + b, 0) / tpsSamples.length : null,
          git: gitDirty(),
          thinkingLevel: pi.getThinkingLevel?.(),
          cacheRead: cacheReadTokens,
          cacheWrite: cacheWriteTokens,
          sessionStartMs,
        };
        const sctx: SegmentCtx = { ctx, footerData, theme, icon: iconSet(), rt };
        // Layout = preset (or layout.left override) + custom items; disabled removed.
        const statuses = footerData.getExtensionStatuses();
        const out: SegmentContent[] = [];
        for (const id of resolveLayout(encomConfig)) {
          if (id.startsWith("custom:")) {
            const item = encomConfig.customItems?.find((it) => it.id === id.slice("custom:".length));
            if (!item) continue;
            const val = statuses.get(item.statusKey ?? item.id);
            if ((val == null || val === "") && (item.hideWhenMissing ?? true)) continue;
            const text = `${item.prefix ? item.prefix + " " : ""}${val ?? ""}`.trim();
            if (text) out.push(single(text, item.color ?? "muted", SOLID.tokens));
          } else {
            const content = SEGMENT_REGISTRY[id]?.render(sctx) ?? null;
            if (content) out.push(content);
          }
        }
        return out;
      };

      return {
        dispose: unsubscribeBranch,
        invalidate() {
          tui.requestRender();
        },
        render(width: number): string[] {
          if (!ctx) return [];
          pollGitStatus(ctx.cwd); // async refresh of dirty counts (fire-and-forget)

          // solid → 2-line overflow: fit blocks (content + 2 padding) with 1-cell
          // arrows between, reserving 1 cell for each line's closing arrow.
          if (styleOverride === "solid") {
            const cells: SolidCell[] = buildContents().map((cc) => ({ bg: cc.solidBg, fg: cc.solidFg, content: cc.solidText }));
            const lines = fitLines(cells, (cell) => visibleWidth(cell.content) + 2, 1, Math.max(1, width - 1));
            return lines.map((g) => truncateToWidth(renderSolidLine(g), width));
          }

          // thin → single line (truncation is graceful; no need to wrap).
          // separator glyph in `muted` (#777777, ~4:1) — was borderMuted (#555555,
          // ~2.4:1) which made the inter-segment glyph nearly invisible, so
          // /encom-sep style changes weren't perceptible. muted reads clearly.
          const sep = theme.fg("muted", separator());
          const line = buildContents()
            .map((cc) => cc.thinParts.map((p) => theme.fg(p.fg, p.text)).join(""))
            .join(sep);
          return [truncateToWidth(line, width)];
        },
      };
    });

    // Live clock + streaming-aware ticker (V10): re-render every ~1s idle, or
    // ~250ms while a response streams so context/tokens move live.
    startTicker();
  };

  const unmount = (c: ExtensionContext): void => {
    if (clockTick) {
      clearInterval(clockTick);
      clockTick = undefined;
    }
    requestRender = undefined;
    c.ui.setFooter(undefined); // restore built-in footer
  };

  // ── V3 toggle: flip Nerd-font rendering live from the prompt (/encom-nerd) ──
  // Env vars are read only at launch; this overrides at runtime so the operator
  // can iterate without relaunching. `/encom-nerd` with no arg → auto-detect.
  pi.registerCommand("encom-nerd", {
    description: "Toggle statusline Nerd-font mode: on | off | auto",
    handler: async (args, c) => {
      const a = args.trim().toLowerCase();
      if (a === "on" || a === "1" || a === "true") nerdOverride = true;
      else if (a === "off" || a === "0" || a === "false") nerdOverride = false;
      else if (a === "auto" || a === "") nerdOverride = null;
      else {
        c.ui.notify("Usage: /encom-nerd on | off | auto", "info");
        return;
      }
      const mode = nerdOverride === null ? "auto" : nerdOverride ? "on" : "off";
      c.ui.notify(`encom nerd mode → ${mode}`, "info");
      requestRender?.();
    },
  });

  // ── V5 toggle: switch statusline style live (solid bg-blocks vs thin separators) ──
  pi.registerCommand("encom-style", {
    description: "Statusline style: solid (bg-block powerline) | thin (separators)",
    handler: async (args, c) => {
      const a = args.trim().toLowerCase();
      if (a === "solid" || a === "bg" || a === "blocks") styleOverride = "solid";
      else if (a === "thin" || a === "default" || a === "reset") styleOverride = "thin";
      else { c.ui.notify("Usage: /encom-style solid | thin", "info"); return; }
      const label = styleOverride === "solid" ? "bg-block powerline" : "thin separators";
      c.ui.notify(`encom style → ${styleOverride} (${label})`, "info");
      requestRender?.();
    },
  });

  // ── V9: preset switch + status (Phase 3) ───────────────────────────────────
  pi.registerCommand("encom-preset", {
    description: "Switch statusline preset: default | minimal | full",
    handler: async (args, c) => {
      const name = args.trim().toLowerCase();
      if (!PRESETS[name]) {
        c.ui.notify(`Usage: /encom-preset ${Object.keys(PRESETS).join(" | ")}`, "info");
        return;
      }
      encomConfig = { ...encomConfig, preset: name };
      persistPreset(name, c);
      c.ui.notify(`encom preset → ${name} (saved)`, "info");
      requestRender?.();
    },
  });

  pi.registerCommand("encom", {
    description: "Show current statusline config (preset, segments, custom items)",
    handler: async (_args, c) => {
      const preset = encomConfig.preset ?? "default";
      const segs = resolveLayout(encomConfig).join(", ");
      const n = encomConfig.customItems?.length ?? 0;
      c.ui.notify(`preset: ${preset} | ${segs}${n ? ` | customItems: ${n}` : ""}`, "info");
    },
  });

  // ── V10: thin-path separator switch (Phase 4) ─────────────────────────────
  pi.registerCommand("encom-sep", {
    description: "Thin-path separator style: powerline-thin|powerline|chevron|slash|pipe|dot|star|block|none|ascii",
    handler: async (args, c) => {
      const name = args.trim().toLowerCase();
      if (!(name in SEP_GLYPHS)) {
        c.ui.notify(`Usage: /encom-sep ${Object.keys(SEP_GLYPHS).join(" | ")}`, "info");
        return;
      }
      sepStyle = name as SepStyle;
      c.ui.notify(`encom separator → ${name}`, "info");
      requestRender?.();
    },
  });

  pi.on("session_start", (_event, c) => {
    if (!c.hasUI) return; // LR-0017: no footer / interval in print mode.
    // Reset V2/V8 runtime stats for the new session (all are session-since-load).
    sessionCost = 0;
    tpsSamples.length = 0;
    firstTokenMs = undefined;
    cacheReadTokens = 0;
    cacheWriteTokens = 0;
    sessionStartMs = Date.now();
    encomConfig = readEncomConfig(c.cwd);   // V9: load footer config for this session
    mount(c);
  });

  // Reflect model/thinking changes immediately (don't wait up to 1s for the clock tick).
  // V2: capture first-token time for generation-speed (tps) timing.
  pi.on("message_update", (event) => {
    if (firstTokenMs === undefined && event.assistantMessageEvent?.type === "text_delta") {
      firstTokenMs = Date.now();
    }
  });

  // V2: on each assistant response end — accumulate cost + compute tps, then re-render.
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") { firstTokenMs = undefined; return; }
    const usage = event.message.usage;
    // cost: prefer precomputed total, else sum the components.
    const c = usage?.cost as
      | { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
      | undefined;
    if (c) {
      sessionCost += typeof c.total === "number"
        ? c.total
        : (c.input ?? 0) + (c.output ?? 0) + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0);
    }
    // V8: cache token totals — top-level on Usage (TOKEN counts), NOT usage.cost.*
    // (which are dollars). Accumulate across assistant turns this session.
    cacheReadTokens += usage?.cacheRead ?? 0;
    cacheWriteTokens += usage?.cacheWrite ?? 0;
    // tps: output tokens / generation time (first token → end).
    const outputTokens = usage?.output ?? 0;
    if (firstTokenMs !== undefined && outputTokens > 0) {
      const genMs = Date.now() - firstTokenMs;
      if (genMs > 0) {
        tpsSamples.push(outputTokens / (genMs / 1000));
        if (tpsSamples.length > TPS_WINDOW) tpsSamples.shift();
      }
    }
    firstTokenMs = undefined;
    requestRender?.();
  });

  pi.on("model_select", () => requestRender?.());
  pi.on("thinking_level_select", () => requestRender?.());

  // V10: speed up the ticker while a response streams so context/tokens move live.
  pi.on("agent_start", () => { isStreaming = true; startTicker(); });
  pi.on("agent_end", () => { isStreaming = false; startTicker(); });

  pi.on("session_shutdown", () => {
    if (ctx) unmount(ctx);
  });
}
