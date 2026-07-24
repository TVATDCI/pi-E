// agent-map.ts — Tier 2a: category → functional-agent DEFAULT.
// The mapping is a DEFAULT for when `agent` is omitted from dispatch — it is
// NOT a coupling. dispatch("quick", agent="morpheus") stays legal (explicit
// agent always wins). tier-map.ts remains the sole model authority.
import type { TaskCategory } from "./tier-map.ts";

const CATEGORY_AGENT_DEFAULTS: Record<TaskCategory, string> = {
  "quick": "keymaker",
  "unspecified-low": "trinity",
  "unspecified-high": "trinity",
  "deep": "morpheus",
  "ultrabrain": "neo",
  "writing": "mouse",
  "visual-engineering": "architect",
  "artistry": "architect",
  "research": "researcher",
  "git-commit-message": "seraph",
};

/** Resolve the default functional-agent name for a category. Fallback: trinity. */
export function resolveFunctionalAgent(category: TaskCategory): string {
  return CATEGORY_AGENT_DEFAULTS[category] ?? "trinity";
}
