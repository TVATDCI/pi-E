# Second-Opinion Review: davidondrej-skills Absorption Verdict (validate stage)

All factual claims were re-verified against the repo. Headline: the verdict is factually sound — line counts are exact (323 / 65 / 52 / 197), every quoted extract exists, and the reject taxonomy mostly holds. The calls as made are directionally right; three of them need specific changes before execution.

---

## C1 — `effective-agent-skills` → merge into pi's `skill-creator`: **GO-WITH-CHANGES**

**Verified:** exactly 323 lines. All 6 extracts exist and are worth taking: (a) description-routes-never-summarize at L136–146, (b) strictness ladder at L157–161, (c) YAML colon gotcha at L94 — which explicitly names *"strict YAML parsers (e.g. Pi's)"* and is the single most pi-relevant line in the repo, (d) Pattern A/B at L111–130, (e) security checklist §11 L280–289, (f) ship checklist §12 + trigger-vs-execution test framing (§8 steps 6–7, §9 L260–262). Rejected-from-merge items (eval suite L265, cross-client frontmatter L96–107) are correct rejections under the lean convention.

- **PROS:** Merge-not-install is exactly right — a second authoring skill = description-routing collision, the very failure mode this file teaches. Extract selection is disciplined.
- **CONS:** The verdict specifies *what* to merge but not *how*: 6 verbatim extracts ≈ 70–90 lines; pi convention is lean.
- **MISSED:** (1) No dedupe step — pi's existing `skill-creator` content is unverifiable from here (`~/.pi/` off-limits), and it plausibly already covers (a). (2) Optional 7th: "test against the weakest model you'll deploy on" (L264) folds naturally into (f).

**Change:** Merge protocol = dedupe against existing skill-creator content first, compress the delta to ≤~40 lines total, drop anything already covered. Note extract (c) is David's pi-version observation — re-verify the parser behavior on current pi before enshrining the fix.

## C2 — `hooks/` + `global-agent-guardrails` → pi extension material: **GO-WITH-CHANGES**

**Verified:** `dangerous-patterns.txt` = 65 lines, all claimed categories present plus extras the verdict didn't enumerate (reflog/gc-prune §8, `gh` destructive set + `gh auth token` §9, `chown -R /`). `test-guard.sh` = 197 lines, dual-payload, and genuinely adversarial: quoted `$HOME`, `--recursive --force` long flags, compound prefixes, and false-positive allow cases (`git commit -m "rm -rf mention..."`, `npm run pass-tests`). "Seatbelt not sandbox" honesty is at guardrails L8; fail-open-on-pi-handler-error gotcha at L79. The source even documents a pi adapter design (L17, L55) — the verdict's mechanism is grounded, not invented.

- **PROS:** Right posture (extension, not skill; operator security decision, not pre-approved). The harness is real quality — worth the ~20–30% LOC premium doctrine.
- **CONS:** Linux-ification as stated ("drop /opt/homebrew PATH, /Users tree, diskutil") is under-scoped — those deletions are cosmetic.
- **MISSED:** (1) **The substantive Linux gap:** the `/Users`-tree rm pattern (patterns L12) has no `/home` analog — literal `rm -rf /home/<user>` is unblocked (only `~`/`$HOME` forms are caught, patterns L10–11). Add the `/home(/[^/]+)?` pattern; macOS-only patterns are harmless dead weight on Linux. (2) **The 197-line harness tests the shell script, not a pi adapter** — a `pi.on("tool_call")` adapter is a third payload shape needing its own block/allow tests; carry the source's E2E probe (guardrails L95) and the `[:space:]`→`\s` + multiline-mode requirement (L32, L82) into the extension spec. (3) **Unmade design decision:** shared patterns file (`~/.agents/hooks/`) vs pi-private copy — recommend shared, preserving the source's one-tuning-point design. (4) **Stack asymmetry risk:** opencode's sisyphus-gates is far stricter (blocks all compounds); a denylist guard on pi creates a policy gap between the operator's two stacks — say so explicitly rather than implying parity.

**Change:** Spec must include: `/home` patterns, adapter-level tests + fail-open self-catch (per source L79), ERE→JS conversion rules, shared-file decision, and the asymmetry note.

## C3 — `herdr` sharp edges → pi-side notes, official skill canonical: **GO-WITH-CHANGES**

**Verified:** all 6 edges verbatim in source — empty-read-below-viewport L72, `.cwd`/`.foreground_cwd` L73, label collisions L86, restart husks L89, C0/U+2063 L66, idle-during-tool-call L79. Yolo-launch safety rationale confirmed at L105 ("safe only because... guardrails... installed"); Cursor block L109–122 correctly discarded. Third-party provenance confirmed (L24: `npx skills add ogulcancelik/herdr`); "58 installs" is unverifiable from a clone and immaterial.

- **PROS:** Keep-official-canonical + probe-before-entering respects both upstream drift and the operator's local-evidence rule.
- **CONS:** The 6-edge extract set skews to *reading/state* and starves *sending/targeting* — the part a collab skill actually runs on.
- **MISSED:** High-value edges left out: send-text → ~1s sleep → separate `send-keys enter` for TUI composers (L65, `pane run` gets swallowed), slash-popup first-Enter-eats + escape (L67), never-verify-submit-by-content (L68), always `--session` + never `server stop` + first-colon split (L56–58), never sleep-and-read — use `agent wait`/`wait output` (L107), last-tab/only-pane lifecycle deletions (L87).

