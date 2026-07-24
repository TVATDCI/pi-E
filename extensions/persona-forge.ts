import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { runChainByName } from "./chain-runner.ts";
import type { TaskCategory } from "./orchestration-engine/tier-map.ts";

interface PendingPersona {
  targetId: string;
  newId: string;
  markdown: string;
  rationale: string;
  verdict: string;
  generatedAt: number;
}

interface TeamMember {
  id: string;
  file: string;
  category?: TaskCategory;
  provenance?: {
    source: "generated";
    generated_by: string;
    review_status: "pending" | "approved" | "stale";
    parent: string;
  };
}

interface Team {
  description: string;
  default_category?: TaskCategory;
  members: TeamMember[];
}

interface TeamsFile {
  version?: string;
  teams: Record<string, Team>;
}

const AGENTS_DIR = join(os.homedir(), ".pi", "agent", "agents");
const TEAMS_PATH = join(os.homedir(), ".pi", "agent", "teams.yaml");
const PENDING_DIR = join(os.homedir(), ".pi", "agent", "sessions", "persona-forge");
const GENERATED_BY = "persona-forge@v1";

function loadTeams(): TeamsFile {
  if (!existsSync(TEAMS_PATH)) return { version: "1.0", teams: {} };
  try {
    const raw = yamlParse(readFileSync(TEAMS_PATH, "utf-8")) as TeamsFile;
    return { version: raw.version ?? "1.0", teams: raw.teams ?? {} };
  } catch {
    return { version: "1.0", teams: {} };
  }
}

function saveTeams(teams: TeamsFile) {
  writeFileSync(TEAMS_PATH, yamlStringify(teams, { lineWidth: 0, indent: 2 }), "utf-8");
}

function sanitizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function pendingPath(newId: string): string {
  return join(PENDING_DIR, `${newId}.json`);
}

function savePending(p: PendingPersona) {
  mkdirSync(PENDING_DIR, { recursive: true });
  writeFileSync(pendingPath(p.newId), JSON.stringify(p, null, 2), "utf-8");
}

function loadPending(newId: string): PendingPersona | undefined {
  const path = pendingPath(newId);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PendingPersona;
  } catch {
    return undefined;
  }
}

function deletePending(newId: string) {
  try {
    rmSync(pendingPath(newId));
  } catch { }
}

function extractVerdict(text: string): string {
  const first = text.trim().split(/\n/)[0]?.toUpperCase() ?? "";
  if (first.includes("PASS")) return "PASS";
  if (first.includes("WARNING")) return "WARNING";
  if (first.includes("FAIL")) return "FAIL";
  return "UNKNOWN";
}

