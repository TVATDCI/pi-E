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

// Top-level extensions/*.ts must export a default factory for pi's loader.
export default function () {}
