# C — `/chain` Primitive + `git-commit-message` Migration Plan

## Binding constraints visible

- **Dogfood on `git-commit-message`.** The existing skill is already a hand-coded 3-step pipeline (bootstrap → delegate draft → review → commit). We migrate the reusable multi-agent part into `/chain`, or we don't build `/chain`.
- **Tier-map precedence.** Each chain step explicitly declares a `category`. Model resolution remains `persona.model ?? TIERS[category]`. Disler's `agent-chain.ts` uses the primary's model for every step; we preserve our category-based cost routing.
- **No stripped-primary.** The primary keeps full tools. The chain is one tool among many; the skill orchestrates it.

## What `/chain` gives us

`/chain` is a **sequential pipeline** primitive. It expresses multi-agent workflows as YAML, with `$INPUT` carrying the previous step's output and `$ORIGINAL` carrying the user's initial prompt. It turns the ad-hoc chains inside skills (like `git-commit-message`) into reusable, reviewable, shareable artifacts.

## `agent-chain.yaml` schema

```yaml
# ~/.pi/agent/agent-chain.yaml — global chain definitions
# Projects may ADD chains via .pi/agent-chain.yaml (deny-additive, same policy as teams/mini-dc).

version: "1.0"

chains:
  commit-message:
    description: "Cost-efficient commit message pipeline (draft → review)"
    # Default category for steps that don't specify one.
    default_category: "unspecified-low"
    steps:
      - name: "draft"
        agent: "builder"
        category: "git-commit-message"
        prompt: |
          Run `git diff --cached`, then draft a conventional commit message
          following the format below. Return ONLY the message text.

          Staged changes context: $ORIGINAL
      - name: "review"
        agent: "reviewer"
        category: "unspecified-low"
        prompt: |
          Review the commit message below for factual accuracy against the
          staged changes summary. Return either the corrected message or the
          word "PASS" if it is accurate.

          Commit message to review:
          $INPUT

          Original request: $ORIGINAL

  plan-build-review:
    description: "Plan, implement, and review — standard development cycle"
    default_category: "deep"
    steps:
      - name: "explore"
        agent: "explore"
        category: "unspecified-low"
        prompt: "Explore the codebase and report what is relevant to: $ORIGINAL"
      - name: "plan"
        agent: "oracle"
        category: "ultrabrain"
        prompt: "Based on this analysis, create a concise implementation plan:\n\n$INPUT"
      - name: "build"
        agent: "builder"
        category: "unspecified-high"
        prompt: "Implement this plan:\n\n$INPUT"
      - name: "review"
        agent: "reviewer"
        category: "unspecified-high"
        prompt: "Review this implementation for correctness, security, and style:\n\n$INPUT"

  scout-twice:
    description: "Explore, then cross-check the exploration"
    default_category: "unspecified-low"
    steps:
      - name: "scout"
        agent: "explore"
        prompt: "Explore the codebase and investigate: $ORIGINAL\n\nReport findings with file paths and line numbers."
      - name: "verify"
        agent: "explore"
        prompt: "Cross-check the following analysis for anything missed or incorrect. Original request: $ORIGINAL\n\nAnalysis:\n$INPUT"
```

## Step schema

| Field       | Type   | Required | Description                                                                                                  |
| ----------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------ |
| `name`      | string | yes      | Display name for the step (used in widget/logs).                                                             |
| `agent`     | string | yes      | The agent id from the roster. Must be dispatchable in the current team.                                      |
| `category`  | string | no       | Overrides `chain.default_category` for this step. If neither is set, the caller must provide one at runtime. |
| `prompt`    | string | yes      | Template supporting `$INPUT` (previous step output) and `$ORIGINAL` (initial user prompt).                   |
| `condition` | string | no       | Future: `"$INPUT.length > 0"` to skip steps. Out of scope for v1.                                            |
| `tool`      | string | no       | Reserved for future primary-only steps. Out of scope for v1.                                                 |

## Variable substitution

- `$INPUT` — replaced with the previous step's output. For the first step, it is the user's initial prompt passed to the `run_chain` call.
- `$ORIGINAL` — always the user's initial prompt passed to `run_chain`.

This matches disler's `agent-chain.ts` behavior (`agent-chain.ts:470-471`) while adding explicit category support.

## `/chain` command and tool surface

- `/chain` — list available chains and switch active chain.
- `/chain-list` — show all chains with their steps.
- `run_chain({ task, chain? })` — execute the chain. If `chain` is omitted, uses the active chain.

