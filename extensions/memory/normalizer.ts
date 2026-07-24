// Key normalizer (Fork A). Topic-based keys are supplied by the agent in roughly
// lowercase_underscore form; the system normalizes mechanically as a safety net.
// Goal: same topic -> same key across sessions (survives rewording) so the keyed
// upsert model dedups reliably.
//
// Pure: same input -> same output, no side effects.

/**
 * Normalize a raw key into canonical lowercase_underscore form.
 *  - trims, splits camelCase boundaries, lowercases
 *  - collapses any non-alphanumeric run to a single underscore
 *  - strips leading/trailing underscores
 *  - caps length at 64 chars
 * Returns "" for empty / all-symbol input (caller must reject empty keys).
 */
export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camelCase boundary -> underscore (before lowercasing)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_") // non-alphanumeric runs -> single underscore
    .replace(/^_+|_+$/g, "") // strip leading/trailing underscores
    .slice(0, 64);
}
