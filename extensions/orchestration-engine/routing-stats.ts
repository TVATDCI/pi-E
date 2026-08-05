// routing-stats.ts — pure aggregation for /routing-stats (Decision 0004 / F6).
// Runtime-standalone (unit-testable): the only external import is `type UsageStats`
// from spawn.ts, erased at compile time → no pi/typebox runtime deps.
// Mirrors the python probe that validated this logic on real session data.

import type { UsageStats } from "./spawn.ts";

export interface DispatchLogEntry {
  category?: string;
  modelFlag?: string;
  thinkingLevel?: string;
  source?: string; // "tier-map" | "persona-override" | "downshift-unavailable"
  downshiftedFrom?: string;
  agent?: string | null;
  outcome?: string; // "done" | "error" | "timeout" | "aborted"  (F6: timeout counts as fail; aborted is operator-initiated, not a fail)
  elapsedMs?: number;
  task?: string;
  usage?: UsageStats; // 1b/1c: token/cost capture (present when the dispatch produced an assistant turn)
}

export interface RoutingStats {
  n: number;
  fails: number;
  overrides: number;
  lines: string[];
  flags: string[];
}

function pad(s: unknown, w: number): string {
  const t = String(s ?? "");
  return (t.length > w ? t.slice(0, Math.max(1, w - 1)) + "…" : t).padEnd(w);
}

