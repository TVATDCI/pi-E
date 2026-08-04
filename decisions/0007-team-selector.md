# B — `/team` YAML Schema + Roster Selector

## Binding constraints visible

- **Thick-primary, not stripped-primary.** Our primary keeps its full toolset. `/team` is a **roster filter** on dispatch, not a replacement of the primary. Disler's `agent-team.ts` strips the primary to `dispatch_agent`-only; we explicitly reject that.
- **Tier-map precedence.** Model resolution stays `persona.model ?? TIERS[category]`. The roster may suggest a default category per member, but the caller's `category` parameter and the tier-map are authoritative.
- **Co-designed with `pi-pi`.** The roster schema includes provenance fields so generated agents can land in the roster with a clear review status.

## What `/team` gives us

`/team` is the **roster selector** primitive. It answers:

- "Which personas are dispatchable right now?"
- "What team is active?"
- "Is this generated persona approved yet?"

It does **not** answer "which model should run?" (that's `tier-map.ts`) or "what task should I do?" (that's the primary). It is a filter, not a router.

## Design decision: `prompt_ref` vs `file_path`

Three alternatives were considered for how a roster member points at its agent definition.

### Alternative 1 — `prompt_ref` (system-prompt block only)

The roster contains the system prompt inline or via a `prompt:` field.

- **Pros:** self-contained; easy for `pi-pi` to generate as a single YAML blob.
- **Cons:** duplicates the existing `.md` agent file format (name, description, tools, optional `model:`). We already have 7 hand-crafted `.md` personas in `~/.pi/agent/agents/`. Maintaining two representations guarantees drift.

### Alternative 2 — `file_path` (full `.pi` agent file)

The roster points to an existing `.md` agent file (e.g. `agents/builder.md`).

- **Pros:** reuses the current format; tools/description/model pin stay in one place; `pi-pi` can simply generate a `.md` file and add a roster entry.
- **Cons:** requires a file on disk; slightly more I/O than inline YAML.

### Alternative 3 — both-with-mapping

Allow both inline `prompt:` and `file:` references, with a precedence rule.

- **Pros:** maximum flexibility.
- **Cons:** complexity and ambiguity; two sources of truth for the same agent.

### Recommendation

**Use `file_path` (Alternative 2).** The agent file is the canonical source of truth; the roster is metadata _about_ dispatchable agents. This is the cleanest fit for our current `agents/*.md` layout and for `pi-pi`'s output format.

## `teams.yaml` schema

```yaml
# ~/.pi/agent/teams.yaml — GLOBAL roster defaults
# Projects may ADD teams or members via .pi/teams.yaml, but cannot REMOVE
# global members from a global team (deny-additive, same policy model as mini-dc).

version: "1.0"

# Default team used when no team is explicitly selected.
default_team: "all"

# Teams are named rosters. The primary selects one via /team <name>.
teams:
  all:
    description: "Every agent available in this workspace"
    members:
      - id: "explore"
        file: "agents/explore.md"
      - id: "oracle"
        file: "agents/oracle.md"
      - id: "librarian"
        file: "agents/librarian.md"
      - id: "builder"
        file: "agents/builder.md"
      - id: "reviewer"
        file: "agents/reviewer.md"
      - id: "archivist"
        file: "agents/archivist.md"
      - id: "momus"
        file: "agents/momus.md"

  review:
    description: "PRD/plan review and code-review team"
    default_category: "deep"
    members:
      - id: "momus"
        file: "agents/momus.md"
        # Optional: override the team's default category for this member.
        category: "ultrabrain"
      - id: "reviewer"
        file: "agents/reviewer.md"
        category: "unspecified-high"
      - id: "oracle"
        file: "agents/oracle.md"
        category: "unspecified-high"

  build:
    description: "Implementation and file-operations team"
    default_category: "deep"
    members:
      - id: "builder"
        file: "agents/builder.md"
        category: "unspecified-high"
      - id: "archivist"
        file: "agents/archivist.md"
        category: "unspecified-high"
      - id: "explore"
        file: "agents/explore.md"
        category: "unspecified-low"

  research:
    description: "Read-only research and docs team"
    default_category: "deep"
    members:
      - id: "explore"
        file: "agents/explore.md"
      - id: "librarian"
        file: "agents/librarian.md"
      - id: "oracle"
        file: "agents/oracle.md"
        category: "ultrabrain"

  # Example of a team that will later be populated by pi-pi.
  generated-reviewers:
    description: "Generated variants of the review team (pending approval)"
    default_category: "deep"
    members:
      - id: "momus-v2"
        file: "agents/momus-v2.md"
        category: "ultrabrain"
        provenance:
          source: "generated"
          generated_by: "pi-pi@v1"
          review_status: "pending"
          parent: "momus"
```

