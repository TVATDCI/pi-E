// Lesson 0006+0008: orchestration-engine/index.ts — L3 dispatch + persona layer.
// Consumes tier-map.ts (L2). Personas from ~/.pi/agent/agents/*.md.
// Grounded in examples/extensions/subagent/ + disler/pi-vs-claude-code (LR-0007/0008).

import { SessionManager, parseSessionEntries, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import { parse as yamlParse } from "yaml";
import { isPeakHours, isPromoActive, TIERS, type TaskCategory } from "./tier-map.ts";
import { aggregateDispatchLog, quotaMarker, type DispatchLogEntry } from "./routing-stats.ts";
import { resolveAndSpawn, sessionKey } from "./spawn.ts";
import { resolveFunctionalAgent } from "./agent-map.ts";

// 0b: per-{agent, project} Promise mutex. Corrected delete-only-if-tail pattern
// (Oracle Q2): only the tail holder deletes the map entry → no delete-after-clobber.
// In-process only (known limitation #4).
const sessionMutexes = new Map<string, Promise<void>>();

async function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionMutexes.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const stored = prev.then(() => next);
  sessionMutexes.set(key, stored);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (sessionMutexes.get(key) === stored) sessionMutexes.delete(key);
  }
}

interface SubState {
  id: number;
  category: TaskCategory;
  status: "running" | "done" | "error";
  task: string;
  modelFlag: string;
  thinkingLevel?: string;
  rationale: string;
  persona?: string;
  chunks: string[];
  toolCount: number;
  elapsed: number;
  startedAt: number;
}

// Team / roster data
interface Provenance {
  source: "handcrafted" | "generated";
  generated_by: string | null;
  review_status: "approved" | "pending" | "stale";
  parent: string | null;
}

interface TeamMember {
  id: string;
  file: string;
  category?: TaskCategory;
  availability?: "available" | "experimental" | "deprecated";
  provenance: Provenance;
}

interface Team {
  description: string;
  default_category?: TaskCategory;
  members: TeamMember[];
}

interface TeamsFile {
  version?: string;
  default_team?: string;
  teams: Record<string, Team>;
}

const GLOBAL_TEAMS_PATH = join(os.homedir(), ".pi", "agent", "teams.yaml");

function loadTeamsLayer(filepath: string): TeamsFile | null {
  if (!existsSync(filepath)) return null;
  try {
    const raw = yamlParse(readFileSync(filepath, "utf-8")) as Partial<TeamsFile> | null;
    if (!raw) return null;
    return {
      version: raw.version ?? "1.0",
      default_team: raw.default_team,
      teams: raw.teams ?? {},
    };
  } catch {
    return null;
  }
}

function mergeTeams(global: TeamsFile | null, project: TeamsFile | null): TeamsFile {
  const g = global ?? { teams: {} };
  const p = project ?? { teams: {} };
  const merged: Record<string, Team> = {};
  for (const [name, team] of Object.entries(g.teams)) {
    merged[name] = team;
  }
  for (const [name, team] of Object.entries(p.teams)) {
    if (merged[name]) {
      // Deny-additive: append project members; cannot remove global members.
      const seen = new Set(merged[name].members.map((m) => m.id.toLowerCase()));
      for (const member of team.members) {
        if (!seen.has(member.id.toLowerCase())) {
          merged[name].members.push(member);
          seen.add(member.id.toLowerCase());
        }
      }
      if (team.default_category) merged[name].default_category = team.default_category;
      if (team.description) merged[name].description = team.description;
    } else {
      merged[name] = team;
    }
  }
  return {
    version: p.version ?? g.version ?? "1.0",
    default_team: p.default_team ?? g.default_team,
    teams: merged,
  };
}

function normalizeMember(member: Record<string, unknown>): TeamMember {
  const prov = (member.provenance ?? {}) as Record<string, unknown>;
  const source = prov.source === "generated" ? "generated" : "handcrafted";
  return {
    id: String(member.id ?? ""),
    file: String(member.file ?? ""),
    category: member.category as TaskCategory | undefined,
    availability: (member.availability as TeamMember["availability"]) ?? "available",
    provenance: {
      source,
      generated_by: prov.generated_by ? String(prov.generated_by) : null,
      review_status: (prov.review_status as Provenance["review_status"]) ?? (source === "generated" ? "pending" : "approved"),
      parent: prov.parent ? String(prov.parent) : null,
    },
  };
}

