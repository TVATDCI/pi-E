// orchestration-engine/description.ts — the dispatch tool's routing text, DERIVED from TIERS at
// registration time. Single source: the category→model list can never lag a tier-map edit — the
// former hand-maintained copy went a revision stale (advertised the ex-primary after the
// ultrabrain trial reroute), and the tool description IS a routing surface the primary reads
// when choosing a category. Pure module (imports only tier-map) so persona-routing T6 pins it
// against TIERS directly.

import { TIERS } from "./tier-map.ts";

/** The dispatch tool description. The category→model list is derived from TIERS; the operator-seat
 *  sentences, default-operative line and routing guardrail are hand-text pinned by T6. The agent
 *  model-pin count is appended by index.ts at registration (derived from the live agents dir —
 *  it cannot be pure here without reading the filesystem). */
export function dispatchDescription(): string {
  const list = Object.entries(TIERS)
    .map(([cat, e]) => `${cat} (${e.provider}/${e.id})`)
    .join(", ");
  return (
    "Delegate a sub-task to an isolated sub-agent. BLOCKS until finished. " +
    "Pick the category that matches the task's weight — this chooses the model via tier-map AND auto-resolves a functional agent (Matrix operative). " +
    "When agent is omitted AND no team is specified, the category's default operative is used: " +
    "quick→keymaker, unspecified→trinity, deep→morpheus, ultrabrain→neo, writing→mouse, visual-engineering/artistry→architect, research→researcher, git-commit-message→seraph, security-review→security-reviewer, local-research→home-keeper. " +
    "Explicit agent= overrides the default (e.g. agent='momus' for a PRD gate, agent='oracle' for architecture reasoning). " +
    `Categories (tier-map.ts is authoritative): ${list}. ` +
    "security-review: deep read-only security gate (glm-only strong chain; tools pinned to read,grep,find,ls — the seat never writes). " +
    "local-research: OPERATOR-ONLY vehicle (flash-family fallbacks only) — local synthesis + housekeeping for the operator's own dispatches; auto-routing into it BOUNCES unless the operator named home-keeper in their typed message this turn; explicit agent=home-keeper stays legal. " +
    "Routing: for vague/ambiguous work (UX, product, planning, 'scoping IS the task') prefer writing/unspecified-low (reads intent) — reserve deep/ultrabrain for well-scoped hard tasks; they loop on open-ended goals (tier-map.ts ROUTING GUARDRAIL). "
  );
}