export default function (pi: ExtensionAPI) {
  const pending = new Map<string, PendingPersona>();

  pi.registerCommand("persona-forge", {
    description: "Generate and review persona variants: /persona-forge evolve <target> | /persona-forge approve <new-id> | /persona-forge list | /persona-forge reject <new-id>",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/);
      const sub = tokens[0]?.toLowerCase() ?? "";
      const targetId = tokens[1] ?? "";

      if (sub === "evolve" && targetId) {
        await runEvolve(pi, targetId, ctx, pending);
        return;
      }
      if (sub === "approve" && targetId) {
        await runApprove(targetId, ctx, pending);
        return;
      }
      if (sub === "reject" && targetId) {
        pending.delete(targetId);
        deletePending(targetId);
        ctx.ui.notify(`Rejected pending persona '${targetId}'.`, "info");
        return;
      }
      if (sub === "list") {
        const entries = [...pending.values()].sort((a, b) => b.generatedAt - a.generatedAt);
        const diskFiles = existsSync(PENDING_DIR) ? readdirSync(PENDING_DIR) : [];
        const lines = entries.map((p) => `- ${p.newId} (${p.verdict}) — ${p.targetId} — ${new Date(p.generatedAt).toISOString()}`);
        const diskOnly = diskFiles
          .filter((f) => f.endsWith(".json") && !entries.some((p) => p.newId === f.replace(/\.json$/, "")))
          .map((f) => `- ${f.replace(/\.json$/, "")} (on disk only)`);
        ctx.ui.notify(`Pending personas: ${entries.length}`, entries.length ? "info" : "warning");
        await ctx.ui.editor("/persona-forge-list", ["Pending personas:", ...lines, ...diskOnly].join("\n"));
        return;
      }

      ctx.ui.notify("Usage: /persona-forge evolve <target> | /persona-forge approve <new-id> | /persona-forge list | /persona-forge reject <new-id>", "warning");
    },
  });

  async function runEvolve(
    pi: ExtensionAPI,
    targetId: string,
    ctx: ExtensionContext,
    pending: Map<string, PendingPersona>,
  ) {
    const targetPath = join(AGENTS_DIR, `${targetId}.md`);
    if (!existsSync(targetPath)) {
      ctx.ui.notify(`Target persona '${targetId}' not found in ${AGENTS_DIR}`, "error");
      return;
    }

    const evidence = [
      `Target persona id: ${targetId}`,
      `Target persona file: ${targetPath}`,
      `Current working directory: ${ctx.cwd}`,
      "Suggest a specialized variant of this persona that addresses a clear gap.",
    ].join("\n\n");

    const chainResult = await runChainByName(
      pi, ctx, "persona-forge-evolve", evidence, ctx.cwd, true,
    );
    if (!chainResult.ok) {
      ctx.ui.notify(`Chain failed at step '${chainResult.error?.step ?? "unknown"}': ${chainResult.error?.output.slice(0, 200)}`, "error");
      return;
    }

    const debugLines = chainResult.stepResults.map((r) =>
      `STEP: ${r.name}\nCODE: ${r.code}\nLEN: ${r.output.length}\nOUTPUT:\n${r.output || "(empty)"}`,
    );

    const generateStep = chainResult.stepResults.find((r) => r.name === "generate");
    const reviewStep = chainResult.stepResults.find((r) => r.name === "review");
    if (!generateStep || !reviewStep) {
      ctx.ui.notify("Chain returned unexpected step names; expected 'generate' and 'review'.", "error");
      await ctx.ui.editor("/persona-forge-debug", debugLines.join("\n\n---\n\n"));
      return;
    }

    const generated = generateStep.output;
    const reviewText = reviewStep.output;
    const verdict = extractVerdict(reviewText);
    const analyzeStep = chainResult.stepResults.find((r) => r.name === "analyze");

    // Try to extract a new id from the generated frontmatter name field.
    const nameMatch = generated.match(/^---\n[\s\S]*?name:\s*(.+?)\n[\s\S]*?---/m);
    const newId = nameMatch ? sanitizeId(nameMatch[1].trim()) : `${targetId}-v2`;

    const pendingEntry: PendingPersona = {
      targetId,
      newId,
      markdown: generated,
      rationale: analyzeStep?.output ?? "",
      verdict,
      generatedAt: Date.now(),
    };
    pending.set(newId, pendingEntry);
    savePending(pendingEntry);

    const header = `Generated: ${newId} (variant of ${targetId})`;
    const body = [
      header,
      `Verdict: ${verdict}`,
      "",
      "=== Generated persona ===",
      generated,
      "",
      "=== Review justification ===",
      reviewText,
      "",
      "=== DEBUG raw step outputs ===",
      debugLines.join("\n\n---\n\n"),
      "",
      `Run /persona-forge approve ${newId} to write agents/${newId}.md and append to teams.yaml (review_status: pending).`,
    ].join("\n");

    ctx.ui.notify(`${newId}: ${verdict} — ${reviewText.slice(0, 120).replace(/\n/g, " ")}`, verdict === "FAIL" ? "error" : verdict === "WARNING" ? "warning" : "info");
    await ctx.ui.editor("/persona-forge", body);
  }

  async function runApprove(newId: string, ctx: ExtensionContext, pending: Map<string, PendingPersona>) {
    let p = pending.get(newId);
    if (!p) {
      p = loadPending(newId);
      if (p) pending.set(newId, p);
    }
    if (!p) {
      ctx.ui.notify(`No pending persona '${newId}'. Run /persona-forge evolve <target> first.`, "warning");
      return;
    }

    if (p.verdict === "FAIL") {
      ctx.ui.notify(`Refusing to write ${newId}: momus verdict was FAIL.`, "error");
      return;
    }

    const filePath = join(AGENTS_DIR, `${newId}.md`);
    if (existsSync(filePath)) {
      ctx.ui.notify(`agents/${newId}.md already exists. Pick a different id or remove it first.`, "error");
      return;
    }

    const confirmed = await ctx.ui.confirm(`Write agents/${newId}.md and append to teams.yaml with provenance?`, "info");
    if (!confirmed) {
      ctx.ui.notify("Approval cancelled.", "info");
      return;
    }

    writeFileSync(filePath, p.markdown, "utf-8");

    const teams = loadTeams();
    if (!teams.teams["generated-reviewers"]) {
      teams.teams["generated-reviewers"] = {
        description: "Generated variants pending operator approval",
        default_category: "deep",
        members: [],
      };
    }
    const team = teams.teams["generated-reviewers"];
    if (!team.members.some((m) => m.id === newId)) {
      team.members.push({
        id: newId,
        file: `agents/${newId}.md`,
        category: "deep",
        provenance: {
          source: "generated",
          generated_by: GENERATED_BY,
          review_status: "pending",
          parent: p.targetId,
        },
      });
    }
    saveTeams(teams);
    pending.delete(newId);
    deletePending(newId);

    ctx.ui.notify(`Wrote agents/${newId}.md and queued in teams.yaml (pending).`, "info");
  }
}
