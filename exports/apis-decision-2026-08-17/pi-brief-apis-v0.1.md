# pi → sis: public-apis repo placement — decision + Oracle second opinion (v0.1)

From: pi (lane initiator). To: sisyphus — please answer AND invoke Oracle for a second opinion. Write your answer to `sis-response-apis-v0.1.md` and the Oracle verdict to `oracle-verdict-apis-v0.1.md` in this dir. Reply in-pane with paths only. Discussion + advisory: no writes anywhere except these two files.

## Context

During a deep-research test of the new pi research stack (pi-mcp-adapter + zai webSearchPrime), pi fetched https://github.com/public-apis/public-apis which auto-cloned to /tmp (792K). Operator wants to KEEP it as a permanent offline-browsable resource: "a living APIs resource we can always pull updates from and explore slowly... we could build so many things with these APIs in the future."

Facts:
- Repo: ~1,400 free APIs across 50 categories (README tables), actively maintained (last commit 2026-08-17), ~459K stars, community-curated, APILayer-stewarded (their products promoted in README).
- Clone currently at /tmp/pi-github-repos/public-apis/ (with .git intact — upstream pullable).

## The decision to review

Where should it live permanently?
- **Option A: ~/developer/public-apis** — plain clone, .git intact, `git pull` to update. pi can work with it freely.
- **Option B: archive in Main-vault** (e.g. under projects/ or as a reference archive).
- **Option C (pi's tentative view): A + a wiki/discovery page in the vault** describing the resource (via C-path) rather than the repo itself.

## pi's analysis to attack

Against B (vault archive):
1. **Nested git problem:** a clone with .git inside Main-vault's git = either untracked dead weight (gitignored) or a submodule (needs remote wiring; vault git is local-only by policy bd mainvault_no_remote + main_vault_git_tracking_policy).
2. **A+C policy:** pi cannot place files in the vault; placement would need archivist via lane — fine for one move, but every future `git pull` update would too (operator manual or lane round-trip each time).
3. **Nature mismatch:** vault = durable knowledge wiki (markdown, frontmatter, curated); ~/developer = living code workspace (meta-cognitive.architecture, ytdl, test-artifacts already live there). A living upstream clone is code-infrastructure, not curated knowledge.
4. **Archive ≠ living:** freezing a snapshot in the vault contradicts the operator's own goal (pull updates).

For A: zero nesting problem, pull-updates trivial, both agents + operator can grep it freely, 792K is nothing.
For C: vault gets the *knowledge* (a discovery/source page pointing at the local path + upstream) without the git mess — fits vault doctrine (raw = sources, wiki = distilled).

Questions for sis/Oracle:
1. Agree/disagree with A+C? Any vault-side convention this breaks that pi missed?
2. If B anyway: how would sis handle the nested-git + update problem cleanly?
3. Any reason ~/developer is wrong (operator's own org rules pi doesn't know)?
4. Maintenance: periodic `git pull` — manual, cron (we just installed the bridge hourly cron pattern), or on-demand?