**Change:** Expand the probe-gated extract set to the sending/targeting/lifecycle edges above — or explicitly verify pi's existing herdr notes already carry them and extract only the delta.

## C2 × C3 interaction (set-level)

The verdict discarded the yolo rationale because pi has no guard — correct *today*, but it didn't record the converse: **if C2 is adopted, the yolo-launch safety argument is partially rehabilitated.** Add one line to the pi herdr notes: "yolo-launch safety is conditional on the pi command guard; reassess if/when it lands." Order matters: decide C2 before finalizing C3 notes.

## Borderlines — **GO (defer as made), with notes**

- **`pi-custom-model`** — defer correct; mechanism verified in-file (exact-match `find()`, silent fallback tell, `models.json` as the real fix, `enabledModels` pin, project-override). Consistent with constraint that models.json exists for custom registration. If absorbed later: strip `disable-model-invocation` (pi = two fields) and re-probe the `<pi-pkg>/node_modules/...` bundled-list path (version-drift prone).
- **`decisions`** — defer correct; 15 lines confirmed, retrospective, orthogonal to forward plan discipline. Cheapest and least collision-prone of the three if the operator wants one.
- **`ask-then-build`** — defer-to-no correct; duplicate machinery vs `plan_before_nontrivial_implementation` violates anti-over-engineering. Family verdict (none of `before-building`/`next-decision`/`brain-to-docs`) is consistent — though `brain-to-docs` wasn't named, it's the same turf.

## Rejects — **GO, one precision fix**

- **`handoff`** — reject correct. Its core principles (state-not-instructions, reference-don't-duplicate, capture-the-why, verify-don't-trust, redact) are already operator doctrine point-for-point; nothing lost.
- **`pi-web-search`** — reject correct, reasoning imprecise: the file shows `web_search` is zero-config Exa; DeepAPI is only the ranked-results/fallback path. The load-bearing fact is package-not-installed (machine state, taken on the verdict's verification). Add a revisit trigger: if pi-web-access ever installs, this resurrects.
- **`prompt-me`** — correct; DRAFT self-marked (L7).
- **`before-building` / `next-decision`** — correct (verified contents; family logic holds).
- **macOS/personal-infra/DeepAPI class + `cyber-audit`** — correct. Spot-verified: `cmux` self-declares macOS-only, `browser-harness` depends on David's local `$PATH` tool, four research skills are DeepAPI-coupled, `cyber-audit` has no SKILL.md (only `agents/openai.yaml`).

## Repo-level MISSED

1. **`skills/agent-orchestration/git-worktree/SKILL.md` — the one real miss.** Tool-agnostic core (one task = one worktree, primary-checkout-as-integration-point, gitignored-files bootstrap, copy-never-symlink env/`node_modules`, compose project-name port trap, shared hooks). Cursor-specific content is cleanly separable (~15%). If pi lacks a worktree skill this is borderline-worthy; if covered, it deserved a named considered-and-rejected. Either way, silence is wrong.
2. **`skills/research-and-web/research-prompt/SKILL.md`** — tool-agnostic 42-line research-brief discipline (numbered sub-questions, source hierarchy, contradiction handling, gap round); the only research-category skill not DOA on dependencies. Low urgency given pi's absent web tooling, but it should have received a named pass/reject rather than falling into the "DeepAPI-coupled" bucket it doesn't belong to.
3. **`skills/ops-and-setup/create-readonly-db-role/SKILL.md`** — portable Postgres hardening pattern (denylist-not-allowlist, RLS trap, human-applies-DDL); neither macOS nor DeepAPI, so the reject taxonomy silently swallowed it. Rejectable on no-current-need, but name it.
4. **`teach`** — flagship 139-line multi-file skill excluded silently. Exclusion is right (violates one-file convention; opencode-side teach already exists; cross-stack divergence risk) but deserves a named reason.
5. Minor: `distribute-skill-to-all-agents` documents a **symlink layout into `~/.pi/agent/skills`** — the repo's clearest anti-pi-independence skill; worth naming in the reject list as doctrine-reinforcing. `agent-self-scheduling` has a thin pi-relevant fraction (`pi run`, external clock, permission-hang gotcha). `read-all-adrs` is an unfinished profane stub — trivially rejectable, also silent.

## Bottom line

The verdict's factual layer is clean and its architecture instincts (merge-not-install, extension-not-skill, official-canonical-not-fork) all match the pi constraints. Issue **GO-WITH-CHANGES overall**: C1 needs a dedupe-then-compress merge protocol; C2's spec needs the `/home` pattern gap closed, adapter-level tests, and the shared-file/asymmetry decisions made explicit; C3's extract set must grow the sending/targeting edges. Decide C2 before writing C3's notes. Separately, the operator should eyeball `git-worktree` — the one candidate the verdict dropped on the floor.
