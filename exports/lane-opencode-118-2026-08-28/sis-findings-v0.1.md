# sis → pi: opencode 1.18.25 review — findings (lane: opencode-118)

Round: CHECK-ONLY. Nothing applied. Commands run this round were all
read-only (`ls`, `read`, `grep`, `find`, `opencode --version`, omo `doctor`,
`bd memories`, GitHub/npm research via librarian). Only file written is this
one. Constraints honored: no `npm audit fix`, no `config migrate`, no
fallback_models conversion, no install/update/uninstall.

## One-line verdict

**BLOCKED — the operator's recorded upgrade gate (bd memory
`global:constraint:opencode_upgrade_gate`) is unmet: PR anomalyco/opencode#40472
is still OPEN/unmerged and v1.18.25 ships none of the four tracked fixes.
Everything else is healthy: layout verified, doctor clean apart from the 27
known deprecation warnings, which are a documented trap at omo 4.19.4 — do
NOT run the migration doctor suggests.**

---

## Q1. Current layout truth

All paths verified locally today (Aug 28, 2026):

| Surface | Truth |
|---|---|
| omo config | `~/.omo/omo.jsonc` (10,758 B, Aug 14 19:58). Read correctly by omo 4.19.4 — doctor output cites this path in every finding. |
| Config backups | `~/.omo/omo.jsonc.bak.2026-08-10T00-07-27-749Z` (11,081 B), `~/.omo/omo.jsonc.bak.pre-migrate-2026-08-14` (10,848 B), and the original pre-migration file at `~/.omo/migration-backup-2026-08-10T00-07-27-709Z-opencode-config/.config/opencode/oh-my-openagent.json`. Backup coverage for the move is real. |
| omo install | `~/.config/opencode/node_modules/oh-my-openagent/` @ **4.19.4** — project-local ONLY. No global omo in either nvm tree. All four platform binaries present (`oh-my-openagent-linux-x64{,-baseline,-musl,-musl-baseline}`). |
| Doctor entrypoint | `bin/oh-my-opencode.js` is a **wrapper** that spawns the compiled platform binary; the `doctor` subcommand lives in that binary. |
| Old invocation | `cd ~/.config/opencode && node node_modules/oh-my-openagent/bin/oh-my-opencode.js doctor` is **NOT stale — verified working today**. Equivalent: `~/.config/opencode/node_modules/.bin/omo doctor`. (bd memory `omo_jsonc_doctor_after_every_edit` records the same form; still correct.) |
| Runtime plugin resolution | opencode resolves the version-qualified string `oh-my-openagent@4.19.4` (from `~/.config/opencode/opencode.json` `plugin[]`) into `~/.cache/opencode/packages/oh-my-openagent@4.19.4/` (synced Aug 10 02:07). Stale-but-harmless leftovers: cache `packages/package.json` still says `"oh-my-opencode": "latest"` (old package name) and a `sisyphus-gates@latest/` dir (Jun 7; opencode.json now uses local `./plugins/sisyphus-gates`). |
| Pin | `"oh-my-openagent": "4.19.4"` in `~/.config/opencode/package.json` + `"oh-my-openagent@4.19.4"` string in `opencode.json` — **two places, must stay in sync**. Also there: `"@opencode-ai/plugin": "1.16.2"` (SDK for local plugin builds). |
| Node trees | v22.22.3 (current): NO opencode-ai, NO omo. Its `bin/opencode` is the cross-node symlink → `v22.15.0/bin/opencode` (confirmed). v22.15.0 (old) exclusively holds global `opencode-ai@1.17.12`, `@google` (gemini), `nodemon`. `tsc`/`typescript-language-server` exist in BOTH trees. |

## Q2. Doctor verdict (run today, read-only)

`⚠ 27 issues` — **all one class**: "Deprecated reasoning config key …
`[opencode].agents.*.fallback_models` / `[opencode].categories.*.fallback_models`"
(18 agents + 9 categories). Suggested fix in every one: *"Replace
fallback_models with models, or run: oh-my-openagent config migrate"*.

Interpretation — constraints-first:

- These are **deprecation warnings, not breakage**. The config loads and
  works; this very session is routed through it.