```ts
pi.registerTool({
  name: "run_chain",
  label: "Run Chain",
  description:
    "Execute a sequential agent pipeline. Each step dispatches to an agent; output flows via $INPUT to the next step.",
  parameters: Type.Object({
    task: Type.String({ description: "The initial task/prompt for the chain" }),
    chain: Type.Optional(
      Type.String({
        description:
          "Chain name from agent-chain.yaml. Uses active chain if omitted.",
      }),
    ),
  }),
  async execute(_id, params, _signal, _onUpdate, ctx) {
    const chainName = params.chain ?? activeChainName;
    const chain = chains.get(chainName);
    if (!chain) return error("chain not found");

    let input = params.task;
    const original = params.task;
    const results: StepResult[] = [];

    for (const step of chain.steps) {
      const prompt = step.prompt
        .replace(/\$INPUT/g, input)
        .replace(/\$ORIGINAL/g, original);

      // Resolve the category for this step.
      const category =
        step.category ?? chain.default_category ?? "unspecified-low";

      // Reuse the shared spawn core. DO NOT call dispatch.execute() directly —
      // registered tools are not directly callable inside extensions. Instead,
      // extract a helper `resolveAndSpawn(task, category, agent, cwd, ctx)` from
      // `orchestration-engine/index.ts` that both the `dispatch` tool and `run_chain`
      // call. The helper performs: loadPersona → resolveModel → F4 availability → spawnSub.
      const result = await resolveAndSpawn(
        prompt,
        category,
        step.agent,
        ctx.cwd,
        ctx,
      );

      if (result.code !== 0) {
        return error(`step ${step.name} failed: ${result.output}`);
      }
      results.push({ name: step.name, output: result.output });
      input = result.output;
    }

    return {
      content: [{ type: "text", text: input }],
      details: { chain: chainName, results },
    };
  },
});
```

## Widget

A simple widget shows the active chain's step states (pending → running → done/error). This is similar to disler's `agent-chain.ts` widget but lighter. We can reuse the existing `orchestration-engine` widget patterns.

## Migration plan: `git-commit-message` → `/chain`

### Current state of the skill

`~/.config/opencode/skills/05-development/git-commit-message/SKILL.md` (lines 35–71) defines the pipeline:

1. **Step 0 — Bootstrap (primary):** `git rev-parse --is-inside-work-tree`, `git diff --cached --name-only`, stage files if needed.
2. **Step 1 — Delegate draft (dispatch):** `dispatch({ category: "git-commit-message", agent: "builder", task: "Run git diff --cached, draft a conventional commit message..." })`
3. **Step 2 — Review (primary):** `git diff --cached --stat`, verify factual claims, format, scope.
4. **Step 3 — Commit (primary):** `git commit -F -` (gated-bash ASK fires in primary UI).

### Constraint: final commit cannot be a chain step

The skill notes (line 56): the child must NOT run `git commit` because the gated-bash ASK dialog deadlocks in the headless subprocess. Therefore **Step 3 must remain in the primary**. `/chain` covers Steps 1–2, the skill orchestrates the primary-only bookends.

### Migration: new chain definition

Add to `~/.pi/agent/agent-chain.yaml`:

```yaml
chains:
  commit-message:
    description: "Cost-efficient commit message pipeline (draft → review)"
    default_category: "unspecified-low"
    steps:
      - name: "draft"
        agent: "builder"
        category: "git-commit-message"
        prompt: |
          Run `git diff --cached`, then draft a conventional commit message
          following this format:

          <type>(<scope>): <short description>

          <body explaining what and why>

          Return ONLY the message text. Do not run `git commit`.

          Context: $ORIGINAL
      - name: "review"
        agent: "reviewer"
        category: "unspecified-low"
        prompt: |
          Review the commit message below. Check:
          - Subject ≤ 50 chars
          - Type matches the change (feat/fix/refactor/docs/chore/test)
          - Body wrapped at 72 chars
          - One coherent concern
          Return the corrected message or "PASS" if it is already correct.

          Message:
          $INPUT

          Original request: $ORIGINAL
```

### Migration: updated SKILL.md

Replace the hand-coded dispatch in Step 1–2 with `run_chain`, **but keep the OpenCode/no-dispatch fallback branch intact.** The skill currently has two paths (Pi with `dispatch` vs. OpenCode or no `dispatch` — lines 38–39, 72). The `/chain` migration is Pi-only.

```markdown
### Workflow — Split Delegation (cost-efficient, Pi)

**Platform check — which path to follow:**

- **You have a `run_chain` tool (Pi with orchestration-engine):** follow Steps 0–3 below.
- **No `run_chain` tool (OpenCode, or a Pi session without the chain extension):** skip to the [Inline Fallback](#fallback--inline-opencode-or-no-dispatch) section below.

**Step 0 — Bootstrap (primary):**

1. `git rev-parse --is-inside-work-tree`
2. `git diff --cached --name-only`
3. Stage coherent changes if needed.

**Step 1 — Draft + Review via `/chain`:**
```