function pctNum(vals: number[], p: number): number | null {
  const v = vals.filter((x) => x != null && !Number.isNaN(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.round((p / 100) * (v.length - 1))];
}

function fmtMs(v: number | null): string {
  if (v == null) return "-";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`;
}

/** Quota multiplier for the per-model view. FREE for opencode; 1×/2×/3× for the promo-flagship glm-5.2/5-turbo; 1× otherwise. */
export function quotaMarker(modelFlag: string | undefined, peak: boolean, promo: boolean): string {
  if (!modelFlag) return "?";
  if (modelFlag.startsWith("opencode/")) return "FREE";
  const id = modelFlag.split("/")[1] ?? "";
  if (id === "glm-5.2" || id === "glm-5-turbo") return peak ? "3×" : promo ? "1×" : "2×";
  return "1×";
}

function group<K extends string>(entries: DispatchLogEntry[], key: (e: DispatchLogEntry) => K): Map<K, DispatchLogEntry[]> {
  const m = new Map<K, DispatchLogEntry[]>();
  for (const e of entries) {
    const k = key(e);
    const arr = m.get(k);
    if (arr) arr.push(e);
    else m.set(k, [e]);
  }
  return m;
}

/**
 * Aggregate dispatch-log entries into the four views + dumb-threshold flags.
 * Pure: same input ⇒ same output, no side effects, no pi runtime.
 */
export function aggregateDispatchLog(
  entries: DispatchLogEntry[],
  opts: { peak: boolean; promo: boolean },
): RoutingStats {
  const n = entries.length;
  // F6 (Edit 7): count `timeout` as a failure (a hung model IS a routing problem) but NOT `aborted`
  // (operator-initiated cancel — not the model's fault; counting it would unfairly penalize models).
  const fails = entries.filter((e) => e.outcome === "error" || e.outcome === "timeout").length;
  const overrides = entries.filter((e) => e.source === "persona-override").length;
  const lines: string[] = [];
  const flags: string[] = [];

  if (n === 0) {
    return {
      n: 0,
      fails: 0,
      overrides: 0,
      lines: ["(no dispatch-log entries in this session — run some dispatches first)"],
      flags: [],
    };
  }

  const pctStr = (x: number, y: number) => `${Math.round((100 * x) / y)}%`;
  lines.push(
    `/routing-stats · ${n} dispatches · ${fails} errors (${pctStr(fails, n)}) · ${overrides} overrides (${pctStr(overrides, n)})`,
  );

  // per-category
  lines.push(
    "",
    "▌ per-category",
    pad("category", 18) + pad("n", 4) + pad("fail%", 6) + pad("model", 22) + pad("p50", 8) + pad("p95", 8),
  );
  const byCat = group(entries, (e) => e.category ?? "?");
  for (const [c, es] of [...byCat].sort((a, b) => b[1].length - a[1].length)) {
    const f = es.filter((e) => e.outcome === "error" || e.outcome === "timeout").length;
    const ms = es.map((e) => e.elapsedMs ?? 0);
    const mc = group(es, (e) => e.modelFlag ?? "?");
    const topM = [...mc].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? "?";
    lines.push(
      pad(c, 18) +
        pad(es.length, 4) +
        pad(pctStr(f, es.length), 6) +
        pad(topM, 22) +
        pad(fmtMs(pctNum(ms, 50)), 8) +
        pad(fmtMs(pctNum(ms, 95)), 8),
    );
    if (es.length >= 3 && f / es.length > 0.25)
      flags.push(`⚠ ${c} fails ${pctStr(f, es.length)} on ${topM} (${f}/${es.length})`);
  }

  // per-model
  lines.push(
    "",
    "▌ per-model",
    pad("model", 26) + pad("n", 4) + pad("fail%", 6) + pad("p50", 8) + pad("p95", 8) + pad("quota", 6),
  );
  const byModel = group(entries, (e) => e.modelFlag ?? "?");
  for (const [m, es] of [...byModel].sort((a, b) => b[1].length - a[1].length)) {
    const f = es.filter((e) => e.outcome === "error" || e.outcome === "timeout").length;
    const ms = es.map((e) => e.elapsedMs ?? 0);
    lines.push(
      pad(m, 26) +
        pad(es.length, 4) +
        pad(pctStr(f, es.length), 6) +
        pad(fmtMs(pctNum(ms, 50)), 8) +
        pad(fmtMs(pctNum(ms, 95)), 8) +
        pad(quotaMarker(m, opts.peak, opts.promo), 6),
    );
  }

  // per-agent (persona)
  lines.push(
    "",
    "▌ per-agent",
    pad("agent", 22) + pad("n", 4) + pad("override%", 9) + pad("fail%", 6),
  );
  const byAgent = group(entries, (e) => e.agent ?? "(none/tier-map)");
  for (const [a, es] of [...byAgent].sort((x, y) => y[1].length - x[1].length)) {
    const ov = es.filter((e) => e.source === "persona-override").length;
    const f = es.filter((e) => e.outcome === "error" || e.outcome === "timeout").length;
    lines.push(pad(a, 22) + pad(es.length, 4) + pad(pctStr(ov, es.length), 9) + pad(pctStr(f, es.length), 6));
    if (es.length >= 2 && ov === es.length)
      flags.push(`⚠ ${a} overrides 100% (${ov}/${es.length}) — check its .md \`model:\` pin`);
  }

  // 1c: usage (cost + tokens) — shown only when some dispatch captured usage.
  const withUsage = entries.filter((e) => e.usage);
  if (withUsage.length > 0) {
    const sumCost = (es: DispatchLogEntry[]) => es.reduce((s, e) => s + (e.usage?.cost ?? 0), 0);
    const sumTurns = (es: DispatchLogEntry[]) => es.reduce((s, e) => s + (e.usage?.turns ?? 0), 0);
    const avgCtx = (es: DispatchLogEntry[]) =>
      Math.round(es.reduce((s, e) => s + (e.usage?.contextTokens ?? 0), 0) / es.length);
    const fmtCost = (v: number) => (v > 0 ? `$${v.toFixed(4)}` : "$0");
    const totCost = sumCost(withUsage);
    lines.push(
      "",
      "▌ usage",
      `  ${withUsage.length}/${n} with usage · total ${fmtCost(totCost)} · avg ${fmtCost(totCost / withUsage.length)}/disp · turns ${sumTurns(withUsage)} · avg ctx ${avgCtx(withUsage)} tok`,
    );
    const usageByCat = group(withUsage, (e) => e.category ?? "?");
    lines.push(
      "  " + pad("category", 16) + pad("n", 4) + pad("cost", 10) + pad("avg$", 9) + pad("avgctx", 8) + pad("turns", 6),
    );
    for (const [c, es] of [...usageByCat].sort((a, b) => b[1].length - a[1].length)) {
      lines.push(
        "  " +
          pad(c, 16) +
          pad(es.length, 4) +
          pad(fmtCost(sumCost(es)), 10) +
          pad(fmtCost(sumCost(es) / es.length), 9) +
          pad(avgCtx(es), 8) +
          pad(sumTurns(es), 6),
      );
    }
  }

  // routing source (dynamic — includes downshift-unavailable when present)
  const srcCount = group(entries, (e) => e.source ?? "?");
  lines.push("", "▌ routing source");
  for (const [src, es] of [...srcCount].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${pad(src, 18)}${pad(es.length, 4)}(${pctStr(es.length, n)})`);
  }
  if (overrides / n > 0.3)
    flags.push(`⚠ high override rate (${pctStr(overrides, n)}) — persona pins may be over-firing`);
  const downshifts = (srcCount.get("downshift-unavailable") ?? []).length;
  if (downshifts > 0)
    flags.push(`⚠ ${downshifts} dispatch${downshifts === 1 ? "" : "es"} downshifted (chosen model unavailable) — run /tiers`);
  const exhausted = (srcCount.get("downshift-exhausted") ?? []).length;
  if (exhausted > 0)
    flags.push(`⚠ ${exhausted} dispatch${exhausted === 1 ? "" : "es"} retried after empty response (likely quota exhausted) — check fallback usage`);

  if (flags.length) {
    lines.push("", "▌ flags");
    for (const f of flags) lines.push("  " + f);
  }
  return { n, fails, overrides, lines, flags };
}