- **The suggested fix is a documented trap at 4.19.4.** Do not apply it.
  Evidence (bd memories `omo_6868_*`, `omo_4194_root_cause`,
  `omo_config_migration`; upstream issue code-yeongyu/oh-my-openagent#6868,
  findings comment 2026-08-16):
  - 5 legacy-only runtime readers still read `model`/`fallback_models`
    (available-categories.ts; runtime-fallback fallback-models.ts on BOTH
    agent and category paths; delegate-task subagent-model-resolution.ts;
    plan-model-inheritance.ts — `MODEL_SETTINGS_KEYS` lacks `models`;
    prometheus-agent-config-builder.ts).
  - `AgentOverrideConfigSchema` has **no `models` key** → zod silently strips
    migrated agent chains at load.
  - The installer's own `attachFallbackModels` still emits the legacy format;
    migration `shouldCombine` is asymmetric between agents and categories.
  - Precedent: the **Aug-10 incident** — the 4.19.x migration converted
    categories to `models` chains; runtime readers got `undefined` and the
    TUI/tool roster silently fell back to builtin defaults
    (claude-fable-5/gpt-5.6-sol/kimi-for-coding-highspeed). Fix was reverting
    to `model` + `fallback_models` under `[opencode]` — i.e., exactly the
    current layout.
- Therefore: **27 warnings = accepted permanent baseline at 4.19.4.** They
  will not reach zero without an upstream fix (omo#6868, operator closed
  engagement — do not re-engage without instruction). Any NEW issue beyond
  these 27 in a future doctor run is the actual signal.
- Doctor raised NO config-location, plugin-registration, or version-mismatch
  errors → `~/.omo/omo.jsonc` move is fully absorbed by 4.19.4.

## Q3. Known-issue check — the core question

**Does omo 4.18.x–4.19.4 declare/test opencode 1.18.x support? → UNKNOWN.**
Checked v4.18.0–4.18.2, v4.19.0–4.19.4 release notes and CHANGELOG.md
(code-yeongyu/oh-my-openagent): zero explicit statements of supported/tested
opencode versions. This is a documentation gap, not evidence of breakage.
(Release list with dates in appendix.)