## Member schema (per entry)

| Field                      | Type   | Required | Description                                                                                                                                                                                    |
| -------------------------- | ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | string | yes      | Identifier used in `dispatch({ agent: "id" })`. Must match the agent file's `name:` frontmatter (case-insensitive).                                                                            |
| `file`                     | string | yes      | Path to the `.md` agent file, relative to `~/.pi/agent/` or the project `.pi/` directory.                                                                                                      |
| `category`                 | string | no       | Override the team's default category for this member. If omitted, the team's `default_category` is used. If the team has no default, the caller must pass `category` explicitly to `dispatch`. |
| `availability`             | string | no       | `"available" \| "experimental" \| "deprecated"`. Default `"available"`.                                                                                                                        |
| `provenance.source`        | string | no       | `"handcrafted" \| "generated"`. Default `"handcrafted"`.                                                                                                                                       |
| `provenance.generated_by`  | string | null     | e.g. `"pi-pi@v1"`. Required when `source: "generated"`.                                                                                                                                        |
| `provenance.review_status` | string | no       | `"approved" \| "pending" \| "stale"`. Default `"approved"` for handcrafted, `"pending"` for generated.                                                                                         |
| `provenance.parent`        | string | null     | The parent agent id this one was derived from.                                                                                                                                                 |

## Provenance semantics

- **Generated-but-pending agents must trigger a warning.** When `dispatch` is called with `agent: "momus-v2"` and `review_status: "pending"`, the primary should warn the operator: "`momus-v2` is a generated agent pending review (generated by pi-pi@v1)." The dispatch still proceeds, but the operator is aware of the risk.
- **Stale agents** should be re-run through the review harness before use.
- **Approved generated agents** behave like handcrafted agents.

## Selector UX: `/team` command

### Alternative 1 — command only

`/team <name>` switches the active team. `dispatch` then only accepts agents in that team.

- **Pros:** simple, explicit, matches muscle memory of other `/` commands.
- **Cons:** the primary must remember to switch teams; a misfire dispatches to the wrong team.

### Alternative 2 — filter only

`dispatch` accepts an optional `team` parameter and validates the agent is in that team.

- **Pros:** self-contained per dispatch; no global state.
- **Cons:** every dispatch call must specify the team; more verbose.

### Alternative 3 — command + filter

`/team <name>` sets the active team (displayed in status/footer), and `dispatch` also accepts an optional `team` parameter that overrides the active team.

- **Pros:** best of both — default team for routine work, explicit override when needed.
- **Cons:** slightly more state.

### Recommendation

**Alternative 3 — command + filter.** It is the most flexible and matches the existing pattern (e.g., `/dc-mode` sets extension state, while individual tool calls can still carry parameters).

## `/team` command surface

- `/team` — list available teams and the active team.
- `/team <name>` — switch active team.
- `/team-list` — list members of the active team with provenance status.

## Integration with the existing `dispatch` tool

Current signature (`orchestration-engine/index.ts:212-221`):

```ts
parameters: Type.Object({
  task: Type.String({ description: "The complete, self-contained sub-task" }),
  category: CategoryEnum,
  agent: Type.Optional(Type.String({ description: "Named persona from ~/.pi/agent/agents/ (e.g. explore, builder)" })),
  cwd: Type.Optional(Type.String({ ... })),
}),
```

Make `category` optional and add the `team` optional field:

```ts
category: Type.Optional(CategoryEnum),  // was required
team: Type.Optional(Type.String({
  description: "Team name from teams.yaml. If omitted, uses the active team set via /team. Validates that agent is a member."
})),
```

### Execution flow

1. Load the roster file(s) on `session_start` (global + project, deny-additive).
2. Resolve the active team:
   - `params.team` if provided.
   - Otherwise the active team from extension state (set by `/team`).
   - Otherwise `default_team` from `teams.yaml`.
3. If `params.agent` is provided, verify it is in the resolved team. If not, return an error listing the team members.
4. Resolve the category (new precedence):
   - `params.category` if provided.
   - Otherwise the member's `category` from the roster.
   - Otherwise the team's `default_category`.
   - Otherwise error: "dispatch requires a category or a team/member default_category."
5. If `params.agent` is omitted, the primary may still call `dispatch` with only a `category`. This is unchanged — `/team` filters named agents, not category-only dispatches.
6. Load the agent file via `file:` path and proceed with existing model resolution: `persona.model ?? TIERS[category]`.

