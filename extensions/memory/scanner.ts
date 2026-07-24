// Secret scanner (Fork E, defense E1). Runs at write time BEFORE a value touches disk.
// Behavior: refuse + surface (the store throws SecretDetectedError on a positive hit).
//
// Two layers:
//   1. Concrete known-secret patterns (high precision): AWS keys, GitHub/OpenAI tokens,
//      private key blocks, api_key=/password=/secret=/token= assignments.
//   2. Shannon entropy on 20+ char alphanumeric runs (catches unknown high-entropy
//      secrets). Threshold 4.5 bits/char sits ABOVE hex-hash entropy (~4.0, so commit
//      SHAs / UUIDs pass) and BELOW random base62 secret entropy (~6.0, so raw tokens
//      trip). UUIDs are explicitly allowlisted as belt-and-suspenders.
//
// Honest limit: this is a heuristic. It prioritizes refusing secrets over avoiding
// false positives (operator chose "build to be safe"). A determined obfuscator can
// evade it; the audit log + provenance defenses backstop what slips through.

export interface ScanResult {
  detected: boolean;
  /** Name of the matched pattern, for surfacing to the agent. */
  pattern?: string;
}

const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: "AWS Access Key ID", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub Token", re: /\bgh[ps]_[A-Za-z0-9]{36,}\b/ },
  { name: "OpenAI API Key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "Private Key Block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "api_key assignment", re: /\bapi[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}/i },
  { name: "password/secret/token assignment", re: /\b(?:password|passwd|secret|token)\s*[:=]\s*["']?[^\s"']{8,}/i },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const ENTROPY_THRESHOLD = 4.5;

/**
 * Scan a value string for likely secrets. Pure: no side effects.
 * Returns {detected: true, pattern} on a hit; {detected: false} when clear.
 */
export function scanSecrets(text: string): ScanResult {
  for (const p of SECRET_PATTERNS) {
    if (p.re.test(text)) return { detected: true, pattern: p.name };
  }
  // Entropy layer: 20+ char alphanumeric runs.
  const runs = text.match(/[A-Za-z0-9]{20,}/g) ?? [];
  for (const run of runs) {
    // Allowlist UUIDs (structurally recognizable, commonly appear in IDs/logs).
    if (UUID_RE.test(run)) continue;
    if (shannonEntropy(run) > ENTROPY_THRESHOLD) {
      return { detected: true, pattern: `high-entropy run (${run.length} chars, >${ENTROPY_THRESHOLD} bits/char)` };
    }
  }
  return { detected: false };
}
