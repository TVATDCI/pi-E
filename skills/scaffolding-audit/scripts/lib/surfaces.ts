/**
 * pi audited-surface enumeration (shared spec §6).
 *
 * Surfaces are self-enumerated at run time — never a hardcoded skill count.
 * The scaffolding-audit skill dir itself is excluded (self-exclusion: its docs
 * and vendored spec legitimately quote specimens and token lists).
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export const SKILL_SELF_DIR = "scaffolding-audit";

export type Surface = {
  /** Repo-relative (or absolute) path as it should appear in flags. */
  path: string;
  /** Absolute path to read. */
  absPath: string;
  /** ".ts" surfaces apply comment-where rules to comment lines only. */
  kind: "ts" | "md";
};

export function piSurfaces(agentRoot: string): Surface[] {
  const surfaces: Surface[] = [
    {
      path: "extensions/orchestration-engine/tier-map.ts",
      absPath: join(agentRoot, "extensions/orchestration-engine/tier-map.ts"),
      kind: "ts",
    },
    {
      path: "AGENTS.md",
      absPath: join(agentRoot, "AGENTS.md"),
      kind: "md",
    },
  ];
  const skillsDir = join(agentRoot, "skills");
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return surfaces;
  }
  const names = entries
    .filter((e) => e.isDirectory() && e.name !== SKILL_SELF_DIR)
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const skillMd = join(skillsDir, name, "SKILL.md");
    surfaces.push({
      path: `skills/${name}/SKILL.md`,
      absPath: skillMd,
      kind: "md",
    });
  }
  return surfaces;
}

/** Comment-line test for .ts surfaces (shared spec §7 `where: comment`). */
export function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\/|\/\*|\*)/.test(line);
}