### Why make category optional

Today `category` is required in `dispatch`, but a team is only meaningful if selecting it implies a category context. With the new precedence, calling `dispatch({ agent: "momus", team: "review" })` resolves to `ultrabrain` from the roster, while `dispatch({ category: "quick", agent: "builder" })` still explicitly overrides the roster. This keeps the caller in control while letting teams carry default cost context.

## Provenance warning

After resolving the agent, if `provenance.review_status === "pending"`, call `ctx.ui.notify("⚠ Generated agent ... is pending review", "warning")` and log a `dispatch-log` entry with `generatedReviewStatus: "pending"`.

## Merge policy

- Global `teams.yaml` lives at `~/.pi/agent/teams.yaml`.
- Project `teams.yaml` lives at `.pi/teams.yaml`.
- Merge is **deny-additive** for members: a project can add teams and add members to global teams, but cannot remove a global member from a global team.
- Teams defined in the project file with the same name as a global team are **merged** (members appended), not replaced.
- Teams defined only in the project file are added to the roster.

This mirrors the `mini-damage-control.ts` merge policy and keeps our safety model consistent.

## Worked example: `review` team

```yaml
teams:
  review:
    description: "PRD/plan review and code-review team"
    default_category: "deep"
    members:
      - id: "momus"
        file: "agents/momus.md"
        category: "ultrabrain"
      - id: "reviewer"
        file: "agents/reviewer.md"
        category: "unspecified-high"
      - id: "oracle"
        file: "agents/oracle.md"
        category: "unspecified-high"
```

Operator usage:

```
/team review

# Now dispatch knows only momus / reviewer / oracle are available.
dispatch({
  category: "ultrabrain",
  agent: "momus",
  task: "Review this PRD for logical contradictions and scope creep."
})
```

If the operator tries `dispatch({ agent: "builder" })` while the active team is `review`, the tool returns an error: "`builder` is not in the active team `review`. Available: momus, reviewer, oracle."

## Co-design with `pi-pi`

The `generated_by` and `review_status` fields make the roster the natural landing zone for `pi-pi` output. When `pi-pi` generates a new agent, it should:

1. Write the agent file to `agents/<generated-id>.md`.
2. Add a roster entry to the appropriate team (e.g., `generated-reviewers`) with `source: "generated"`, `review_status: "pending"`, and `parent` pointing to the original.
3. The review harness (generate → momus-review → A/B diff vs handcrafted → human approve) updates `review_status` to `"approved"`.

## Non-goals

- **Stripped-primary / dispatcher-only posture.** Not ported from disler.
- **Specialist-routing replacing category routing.** The roster never overrides the tier-map.
- **Persistent per-specialist sessions.** That is step 5; `/team` is stateless.
- **Background sub-agents.** `/team` already enables blocking parallel dispatch in one turn via multiple `dispatch` calls. `/sub` remains step 8.

## Open questions

1. Should we allow a team to override the `model:` pin in an agent file? Recommendation: **no** — keep the agent file as the source of truth for model pin.
2. Should the active team persist across Pi sessions? Recommendation: **no** — start each session with `default_team`. Explicit `/team` is cheap and avoids stale state.
3. Where is the project `teams.yaml` loaded from? `.pi/teams.yaml` relative to `ctx.cwd`, consistent with `.pi/mini-dc-rules.yaml`.

## Validation plan

1. Load `teams.yaml` and verify all `file:` paths resolve to existing `.md` files.
2. Verify `/team review` restricts `dispatch` to the 3 members.
3. Verify a generated-pending agent triggers a warning but still dispatches.
4. Verify category resolution precedence:
   - `dispatch({ agent: "momus", team: "review" })` resolves to `ultrabrain` (member category).
   - `dispatch({ agent: "explore", team: "research" })` resolves to `deep` (team default_category).
   - `dispatch({ category: "quick", agent: "builder" })` resolves to `quick` (caller override).
5. Verify tier-map precedence: `dispatch({ category: "quick", agent: "builder" })` still routes to `glm-4.5-air` even if the team `default_category` is `deep`.

   > **_[Footnote 2026-08-04 — `quick` model in this verification step is superseded.]_** `quick` no longer routes to `glm-4.5-air`; per current `tier-map.ts` it routes to **`opencode/deepseek-v4-flash-free`** (FREE, moved off the Z-AI plan 2026-08-04). The tier-map *precedence* claim this step verifies (caller `category` override beats team `default_category`) is unchanged and still the point of the check — only the expected model string is stale. Update the assertion to `opencode/deepseek-v4-flash-free` when re-running this verification.
