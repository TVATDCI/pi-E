// extensions/background-helpers.ts — pure helpers for background dispatch (Group 3).
// Deliberately NO @earendil-works/pi-coding-agent dependency, so it's unit-testable under bare
// `node --experimental-strip-types` (agent-chain.ts value-imports modules whose inline
// `import { type X }` pi-coding-agent lines bare node won't elide). A /stop abort is distinct
// from a natural failure.
export type BgStatus = "completed" | "failed" | "stopped";

export function resolveBgStatus(stopped: boolean, resultOk: boolean): BgStatus {
  return stopped ? "stopped" : resultOk ? "completed" : "failed";
}

export function formatBgToast(chainName: string, status: BgStatus, durationMs: number, preview: string): string {
  const icon = status === "completed" ? "✓" : status === "stopped" ? "■" : "✗";
  const body = (preview || "(no output)").slice(0, 600);
  return `Background ${status}: ${icon} ${chainName} · ${Math.round(durationMs / 1000)}s\n${body}`;
}

// ── Fleet view (pure formatFleet for /chain-status) ─────────────────────────────────────

export interface FleetStep {
  name: string;
  status: string;
  modelFlag?: string;
  toolCount?: number;
  usage?: { contextTokens?: number };
}

export interface FleetEntry {
  id: number;
  chainName: string;
  status: string;
  background?: boolean;
  elapsed: number;
  steps: FleetStep[];
}

const FLEET_CAP = 10;

export function formatFleet(entries: FleetEntry[]): string[] {
  if (entries.length === 0) return ["No chain runs (active or recent)."];

  // Order: running-first (newest), then done/error (newest).
  const ranked = [...entries].sort((a, b) => {
    const aRun = a.status === "running" ? 0 : 1;
    const bRun = b.status === "running" ? 0 : 1;
    if (aRun !== bRun) return aRun - bRun;
    return b.id - a.id; // newest-first within group
  });

  const show = ranked.slice(0, FLEET_CAP);
  const header = `Chain runs (${entries.length}${entries.length > FLEET_CAP ? ", showing " + FLEET_CAP : ""}):`;
  const rows: string[] = [header];

  for (const e of show) {
    const glyph = e.status === "running" ? "⟳" : e.status === "done" ? "✓" : "✗";
    const bg = e.background ? " [bg]" : "";
    const secs = Math.round(e.elapsed / 1000);
    let line = `  ${glyph} #${e.id} ${e.chainName}${bg} · ${secs}s`;

    // For running chains: show current step detail.
    const running = e.steps.find((s) => s.status === "running");
    if (running) {
      const idx = e.steps.indexOf(running) + 1;
      const model = running.modelFlag ? " · " + (running.modelFlag.includes("/") ? running.modelFlag.split("/")[1] : running.modelFlag) : "";
      const tools = running.toolCount ? ` · ${running.toolCount}🛠` : "";
      const tok = running.usage?.contextTokens ? ` · ${formatTokens(running.usage.contextTokens)} tok` : "";
      line += ` · step ${idx}/${e.steps.length}: ${running.name}${model}${tools}${tok}`;
    }
    rows.push(line);
  }

  if (ranked.length > FLEET_CAP) {
    rows.push(`  +${ranked.length - FLEET_CAP} more`);
  }
  return rows;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ── Transcript tail (/chain-transcript) ─────────────────────────────────────────────────

export interface TranscriptStep {
  name: string;
  status: string;
  modelFlag?: string;
  toolCount?: number;
  output?: string;
  accumulatedText?: string;
}

export interface TranscriptEntry {
  id: number;
  chainName: string;
  status: string;
  background?: boolean;
  elapsed: number;
  steps: TranscriptStep[];
}

const TRANSCRIPT_MAX = 600;

export function formatTranscript(entry: TranscriptEntry): string[] {
  const glyph = entry.status === "running" ? "⟳" : entry.status === "done" ? "✓" : "✗";
  const bg = entry.background ? " [bg]" : "";
  const header = `Transcript #${entry.id} ${entry.chainName}${bg} · ${Math.round(entry.elapsed / 1000)}s:`;
  const rows: string[] = [header, ""];

  for (let i = 0; i < entry.steps.length; i++) {
    const s = entry.steps[i]!;
    const idx = i + 1;
    const statusGlyph = s.status === "running" ? "⟳" : s.status === "done" ? "✓" : s.status === "error" ? "✗" : "○";
    const model = s.modelFlag ? " · " + (s.modelFlag.includes("/") ? s.modelFlag.split("/")[1] : s.modelFlag) : "";
    const tools = s.toolCount ? ` · ${s.toolCount}🛠` : "";
    rows.push(`  ${statusGlyph} step ${idx}/${entry.steps.length}: ${s.name}${model}${tools} (${s.status})`);

    // For running steps: show accumulated text (tail). For done/error: show output.
    const text = s.status === "running" ? s.accumulatedText : s.output;
    if (text && text.trim()) {
      const trimmed = text.replace(/\s+/g, " ").trim();
      // Tail (last TRANSCRIPT_MAX chars) — show where the child is NOW.
      const tail = trimmed.length > TRANSCRIPT_MAX ? "…" + trimmed.slice(-TRANSCRIPT_MAX) : trimmed;
      rows.push(`    ⎿ ${tail}`);
    }
  }
  return rows;
}

// Top-level extensions/*.ts must export a default factory for pi's loader.
export default function () {}