function normalizeTeamsFile(raw: TeamsFile): TeamsFile {
  const teams: Record<string, Team> = {};
  for (const [name, team] of Object.entries(raw.teams ?? {})) {
    const members: TeamMember[] = [];
    for (const m of team.members ?? []) {
      members.push(normalizeMember(m as unknown as Record<string, unknown>));
    }
    teams[name] = {
      description: team.description ?? "",
      default_category: team.default_category,
      members,
    };
  }
  return {
    version: raw.version,
    default_team: raw.default_team,
    teams,
  };
}

const CategoryEnum = Type.Union([
  Type.Literal("quick"), Type.Literal("unspecified-low"), Type.Literal("unspecified-high"),
  Type.Literal("deep"), Type.Literal("ultrabrain"), Type.Literal("writing"),
  Type.Literal("visual-engineering"), Type.Literal("artistry"), Type.Literal("research"), Type.Literal("git-commit-message"),
]);

export default function (pi: ExtensionAPI) {
  const subs = new Map<number, SubState>();
  let nextId = 1;
  let widgetCtx: ExtensionContext | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  let teams: TeamsFile = { teams: {} };
  let activeTeamName = "";

  const loadTeams = (ctx: ExtensionContext) => {
    const globalTeams = loadTeamsLayer(GLOBAL_TEAMS_PATH);
    const projectPath = join(ctx.cwd, ".pi", "teams.yaml");
    const projectTeams = loadTeamsLayer(projectPath);
    const merged = mergeTeams(globalTeams, projectTeams);
    teams = normalizeTeamsFile(merged);
    if (!activeTeamName || !teams.teams[activeTeamName]) {
      activeTeamName = teams.default_team ?? "";
    }
    if (activeTeamName && !teams.teams[activeTeamName]) {
      activeTeamName = Object.keys(teams.teams)[0] ?? "";
    }
  };

  const resolveTeam = (teamName?: string): Team | null => {
    const name = teamName?.trim() || activeTeamName;
    return teams.teams[name] ?? null;
  };

  const resolveMember = (team: Team | null, agentId: string): TeamMember | null => {
    if (!team) return null;
    const id = agentId.toLowerCase();
    return team.members.find((m) => m.id.toLowerCase() === id) ?? null;
  };

  const render = () => {
    if (!widgetCtx?.hasUI) return;
    widgetCtx.ui.setWidget("orchestrator", (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        if (subs.size === 0) return [theme.fg("muted", "orchestrator: idle")];
        const rows: string[] = [];
        for (const s of subs.values()) {
          const color = s.status === "running" ? "accent" : s.status === "done" ? "success" : "error";
          const icon = s.status === "running" ? "●" : s.status === "done" ? "✓" : "✗";
          const tag = s.persona ? `:${s.persona}` : "";
          rows.push(truncateToWidth(
            theme.fg(color, `${icon} #${s.id} [${s.category}]${tag}`) +
            theme.fg("dim", ` ${s.modelFlag} · ${s.thinkingLevel ?? "off"} · ${Math.round(s.elapsed / 1000)}s · tools:${s.toolCount}`),
            width,
          ));
          rows.push(truncateToWidth(theme.fg("muted", `  ${s.task.slice(0, Math.max(0, width - 4))}`), width));
        }
        return rows;
      },
    }));
  };

  const startTick = () => {
    if (tick) return;
    tick = setInterval(() => {
      for (const s of subs.values()) if (s.status === "running") s.elapsed = Date.now() - s.startedAt;
      render();
    }, 1000);
  };
  const stopTickIfIdle = () => {
    if (tick && ![...subs.values()].some((s) => s.status === "running")) { clearInterval(tick); tick = undefined; }
  };

  pi.on("session_start", async (_e, ctx) => {
    widgetCtx = ctx;
    loadTeams(ctx);
    if (activeTeamName) ctx.ui.setStatus("team", `team: ${activeTeamName}`);
    render();
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n## Cost Discipline\n" +
        "Delegate grunt work to dispatch(category) — cheaper sub-agents do the work, you synthesize results. " +
        "Codebase search, implementation, investigation, writing, UI work — all have dedicated operatives. " +
        "Reserve your tokens for decisions and synthesis. The cheapest model that does the job is the right model.",
    };
  });

  pi.registerTool({
    name: "dispatch",
    label: "Dispatch",
    description:
      "Delegate a sub-task to an isolated sub-agent. BLOCKS until finished. " +
      "Pick the category that matches the task's weight — this chooses the model via tier-map AND auto-resolves a functional agent (Matrix operative). " +
      "When agent is omitted AND no team is specified, the category's default operative is used: " +
      "quick→keymaker, unspecified→trinity, deep→morpheus, ultrabrain→neo, writing→mouse, visual-engineering/artistry→architect, research→researcher, git-commit-message→seraph. " +
      "Explicit agent= overrides the default (e.g. agent='momus' for a PRD gate, agent='oracle' for architecture reasoning). " +
      "Categories (tier-map.ts is authoritative): quick (glm-4.5-air), unspecified-low (glm-4.7), unspecified-high (glm-5-turbo), " +
      "deep (glm-5.1), ultrabrain (opencode-go/kimi-k3), writing (glm-4.7), visual-engineering (glm-5-turbo), artistry (glm-5.1), research (glm-4.7), git-commit-message (deepseek-v4-flash-free/FREE). " +
      "0 of 14 agents pin a model — category is the sole model authority. " +
      "One focused objective per dispatch.",
    parameters: Type.Object({
      task: Type.String({ description: "The complete, self-contained sub-task" }),
      category: Type.Optional(CategoryEnum),
      agent: Type.Optional(Type.String({ description: "Named agent from ~/.pi/agent/agents/ (e.g. momus, keymaker, morpheus, neo). If omitted and no team specified, the category's default operative is used." })),
      team: Type.Optional(Type.String({ description: "Team name from teams.yaml. Uses active team if omitted." })),
      cwd: Type.Optional(Type.String({
        description: "Working directory for the sub-agent. Defaults to the parent's cwd. " +
          "Set this when dispatching into a specific project so the child loads that project's " +
          "mini-damage-control rules (.pi/mini-dc-rules.yaml) instead of the parent's. " +
          "Both read-only and gated-bash personas honor this.",
      })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      widgetCtx = ctx;

      // Resolve team + member.
      const team = resolveTeam(params.team);
      if (params.team && !team) {
        return {
          content: [{ type: "text" as const, text: `Error: team '${params.team}' not found. Available: ${Object.keys(teams.teams).join(", ")}` }],
          details: { error: "team-not-found" },
        };
      }
      const member = params.agent && team ? resolveMember(team, params.agent) : null;
      if (params.agent && team && !member) {
        const available = team.members.map((m) => m.id).join(", ");
        return {
          content: [{ type: "text" as const, text: `Error: agent '${params.agent}' is not in team '${params.team || activeTeamName}'. Available: ${available}` }],
          details: { error: "agent-not-in-team", available: team.members.map((m) => m.id) },
        };
      }
      if (member && member.provenance.review_status === "pending") {
        const warn = `⚠ Generated agent '${member.id}' is pending review (generated by ${member.provenance.generated_by ?? "unknown"}).`;
        if (ctx.hasUI) ctx.ui.notify(warn, "warning");
      }

      // Resolve category precedence: caller > member > team default > error.
      let category: TaskCategory | undefined = params.category;
      if (!category && params.agent && team) {
        category = member?.category ?? team.default_category;
      }
      if (!category && team) {
        category = team.default_category;
      }
      if (!category) {
        return {
          content: [{ type: "text" as const, text: "Error: dispatch requires a category (or a team/member default_category)." }],
          details: { error: "category-missing" },
        };
      }

      // 2b: functional-agent default. Fires ONLY when the caller omitted BOTH agent
      // and team — explicit agent always wins (KEY INVARIANT). tier-map still picks
      // the model; the functional agent supplies system prompt + tools.
      let agentName: string | undefined = params.agent;
      let agentSource: string | undefined;
      if (!params.agent && !params.team) {
        agentName = resolveFunctionalAgent(category);
        agentSource = "functional-agent";
      }

      const id = nextId++;
      const sub: SubState = {
        id, category, status: "running", task: params.task,
        modelFlag: "", thinkingLevel: undefined, rationale: "", persona: agentName,
        chunks: [], toolCount: 0, elapsed: 0, startedAt: Date.now(),
      };
      subs.set(id, sub); render(); startTick();

      // 0b: serialize same-{agent, project} dispatches — one writer per session file.
      const lockKey = sessionKey(agentName, params.cwd ?? ctx.cwd);
      const result = await withSessionLock(lockKey, () => resolveAndSpawn(
        pi, params.task, category, agentName, params.cwd, ctx,
        ({ chunk, toolCount }) => {
          sub.chunks.push(chunk);
          sub.toolCount = toolCount;
          render();
        },
        signal,
        agentSource,
      ));

      sub.status = result.code === 0 ? "done" : "error";
      sub.elapsed = result.elapsedMs;
      sub.modelFlag = result.modelFlag;
      sub.thinkingLevel = result.thinkingLevel;
      sub.rationale = result.rationale;
      sub.toolCount = result.toolCount;
      render(); stopTickIfIdle();

      const tag = agentName ? ` (${agentName})` : "";
      const dsTag = result.downshiftedFrom ? ` [downshifted from ${result.downshiftedFrom}]` : "";
      const trimmed = result.output.length > 6000 ? result.output.slice(0, 6000) + "\n...[truncated]" : result.output;
      return {
        content: [{ type: "text" as const, text: `[${category} → ${result.modelFlag} @${result.thinkingLevel ?? "off"}]${tag}${dsTag} sub-agent ${result.code === 0 ? "done" : "failed"}:\n\n${trimmed}` }],
        details: { category, modelFlag: result.modelFlag, code: result.code, persona: agentName ?? null, downshifted: !!result.downshiftedFrom },
      };
    },
  });

  pi.registerCommand("team", {
    description: "Select active team: /team [name]",
    handler: async (args, ctx) => {
      widgetCtx = ctx;
      const requested = args.trim();
      if (!requested) {
        const active = activeTeamName ? `${activeTeamName}` : "(none)";
        const list = Object.keys(teams.teams).join(", ") || "(no teams loaded)";
        ctx.ui.notify(`Active team: ${active}\nAvailable: ${list}`, "info");
        return;
      }
      if (!teams.teams[requested]) {
        ctx.ui.notify(`Team '${requested}' not found. Available: ${Object.keys(teams.teams).join(", ")}`, "warning");
        return;
      }
      activeTeamName = requested;
      const members = teams.teams[requested].members.map((m) => m.id).join(", ");
      ctx.ui.setStatus("team", `team: ${requested}`);
      ctx.ui.notify(`Team: ${requested}\nMembers: ${members}`, "info");
    },
  });

  pi.registerCommand("team-list", {
    description: "List members of the active team",
    handler: async (_args, ctx) => {
      widgetCtx = ctx;
      const team = teams.teams[activeTeamName];
      if (!team) {
        ctx.ui.notify("No active team", "warning");
        return;
      }
      const lines = team.members.map((m) => {
        const prov = m.provenance.source === "generated"
          ? ` [generated:${m.provenance.review_status}]`
          : "";
        return `${m.id}${m.category ? ` (${m.category})` : ""}${prov}`;
      });
      ctx.ui.notify(`Team: ${activeTeamName}\n${lines.join("\n")}`, "info");
    },
  });

  // /routing-stats (Decision 0004 / F6): read-only aggregation of the dispatch-log
  // into category/model/agent/source views + dumb-threshold flags. Turns the
  // write-only log into the model-tuning + footgun-detection loop.
  pi.registerCommand("routing-stats", {
    description: "Routing observability (F6): aggregate dispatch-log across ALL sessions for this project (cwd-scoped) — category/model/agent/source views + flags",
    handler: async (_args, ctx) => {
      // Cross-session (cwd-scoped): aggregate dispatch-log entries from every
      // session in the current working directory, not just this one. Session-
      // scope (v1) was too sparse — see Decision 0004 ("cross-session").
      const entries: DispatchLogEntry[] = [];
      const driftHashes: string[] = [];
      let sessionCount = 0;
      try {
        const sessions = await SessionManager.list(ctx.cwd);
        sessionCount = sessions.length;
        for (const s of sessions) {
          try {
            const parsed = parseSessionEntries(readFileSync(s.path, "utf-8")) as Array<{
              type?: string;
              customType?: string;
              data?: unknown;
            }>;
            for (const e of parsed) {
              if (e.type === "custom" && e.customType === "dispatch-log") {
                entries.push((e.data ?? {}) as DispatchLogEntry);
              } else if (e.type === "custom" && e.customType === "prompt-composition") {
                const d = (e.data ?? {}) as { drift?: boolean; hash?: string };
                if (d.drift && d.hash) driftHashes.push(d.hash);
              }
            }
          } catch {
            /* skip unreadable/corrupt session file */
          }
        }
      } catch {
        // SessionManager.list unavailable — fall back to the current session only.
        sessionCount = 1;
        for (const e of ctx.sessionManager.getEntries()) {
          if (e.type === "custom" && e.customType === "dispatch-log") {
            entries.push((e.data ?? {}) as DispatchLogEntry);
          } else if (e.type === "custom" && e.customType === "prompt-composition") {
            const d = (e.data ?? {}) as { drift?: boolean; hash?: string };
            if (d.drift && d.hash) driftHashes.push(d.hash);
          }
        }
      }
      const stats = aggregateDispatchLog(entries, { peak: isPeakHours(), promo: isPromoActive() });
      const scope = `${sessionCount} session${sessionCount === 1 ? "" : "s"} scanned (cwd-scoped)`;
      // D1 observer (partial-revert v1.3): surface prompt-composition drift hashes.
      const uniqueDrift = [...new Set(driftHashes)];
      const driftSection = uniqueDrift.length > 0
        ? `\n\n▌ prompt drift (${uniqueDrift.length} unknown hash${uniqueDrift.length === 1 ? "" : "es"}) — composed prompt changed:\n` +
          uniqueDrift.map((h) => `  ⚠ ${h}`).join("\n") +
          `\n  intended? add to KNOWN_GOOD_HASHES in extensions/lib/prompt-hash.ts; otherwise investigate.`
        : "";
      const table = stats.lines.join("\n") + driftSection + `\n\n(${scope})`;
      const totalFlags = stats.flags.length + uniqueDrift.length;
      const headline =
        stats.n === 0 && uniqueDrift.length === 0
          ? `no dispatch-log or prompt-drift entries across ${sessionCount} session${sessionCount === 1 ? "" : "s"}`
          : `${stats.n} dispatches · ${stats.fails} errors · ${totalFlags} flag${totalFlags === 1 ? "" : "s"}${uniqueDrift.length > 0 ? ` (incl. ${uniqueDrift.length} prompt-drift)` : ""} · ${scope}`;
      if (ctx.hasUI) {
        ctx.ui.notify(headline, "info");
        await ctx.ui.editor("/routing-stats", table);
      } else {
        console.log(table);
      }
    },
  });

  // /tiers (Decision 0005 / F4): the operator's setup/testing tool — the 9 dispatch
  // categories × model / thinking / quota× / REAL availability (key configured).
  // Run before switching models so you know what actually has a key.
  pi.registerCommand("tiers", {
    description: "Setup tool (F4): the 10 dispatch categories × model / thinking / quota× / REAL availability (key configured)",
    handler: async (_args, ctx) => {
      const available = ctx.modelRegistry.getAvailable();
      const isAvail = (mf: string) => {
        const sep = mf.indexOf("/");
        return available.some((m) => m.provider === mf.slice(0, sep) && m.id === mf.slice(sep + 1));
      };
      const peak = isPeakHours();
      const promo = isPromoActive();
      const pad = (s: unknown, w: number) => {
        const t = String(s ?? "");
        return (t.length > w ? t.slice(0, Math.max(1, w - 1)) + "…" : t).padEnd(w);
      };
      const lines = [
        `/tiers · 10 categories · availability = key configured (getAvailable)`,
        `peak=${peak} · promo=${promo}`,
        "",
        pad("category", 20) + pad("model", 26) + pad("think", 7) + pad("quota", 6) + "avail",
      ];
      for (const [cat, entry] of Object.entries(TIERS)) {
        const mf = `${entry.provider}/${entry.id}`;
        const av = isAvail(mf) ? "✓ yes" : "✗ NO KEY";
        lines.push(pad(cat, 20) + pad(mf, 26) + pad(entry.thinkingLevel ?? "off", 7) + pad(quotaMarker(mf, peak, promo), 6) + av);
      }
      const table = lines.join("\n");
      if (ctx.hasUI) {
        ctx.ui.notify("10 categories + real availability", "info");
        await ctx.ui.editor("/tiers", table);
      } else {
        console.log(table);
      }
    },
  });
}