run_chain({
chain: "commit-message",
task: "Draft a conventional commit message for the currently staged changes."
})

````
The chain runs `builder` on the FREE tier to draft, then `reviewer` on `glm-4.7` to verify.

**Step 2 — Final factual cross-check (primary):**
1. `git diff --cached --stat` — verify counts/types match the message.
2. If mismatch, either correct inline or re-run the chain with correction guidance.

**Step 3 — Commit (primary):**
```bash
git commit -F -   # feed the reviewed message via stdin
````

_(gated-bash ASK fires in the primary session — confirm within 30s.)_

```

The fallback section remains unchanged for OpenCode/no-dispatch sessions.

### What stays in the skill vs. what moves to the chain

| Concern | Stays in SKILL.md | Moves to `agent-chain.yaml` |
|---|---|---|
| Bootstrap checks | yes | no |
| Final commit with `git commit -F -` | yes | no |
| Conventional commit format instructions | yes (reference) | yes (in prompt) |
| Drafting the message from `git diff --cached` | no | yes |
| Reviewing the draft for format/scope | no | yes |

### Why this is real dogfooding

After migration, `git-commit-message` is no longer a hand-coded dispatch sequence. It is a **caller of the `/chain` primitive**. The chain definition is reusable: any other skill or the primary can run `run_chain({ chain: "commit-message", task: ... })` and get the same draft+review pipeline.

This also becomes the **template shape for future shared macro/micro skills**:

```

plan → delegate → review → finalize

```

Where "finalize" is the primary-only step that the skill wraps around the chain.

## Tier-map precedence in chains

Each step explicitly declares a `category`. The chain runner calls the existing `dispatch` resolution logic, which applies:

```

model = persona.model ?? TIERS[category].model

```

For example, in the `commit-message` chain:
- Step "draft" uses `category: "git-commit-message"` → `opencode/deepseek-v4-flash-free` (FREE tier).
- Step "review" uses `category: "unspecified-low"` → `zai-coding-cn/glm-4.7` (cheap review).

This is the key difference from disler's `agent-chain.ts` (lines 337–339), which uses the primary's model for every agent. Our chain preserves the cost-routing win.

## Chain execution flow

1. Load `agent-chain.yaml` on `session_start` (global + project, deny-additive).
2. `/chain` selects the active chain.
3. `run_chain({ task })` runs steps sequentially:
   - Substitute `$INPUT` and `$ORIGINAL`.
   - Resolve `category = step.category ?? chain.default_category`.
   - Call `dispatch` with the resolved step's agent, category, and prompt.
   - If the dispatch fails, stop and return error details.
   - Otherwise, feed the output to the next step.
4. Return the final step's output to the caller.

## Non-goals

- **Primary-only chain steps.** Out of scope for v1. The skill handles primary bookends.
- **Conditional branching.** Out of scope for v1.
- **Background chains.** `/chain` is blocking; `/sub` is step 8.
- **Heterogeneous-model teams per chain.** The chain uses our category→model map; it does not support per-step model pins that bypass the tier-map.

## Validation plan

1. Load `agent-chain.yaml` and verify all chains parse.
2. Run `/chain commit-message` and confirm both steps appear in the widget.
3. Run `run_chain({ chain: "commit-message", task: "..." })` and verify:
   - Step "draft" runs on `deepseek-v4-flash-free`.
   - Step "review" runs on `glm-4.7`.
   - Final output is the reviewed message.
4. Update `git-commit-message/SKILL.md` and run the skill on a real repo to confirm the end-to-end workflow still works.
5. Verify that `/chain` does not break the existing `dispatch` tool — they share the same spawn logic.

## Open questions

1. Should `run_chain` accept a `team` parameter, or should the chain use the active team? Recommendation: use the active team from `/team` for now; add `team` override later if needed.
2. Should chain definitions be project-local only, or also global? Recommendation: global + project merge, same as teams and mini-dc.
3. Should the widget be in `orchestration-engine/index.ts` or a separate `agent-chain.ts` extension? Recommendation: start as a separate `extensions/agent-chain.ts` file for isolation; merge into orchestration-engine later if it proves tightly coupled.

## Files to touch

1. `~/.pi/agent/agent-chain.yaml` — new chain definitions.
2. `~/.pi/agent/extensions/agent-chain.ts` — new extension.
3. `~/.pi/agent/extensions/orchestration-engine/index.ts` — **extract `resolveAndSpawn()` helper** so both `dispatch` and `run_chain` share the same model resolution + spawn logic.
4. `~/.config/opencode/skills/05-development/git-commit-message/SKILL.md` — migrate Steps 1–2 to `run_chain`; keep the OpenCode/no-dispatch fallback.
5. `~/.pi/agent/README.md` — update the backlog note to reflect `/chain` shipped.
```
