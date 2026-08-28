# pi → sis: opencode 1.18.25 update — CHECK-ONLY review (lane: opencode-118)

Operator requested a three-way review (operator + pi + sis) BEFORE any change.
This round is **check-only**: no config edits, no npm install/update, no
migrations, no `config migrate`, no `npm audit fix`. Read-only checks plus
writing your findings file. Nothing gets applied today from this round.

## Verified facts (pi, local evidence — no need to re-derive)

- opencode binary resolves via cross-node symlink:
  `~/.nvm/versions/node/v22.22.3/bin/opencode` → `v22.15.0/bin/opencode` →
  npm-installed `opencode-ai@1.17.12` under the OLD node v22.15.0 tree.
  That old tree also holds the only copies of @google/gemini-cli, nodemon,
  semble — so `nvm uninstall` of old trees would break opencode today.
- Latest on npm: `opencode-ai@1.18.25` (1.17.12 → 1.18.25 is a minor-line jump).
- `oh-my-openagent` installed 4.19.4 = latest on npm; operator pins it EXACT.
  Standing rules pi holds (correct if stale): never `npm audit fix` in
  ~/.config/opencode; never convert `[opencode].agents` `fallback_models` to
  `models` chains; doctor mandatory after every manual omo config edit.
- Operator-stated complication: the omo config MOVED —
  `oh-my-openagent.json` → `/home/vladi/.omo/omo.jsonc`. pi has NOT read it
  (boundary) — you own that surface; old pi-side notes referencing
  `~/.config/opencode/omo.jsonc` may be stale.

## Questions (in order)

1. **Current layout truth.** Where does the omo config actually live now
   (`~/.omo/omo.jsonc`?), where does the doctor entrypoint live now, and is
   the old `cd ~/.config/opencode && node node_modules/oh-my-openagent/bin/oh-my-opencode.js doctor`
   invocation stale? State the correct current invocation.
2. **Doctor now.** Run omo doctor (read-only assessment) against the current
   state (opencode 1.17.12 + omo 4.19.4) and report its verdict + any warnings.
3. **Known-issue check — the core question.** The "agents disappear after an
   opencode minor upgrade" failure class (precedent: opencode 1.4.0 SDK break,
   code-yeongyu/oh-my-openagent issue #3220). Does that class still apply to
   opencode 1.18.x running omo 4.19.4? Check the omo 4.18.x–4.19.4 release
   notes/changelog for explicit statements about supported/tested opencode
   versions. Cite what you find; say UNKNOWN if the sources don't state it.
4. **Safe update path (draft only).** If compatible: draft the exact sequence
   you would run or approve — including installing opencode under the CURRENT
   node tree (v22.22.3) to kill the old-tree dependency, keeping the omo 4.19.4
   exact pin, config backup BEFORE anything, doctor + agent-registration
   verification AFTER. If not compatible or unknown: state the blocker and
   what must happen first.
5. **Risks you see that pi missed.** Anything about the ~/.omo move, plugin
   registration, or the npm-under-old-node install that changes the plan.

## Output contract

Write your complete findings to:
`/tmp/herdr-collab/opencode-118/sis-findings-v0.1.md`
Reply in-pane with ONLY the file path (plus a one-line verdict if you want).
Durable file is the channel; keep the pane reply short.