**Does the "agents disappear after minor upgrade" class (#3220 precedent)
apply to 1.18.x + omo 4.19.4? → The original class NO; two residual bugs
YES (open, with workarounds).**

| Episode | Status | Applies to 1.18.25? |
|---|---|---|
| 1.4.0 SDK break (Agent.defaultLayer timing; omo#3220) | Fixed in opencode 1.4.3 (commit 2ecc6ae65, Layer.suspend) | No |
| 1.14.32 InstanceStore/AsyncLocalStorage registration break (omo#3760) | Fixed in 1.14.33 | No |
| 1.15.x `/connect` → agents disappear (plugin `config` hooks not re-invoked after model switch; omo#4130 / opencode#30955) | **Still open in 1.18.x** | Yes — avoid `/connect` or restart after use |
| Silent instance recreation → stale agent-registry cache (reported 1.18.12 + omo 4.19.4; opencode#30955) | Open; race condition, not a declared break | Possibly — restart is the workaround |
| Desktop 1.18.15+ Bun-target plugin sidecar gap (opencode#41033) | Open | **No — Desktop-only; this system runs the CLI** |
| New 1.18.0–1.18.25 plugin/agent SDK breaks | **None found.** MCP SDK v2 landed 1.18.8, legacy compat restored by 1.18.11 (commit 982a904) | No |

**BUT the decisive check is the operator's own gate** (bd memory
`global:constraint:opencode_upgrade_gate`, verbatim):

> HOLD opencode at 1.17.12. Do NOT upgrade until GitHub PR
> anomalyco/opencode#40472 (fix for #40463 slash-skill arg swallowing)
> merges + ships in stable. When upgrading: (1) add top-level
> `subagent_depth:2` to opencode.json (delegation graph needs 2 levels);
> (2) do a LIVE GATE PROBE post-restart (attempt known-catastrophic bash
> pattern, confirm blocked) — #41574 means plugin load failures are silent,
> so log checks are insufficient for verifying sisyphus-gates loaded. Also
> watch #41571 (Kimi K3 compaction empty summary) if compacting oracle
> sessions.

Status of all four, verified today via librarian (GitHub):

| Ref | Subject | State (today) | In 1.18.25? |
|---|---|---|---|
| opencode#40463 | slash-skill arg swallowing | OPEN (last activity Aug 10) | No |
| opencode PR #40472 | fix for #40463 | **OPEN — not merged** (last activity Aug 22) | No |
| opencode#41574 | TUI/plugin load failures are silent (no log/stderr diagnostic) | OPEN | No |
| opencode#41571 | Kimi K3 compaction empty summary (since 1.18.15, compaction.ts flatten-to-text) | OPEN (last activity Aug 22) | No |

v1.18.25 (Aug 28, 2026) contains 4 commits: version sync, Qwen3.8 Flash docs
(#45836), Azure-auth Bun-dependency removal (#45845), release tag. **None of
the four gate items.** → **Gate condition unmet.**

Also relevant: `subagent_depth` was introduced in **v1.18.2** ("Stopped
subagents from launching nested subagents by default, with a configurable
`subagent_depth` limit") — i.e., ANY 1.18.x silently caps nested delegation
at depth 1 without the config key. It is currently **absent** from
`opencode.json`.

## Q4. Safe update path (draft only — BLOCKED today)

**Blocker (must clear first):** PR anomalyco/opencode#40472 merged AND shipped
in a stable release. Today: OPEN/unmerged → **no update to 1.18.25.** The
generic compatibility picture is otherwise favorable (no SDK breaks in
1.18.0–1.18.25), so when the gate clears, the following is the draft
sequence — nothing below has been executed:

0. **Preconditions**: #40472 merged + shipped; re-check #41574/#41571; pick
   the release that actually contains the fix (not necessarily 1.18.25).
1. **Backups BEFORE anything** (existing backups cover omo.jsonc only —
   opencode.json has NO backup yet):
   - `~/.omo/omo.jsonc` → `omo.jsonc.bak.pre-opencode-update-<date>` (rotate pattern already in use)
   - `~/.config/opencode/opencode.json` → timestamped copy (first-time practice)
   - `~/.config/opencode/package.json` + `package-lock.json` → timestamped copies
2. **Install opencode-ai under the CURRENT node tree** (v22.22.3):
   `npm install -g opencode-ai@<version>` with nvm on 22.22.3. This creates a
   native `v22.22.3/bin/opencode`.
3. **Remove the cross-node symlink** `~/.nvm/versions/node/v22.22.3/bin/opencode`
   (currently → v22.15.0) so PATH resolution hits the new native install.
   Kills the old-tree dependency for opencode.
4. **omo pin untouched**: `oh-my-openagent: 4.19.4` in package.json AND the
   `oh-my-openagent@4.19.4` string in opencode.json `plugin[]` — both stay;
   they must remain mutually in sync (see Q5 risk 3).
5. **Add top-level `"subagent_depth": 2`** to `opencode.json` (mandatory
   since 1.18.2; our task() delegation graph needs 2 levels — without it,
   nested delegation breaks silently).
6. **Do NOT touch** `fallback_models` keys; do NOT run `config migrate`.
   Doctor will still report the 27 deprecation warnings — expected baseline.
7. **Old-tree decommission = separate, later step** (explicit operator
   approval): before any `nvm uninstall` of v22.15.0, confirm nothing else
   resolves from its bin — after step 3 that leaves `gemini` and `nodemon`
   (the only exclusive residents). `semble` MCP is safe (Python shim at
   `~/.local/bin/semble`, independent of both trees); `tsc` /
   `typescript-language-server` exist in the current tree too.
8. **Verification AFTER** (restart, then):
   a. `opencode --version` = new version.
   b. `doctor` from `~/.config/opencode`: same 27-warning baseline, **zero
      new issues**.
   c. Agent registration: TUI agent selector shows the omo roster; models
      panel shows omo models — NOT builtin defaults like claude-fable-5
      (that signature = the Aug-10 legacy-reader failure mode).
   d. **LIVE GATE PROBE** (mandatory per gate memory): attempt a
      known-catastrophic bash pattern in a fresh session and confirm
      sisyphus-gates BLOCKS it. #41574 = plugin load failures are silent →
      log inspection alone proves nothing.
   e. Skill-arg check: invoke a slash skill with args; confirm args reach the
      skill body (#40463 regression test on the shipped fix).
   f. `npm run test:compat` in `~/.config/opencode`
      (`scripts/verify-plugin-compat.js`) — exercises the local
      sisyphus-gates plugin against the pinned `@opencode-ai/plugin` SDK.
   g. Compaction caution: avoid compacting kimi-k3 (oracle primary) sessions
      until #41571 is confirmed fixed — empty summaries drop history
      silently.
   h. Update bd memory `opencode_upgrade_gate` to the new baseline.

## Q5. Risks pi missed

1. **The upgrade gate itself.** pi's brief treats the update as
   compatibility-gated only. There is a recorded operator HOLD
   (`opencode_upgrade_gate`) with a concrete precondition (#40472 merged +
   shipped) and two hardening steps (`subagent_depth: 2`, live gate probe).
   This flips Q4 from "draft a sequence" to "blocked; precondition unmet."
   Corroborating decision memory `omo_keep_decision_2026_08_14`: re-open the
   frozen-omo posture only on opencode#40472 merge, omo#6868 fix, or a
   confirmed paid-routing incident.
2. **Doctor's suggested fix is a trap, and doctor-passing ≠ plugins loaded.**
   The 27 warnings will tempt any future session into `config migrate`; the
   #6868 analysis (zod strip + 5 legacy readers + installer still emitting
   legacy format) proves conversion breaks agent/category routing at 4.19.4.
   Treat the 27 as baseline. Separately, #41574 means a broken plugin load
   produces NO diagnostic — doctor green does not prove sisyphus-gates
   loaded; only the live gate probe does.
3. **Two-place version pin + runtime cache.** omo version lives in BOTH
   `package.json` (dependency) and `opencode.json` (version-qualified plugin
   string), and opencode materializes it in
   `~/.cache/opencode/packages/oh-my-openagent@4.19.4/`. Any future omo bump
   that updates one place but not the other = silent plugin non-load (#41574
   makes it invisible). Cache also holds stale artifacts (old package name
   `"oh-my-opencode": "latest"`, `sisyphus-gates@latest/`) — harmless today,
   cleanup candidate for a later round.
4. **`subagent_depth` regression at 1.18.2.** Silent behavior change: nested
   subagents disabled by default. Our delegation graph (sisyphus → task() →
   nested agents) requires depth 2. Config key absent today → would break on
   upgrade until step 5 runs. Not in pi's list.
5. **Kimi K3 compaction (#41571) directly touches our oracle.**
   `opencode-go/kimi-k3` is the oracle primary in omo.jsonc. Since 1.18.15,
   compaction on Kimi K3 can produce empty summaries (history silently
   dropped). Any 1.18.x upgrade moves us into the affected line while the
   oracle model is exposed.
6. **`/connect` + instance-recreation bugs persist in 1.18.x.** If the
   operator uses `/connect` for model switching, agents can disappear until
   restart (open since 1.15.x). The instance-recreation race was reported
   specifically with 1.18.12 + omo 4.19.4. Workaround: restart.
7. **semble MCP is NOT old-tree-coupled.** pi flagged the old-tree npm
   `semble` as a risk. The MCP server config `["semble", "mcp"]` resolves to
   `~/.local/bin/semble` — a Python entry-point shim, independent of both
   node trees. One LESS old-tree dependency than pi's brief assumes. Actual
   exclusive old-tree residents after an opencode reinstall: `gemini`,
   `nodemon`.
8. **4.x is EOL-bound.** omo 4.19.4 is the final 4.x stable ("LAST RELEASE
   BEFORE THE OMO NATIVE CLI PUBLIC RELEASE"); 5.0.0-beta.25 (Aug 28) is the
   active line. The exact pin freezes us against a moving opencode — fine
   per the keep-decision, but the 5.x line + omo#6868 fix are the horizon
   events to watch for the next review round.

## Appendix — sources

- Local: paths, symlinks, versions, doctor run, cache layout (all verified
  today, listed in Q1/Q2).
- bd memories (operator system of record):
  `opencode_upgrade_gate`, `omo_keep_decision_2026_08_14`,
  `omo_config_migration`, `omo_4194_root_cause`, `omo_6868_*` (3 keys),
  `omo_fallback_models_do_not_convert`, `omo_no_models_chain_format`,
  `omo_jsonc_doctor_after_every_edit`, `npm_audit_fix_banned`,
  `omo_install_location`.
- Upstream (via librarian, Aug 28 2026):
  - omo releases: github.com/code-yeongyu/oh-my-openagent/releases
    (v4.18.0 Jul ~3 → v4.19.4 Aug 1; v5.0.0-beta.25 Aug 28)
  - omo#3220 (1.4.0 agents disappear; fixed 1.4.3, commit 2ecc6ae65);
    omo#3760 (1.14.32); omo#4130 (/connect); omo#6868 (models-chain legacy
    readers); omo#5575 (disputed 1.17.10 hooks claim)
  - opencode: v1.18.0 (Jul 14), v1.18.8 MCP SDK v2 (#39247), v1.18.11 legacy
    restore (#39373 / 982a904), v1.18.2 subagent_depth, v1.18.25 = 4 commits
    (#45836 docs, #45845 Azure auth); issues #40463 / PR #40472 / #41574 /
    #41571 all OPEN; #30955 (instance recreation), #41033 (Desktop-only
    sidecar gap — irrelevant to CLI).
