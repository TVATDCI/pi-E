/**
 * OPEN-2 session-start drift consumer (scaffolding-audit).
 * Spawns the skill's prescribed read-only CLI — the subprocess's
 * --allow-read grant IS the zero-write proof (INV-2):
 *   deno run --allow-read <skill>/scripts/drift-check.ts
 * stdout non-empty → one footer line; silent when fresh; fail-open always.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SCRIPT = join(
  os.homedir(),
  ".pi",
  "agent",
  "skills",
  "scaffolding-audit",
  "scripts",
  "drift-check.ts",
);

export default function register(pi: ExtensionAPI): void {
  pi.on("session_start", async (_e, ctx) => {
    if (ctx?.mode !== "tui") return; // headless modes: no surface, no need
    try {
      const r = spawnSync("deno", ["run", "--allow-read", SCRIPT], {
        encoding: "utf8",
        timeout: 10_000,
      });
      const line = (r.stdout ?? "").trim();
      if (line) ctx.ui?.setStatus("drift", `⚠ ${line}`);
    } catch {
      /* fail-open: drift display never blocks session start */
    }
  });
}
