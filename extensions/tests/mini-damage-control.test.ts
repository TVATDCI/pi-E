// extensions/tests/mini-damage-control.test.ts — Gate v1.2 leg 1 FULL MATRIX (WP0..WP7).
// Run: node --experimental-strip-types mini-damage-control.test.ts   (cwd-agnostic)
//
// Drives the REAL mini-damage-control module (importable since R2). Colocated per-WP sections:
//   WP0 slug resolver + trail store interface (incl. multiprocess lock-serialized append)
//   WP1 read-only command engine (write-never-R, D-forms, fail-closed-on-unknown, npm test = G)
//   WP2 header + degradation law + PRIOR composition + asker-claim isolation
//   WP3 dialog v2 (fake-clock countdown, composer pause/resume, label-bound hotkeys, exactly-once)
//   WP4 grants store + protection (seat law, R-only never-D, three store attack shapes)
//   WP5 authorization matrix + worker-G parking (keyed state, abort/continue both, retry)
//   WP6 session scopes (die on session replacement; R eligible in captain panes)
//   WP7 end-to-end integration + preserved contracts
//
// The grants/trail store lives at ~/.pi/agent/mini-dc/<repo-slug>/ in production — runtime
// state OUTSIDE any repo. These tests NEVER touch the real agent home: the store root, env
// source, and dialog clock are pointed at scratch seams and reset at the end.
import miniDc, {
  appendTrail,
  activeSessionScope,
  buildDecisionHeader,
  buildDialogOptions,
  classifyBashCommand,
  composePriorLine,
  createGrant,
  deriveGrantPattern,
  isEnumeratedSteeringG,
  isReadOnlyAllowlisted,
  loadGrants,
  matchGrant,
  poolSlugForRemote,
  pruneScopesToSession,
  readTrail,
  recordSessionScope,
  resolveDecisionMatrix,
  resolveRepoSlug,
  resolveSeat,
  resolveTaskBinding,
  revokeGrant,
  riskLine,
  sanitizeAskerText,
  sessionScopeCount,
  setDialogClockForTesting,
  setEnvSourceForTesting,
  setGlobalRulesPathForTesting,
  setPoolBaseForTesting,
  setStoreRootForTesting,
  sha16,
  Countdown,
  DecisionDialog,
  type Clock,
  type DialogOutcome,
  type Grant,
  type Seat,
  type TrailEntry,
} from "../mini-damage-control.ts";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";

const MODULE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "mini-damage-control.ts");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}`); }
}
function section(name: string): void {
  console.log(`\n\u2014 ${name}`);
}

// ── shared fixtures ──────────────────────────────────────────────────────────
// Ask rules: v12askg\d* → G-class (unknown command form); v12askr\d* → matches an
// R-allowlisted command shape (git status probe); v12askd\d* → D-form (git push probe).
const RULES_YAML = [
  "bashToolPatterns:",
  "  - pattern: 'v12askg\\d*'",
  "    reason: v12 g ask rule",
  "    ask: true",
  "  - pattern: 'v12askr\\d*'",
  "    reason: v12 r ask rule",
  "    ask: true",
  "  - pattern: 'v12askd\\d*'",
  "    reason: v12 d ask rule",
  "    ask: true",
  "  - pattern: 'v12deny\\d*'",
  "    reason: v12 deny rule",
  "",
].join("\n");

const WORKER_ENV = {
  FM_TASK_ID: "task-x",
  HERDR_PANE_ID: "wX:p9",
  PI_SESSION_ID: "sess-worker-1",
};
const CAPTAIN_ENV = { PI_SESSION_ID: "sess-captain-1" };

interface Harness {
  result: { block: boolean; reason?: string } | undefined | "unset";
  customCalls: number;
  abortCalls: number;
  entries: { customType: string; data: unknown }[];
  dialogs: DecisionDialog[];
  commands: Record<string, (args: string, ctx: unknown) => Promise<void>>;
  notifies: string[];
  statuses: string[];
  tmp: string;
  store: string;
  storeOwned: boolean;
}

interface DriveOpts {
  command?: string;
  toolName?: string;
  path?: string;
  mode?: "tui" | "json" | "print" | "rpc";
  env?: Record<string, string | undefined>;
  dialogScript?: (dlg: DecisionDialog) => void;
  seedEntries?: Partial<TrailEntry>[];
  preGrants?: { seat: Seat; pattern: string; via?: "dialog" | "surface" }[];
  rulesYaml?: string;
  skipRules?: boolean;
  storeDir?: string;
  /** Invoked between session_start and the tool call (e.g. /dc-mode toggling). */
  beforeToolCall?: (h: Harness) => Promise<void> | void;
}

interface HarnessWithRun extends Harness {
  run: () => Promise<Harness>;
}

/** Narrow the gate result (throws loudly rather than asserting on "unset"). */
function R(h: Harness): { block: boolean; reason?: string } {
  if (h.result === "unset" || !h.result) throw new Error("gate returned no result");
  return h.result;
}

type TimerId = ReturnType<typeof setInterval>;

/** Manual clock for fake-clock dialog tests (WP3). */
class ManualClock implements Clock {
  private timers = new Map<number, () => void>();
  private nextId = 1;
  setInterval(fn: () => void, _ms: number): TimerId {
    const id = this.nextId++;
    this.timers.set(id, fn);
    return id as unknown as TimerId;
  }
  clearInterval(id: TimerId | undefined): void {
    if (id !== undefined) this.timers.delete(id as unknown as number);
  }
  advanceSeconds(n: number): void {
    for (let i = 0; i < n; i++) {
      for (const fn of [...this.timers.values()]) fn();
    }
  }
  pending(): number {
    return this.timers.size;
  }
}

function fakeTui(): { requestRender: () => void } {
  return { requestRender: () => {} };
}

function renderText(dlg: DecisionDialog): string {
  return dlg.render(80).join("\n");
}

// pi-tui Key names are NAMES ("enter"/"escape"), not sequences — handleInput receives raw
// terminal data, so tests drive keys with the raw sequences (verified: matchesKey("\x1b", Key.escape) === true).
const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";

function makeTrailEntry(partial: Partial<TrailEntry>): TrailEntry {
  return {
    v: 1,
    ts: new Date().toISOString(),
    actor: "gate",
    pane: null,
    task: null,
    subject: sha16("x"),
    cls: "G",
    decision: "deny",
    scope: "none",
    ...partial,
  };
}

function makeHarness(opts: DriveOpts): HarnessWithRun {
  const tmp = mkdtempSync(join(os.tmpdir(), "minidc-v12-"));
  const storeOwned = !opts.storeDir;
  const store = opts.storeDir ?? mkdtempSync(join(os.tmpdir(), "minidc-v12-store-"));
  if (!opts.skipRules) {
    mkdirSync(join(tmp, ".pi"), { recursive: true });
    writeFileSync(join(tmp, ".pi", "mini-dc-rules.yaml"), opts.rulesYaml ?? RULES_YAML);
  }
  execSync(`git init -q ${JSON.stringify(tmp)}`);
  const h: Harness = {
    result: "unset",
    customCalls: 0,
    abortCalls: 0,
    entries: [],
    dialogs: [],
    commands: {},
    notifies: [],
    statuses: [],
    tmp,
    store,
    storeOwned,
  };
  const slug = resolveRepoSlug(
    execSync(`git -C ${JSON.stringify(tmp)} rev-parse --show-toplevel`, { encoding: "utf8" }).trim(),
  );
  // Seams MUST be pointed at this harness's scratch BEFORE seeding/grants — otherwise the
  // seed lands in the previous test's (deleted) store. Never the real agent home.
  setEnvSourceForTesting(opts.env ?? WORKER_ENV);
  setStoreRootForTesting(store);
  if (opts.seedEntries?.length) {
    mkdirSync(join(store, slug), { recursive: true });
    for (const e of opts.seedEntries) appendTrail(slug, makeTrailEntry(e));
  }
  for (const pg of opts.preGrants ?? []) {
    const created = createGrant({ slug, seat: pg.seat, pattern: pg.pattern, via: pg.via ?? "dialog" });
    if ("error" in created) throw new Error(`preGrant failed: ${created.error}`);
  }
  const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
  const pi = {
    on: (ev: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => { handlers[ev] = fn; },
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => { h.commands[name] = def.handler; },
    appendEntry: (customType: string, data: unknown) => { h.entries.push({ customType, data }); },
  };
  const ctx = {
    cwd: tmp,
    mode: opts.mode ?? "tui",
    hasUI: (opts.mode ?? "tui") === "tui",
    ui: {
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (o: DialogOutcome) => void) => DecisionDialog, _o: unknown) => {
        return new Promise<DialogOutcome | undefined>((resolve) => {
          h.customCalls++;
          const dlg = factory(fakeTui(), {}, {}, (o: DialogOutcome) => resolve(o));
          h.dialogs.push(dlg);
          if (opts.dialogScript) opts.dialogScript(dlg);
          else { dlg.dispose(); resolve(undefined); } // safe No; never leaves a timer dangling
        });
      },
      notify: (msg: string) => { h.notifies.push(msg); },
      setStatus: (_k: string, v: string) => { h.statuses.push(v); },
    },
    abort: () => { h.abortCalls++; },
    sessionManager: { getEntries: () => [] },
  };
  setEnvSourceForTesting(opts.env ?? WORKER_ENV);
  setStoreRootForTesting(store);
  // AF1 round: global rules layer is ISOLATED — point the rules-loading path at a scratch
  // fixture that never exists so no test outcome depends on this desk's real global file.
  setGlobalRulesPathForTesting(join(tmp, "scratch-global-rules.yaml"));
  (miniDc as unknown as (p: unknown) => void)(pi);
  return {
    ...h,
    run: async () => {
      await handlers["session_start"]({}, ctx);
      if (opts.beforeToolCall) await opts.beforeToolCall(h);
      const event = opts.toolName && opts.toolName !== "bash"
        ? { toolName: opts.toolName, input: { path: opts.path ?? "" } }
        : { toolName: "bash", input: { command: opts.command ?? "" } };
      h.result = (await handlers["tool_call"](event, ctx)) as never;
      return h;
    },
  };
}

async function drive(opts: DriveOpts): Promise<Harness> {
  return await makeHarness(opts).run();
}

function cleanupHarness(h: Harness): void {
  rmSync(h.tmp, { recursive: true, force: true });
  if (h.storeOwned) rmSync(h.store, { recursive: true, force: true });
}

function harnessSlug(h: Harness): string {
  const root = execSync(`git -C ${JSON.stringify(h.tmp)} rev-parse --show-toplevel`, { encoding: "utf8" }).trim();
  return resolveRepoSlug(root);
}

// ═════════════════════════════════════════════════════════════════════════════
section("WP0 — repo-slug resolver + trail store interface");
// ═════════════════════════════════════════════════════════════════════════════

{
  const home = os.homedir();
  const pool = join(home, ".treehouse");
  check("pool path → repo slug (instance id stripped)", resolveRepoSlug(join(home, ".treehouse", "pi-E-52992b", "1", "pi-E")) === "pi-E");
  check("pool path different instance id → SAME slug (teardown/reprovision survival, F1)", resolveRepoSlug(join(home, ".treehouse", "pi-E-abc123", "3", "pi-E")) === "pi-E");
  check("pool nested slot → same slug", resolveRepoSlug(join(home, ".treehouse", "pi-E-52992b", "9", "pi-E")) === "pi-E");
  check("non-pool repo → collision-proof path-hash identity", resolveRepoSlug("/srv/code/dotfiles").startsWith("r-"));
  check("non-pool identity covers the FULL git root, never a bare basename", resolveRepoSlug("/srv/a/dotfiles") !== resolveRepoSlug("/srv/b/dotfiles"));
  check("same-basename different-repo pinned (never bare basename)", resolveRepoSlug("/srv/teamone/website", { poolBase: pool }) !== resolveRepoSlug("/srv/teamtwo/website", { poolBase: pool }));
  check("explicit poolBase override agrees with the default", resolveRepoSlug(join(home, ".treehouse", "pi-E-52992b", "1", "pi-E"), { poolBase: pool }) === "pi-E");
  check("sha16 is deterministic 16-hex", sha16("abc").length === 16 && /^[0-9a-f]{16}$/.test(sha16("abc")));
}

{
  const store = mkdtempSync(join(os.tmpdir(), "minidc-v12-trail-"));
  setStoreRootForTesting(store);
  const t0: TrailEntry = makeTrailEntry({ actor: "captain", decision: "proceed", scope: "once", cls: "D", task: "task-x", pane: "wX:p1" });
  check("appendTrail writes + readTrail returns the entry", appendTrail("slugA", t0) && (readTrail("slugA")?.length ?? 0) === 1);
  check("trail is append-only JSONL with R5 schema-complete fields", (() => {
    const raw = readFileSync(join(store, "slugA", "trail.jsonl"), "utf8").trim().split("\n")[0];
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return ["v", "ts", "actor", "pane", "task", "subject", "cls", "decision", "scope"].every((k) => k in obj);
  })());
  check("absent trail reads as empty (PRIOR line absent)", (readTrail("never-wrote") ?? []).length === 0);
  mkdirSync(join(store, "corrupt"), { recursive: true });
  writeFileSync(join(store, "corrupt", "trail.jsonl"), "{\"v\":1,\"ts\":\"x\"\nnot json at all\n");
  check("corrupt trail reads as null → PRIOR degrades to absent line (never guessed)", readTrail("corrupt") === null);
  rmSync(store, { recursive: true, force: true });
}

{
  // Multiprocess append: 6 concurrent child processes × 12 appends each — lock-serialized,
  // no lost or interleaved lines.
  const store = mkdtempSync(join(os.tmpdir(), "minidc-v12-mp-"));
  setStoreRootForTesting(store);
  const childSrc = join(store, "mp-child.mjs");
  writeFileSync(childSrc, [
    `const mod = await import(${JSON.stringify(MODULE_PATH)});`,
    `mod.setStoreRootForTesting(process.env.MP_ROOT);`,
    `for (let i = 0; i < 12; i++) {`,
    `  const ok = mod.appendTrail("mp", { v: 1, ts: new Date().toISOString(), actor: "gate", pane: "p", task: "t", subject: "s", cls: "G", decision: "deny", scope: "none" });`,
    `  if (!ok) process.exit(3);`,
    `}`,
    `process.exit(0);`,
    "",
  ].join("\n"));
  const kids = Array.from({ length: 6 }, () =>
    spawn(process.execPath, ["--experimental-strip-types", childSrc], {
      env: { ...process.env, MP_ROOT: store },
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  const codes = await Promise.all(kids.map((k) => new Promise<number>((res) => k.on("exit", (c) => res(c ?? -1)))));
  const lines = readFileSync(join(store, "mp", "trail.jsonl"), "utf8").trim().split("\n");
  const allParsed = lines.every((l) => { try { const o = JSON.parse(l) as unknown; return typeof o === "object" && o !== null; } catch { return false; } });
  check("6 concurrent processes × 12 appends → all children exit 0", codes.every((c) => c === 0));
  check("multiprocess appends serialize — no lost or interleaved lines (72 valid JSONL)", lines.length === 72 && allParsed);
  rmSync(store, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════════
section("WP1 — authoritative read-only command engine");
// ═════════════════════════════════════════════════════════════════════════════

{
  const reads = [
    "git status", "git log --oneline -5", "git diff HEAD~1", "git show abc123",
    "ls -la", "cat /etc/hostname", "grep -rn needle .", "rg pattern src/",
    "git branch --contains main", "git branch -a", "git remote -v",
    "git config --get user.name", "git symbolic-ref HEAD", "gh pr view 5",
    "gh pr checks 5", "gh run list", "bd list", "bd show 12", "npm view pi-coding-agent",
    "find . -name '*.ts'", "echo hello", "wc -l file.txt", "jq . pkg.json",
  ];
  check("read-only allowlist positives route R", reads.every((c) => classifyBashCommand(c).cls === "R"));
  const writes = [
    "touch newfile", "rm -rf build", "echo hi > out.txt", "git commit -m x",
    "sed -i 's/a/b/' f", "npm install", "npm test", "npm run build", "node script.js",
    "bash -c 'ls'", "sudo ls", "python3 -c 'print(1)'", "git checkout -b feature",
    "git branch -D side", "git branch newbranch", "dd if=a of=b", "FOO=1 ls",
    "cat f > g", "cmd1 && cmd2", "a | b", "$(whoami)", "`ls`", "mkdir newdir",
  ];
  check("write-never-R pinned: every write-capable/composed/wrapped form fails closed to G", writes.every((c) => classifyBashCommand(c).cls === "G"));
  check("npm-test-class = G explicitly (workspace-write)", classifyBashCommand("npm test").cls === "G");
  const dForms = [
    "git push origin main", "git merge feature", "git rebase main", "git reset --hard HEAD~1",
    "gh pr merge 41", "npm publish", "cargo publish", "scp f host:dest", "rsync -a src host:dest",
    "ssh-add ~/.ssh/id_ed25519", "gh auth token",
  ];
  check("D-forms (push/merge/publish/credentials) route D", dForms.every((c) => classifyBashCommand(c).cls === "D"));
  // F2 (review): argv-order/quoting D forms — token-normalized net catches what the
  // word-adjacent regexes miss. Counterexamples pinned verbatim from the review report.
  const f2Forms = [
    "git -C /tmp/repo push origin main",
    "git 'push' origin main",
    "git pu\\sh origin main",
    "gh pr -R owner/repo merge 5",
  ];
  check("F2: token-normalized D forms route D (the four reviewer counterexamples)", f2Forms.every((c) => classifyBashCommand(c).cls === "D"));
  check("F2 net is equality-token, not substring: benign args stay out", classifyBashCommand("git log --grep=merge").cls === "R" && classifyBashCommand("git log grep-merge.txt").cls === "R");
  check("O1 fold: env-assembled push token routes D (de-env variant)", classifyBashCommand("git pu\"$X\"sh origin main").cls === "D");
  check("fail-closed-on-unknown pinned", classifyBashCommand("frobnicate --depth 9").cls === "G" && classifyBashCommand("").cls === "G");
  check("git -c config-override wrapper fails closed (substituted config)", classifyBashCommand("git -c x=y log").cls === "G");
  check("rule-pinned class D honored", classifyBashCommand("rotate-creds --force", { ruleClass: "D" }).cls === "D");
  check("secret-path reads demoted to G (never ride the supervisor-approvable R lane)", classifyBashCommand("cat ~/.env", { zeroAccessPaths: ["~/.env*"] }).cls === "G");
  check("D beats R even for a read-looking variant (git push is never R)", classifyBashCommand("git push --dry-run").cls === "D");
  check("find . -name '*.ts' stays R; mutation flags stay G", classifyBashCommand("find . -name '*.ts'").cls === "R" && classifyBashCommand("find . -fprint /tmp/out.txt").cls === "G");
  // F3 (review): reflog narrowing + -fls + fsck --lost-found — the write-capable forms the
  // report named, pinned verbatim as G; the read forms stay R.
  check("F3: reflog write-capable sub-subcommands route G", classifyBashCommand("git reflog expire --expire=now --all").cls === "G" && classifyBashCommand("git reflog delete HEAD@{1}").cls === "G");
  check("F3: reflog read forms stay R", classifyBashCommand("git reflog").cls === "R" && classifyBashCommand("git reflog show").cls === "R" && classifyBashCommand("git reflog list").cls === "R");
  check("F3: find -fls routes G (writes/truncates the named file)", classifyBashCommand("find . -fls /tmp/out.txt").cls === "G");
  check("F3: fsck --lost-found routes G; bare fsck stays R", classifyBashCommand("git fsck --lost-found").cls === "G" && classifyBashCommand("git fsck").cls === "R");
  check("isReadOnlyAllowlisted agrees with the classifier's R lane", isReadOnlyAllowlisted("git log --oneline") && !isReadOnlyAllowlisted("npm test"));
}

{
  const root = "/home/vladi/firstmate/data/task-x";
  check("enumerated steering-G: composed read-only query", isEnumeratedSteeringG("git log --oneline -5 | head") === true);
  check("enumerated steering-G: scratch write into the task-data tree", isEnumeratedSteeringG(`echo status >> ${root}/notes.txt`) === true);
  check("enumerated steering-G: mkdir -p under task data", isEnumeratedSteeringG(`mkdir -p ${root}/scratch`) === true);
  check("enumerated steering-G: cp/mv into the scratch tree", isEnumeratedSteeringG(`cp /tmp/report.md ${root}/report.md`) === true);
  check("NOT enumerated: write outside the task-data tree", isEnumeratedSteeringG("echo x >> /tmp/elsewhere.txt") === false);
  check("NOT enumerated: rm (never in the discretion zone)", isEnumeratedSteeringG(`rm ${root}/notes.txt`) === false);
  check("NOT enumerated: composed with a non-read stage", isEnumeratedSteeringG("npm test | tee log") === false);
  check("NOT enumerated: quoting + pipes fail closed", isEnumeratedSteeringG('echo "a|b" | wc') === false);
}

// ═════════════════════════════════════════════════════════════════════════════
section("WP2 — decision header, degradation law, asker-claim isolation");
// ═════════════════════════════════════════════════════════════════════════════

{
  check("seat derivation: FM_TASK_ID → worker (trusted invocation path)", resolveSeat({ FM_TASK_ID: "t" }) === "worker");
  check("seat derivation: FM_SUPERVISOR=1 → firstmate", resolveSeat({ FM_SUPERVISOR: "1" }) === "firstmate");
  check("seat derivation: bare pane → captain", resolveSeat({}) === "captain");
  check("seat ignores worker-writable channel values (never files/args/prompt)", resolveSeat({ FM_SUPERVISOR: "0", FM_TASK_ID: "" }) === "captain");

  const ansi = sanitizeAskerText("legit\x1b[31mEVIL");
  check("asker-claim isolation: ANSI escapes stripped", ansi !== undefined && ansi.includes("EVIL") && !ansi.includes("\x1b"));
  const multi = sanitizeAskerText("line1\nline2\r\nline3");
  check("asker-claim isolation: multiline flattened to one line", multi !== undefined && !multi.includes("\n") && multi === "line1 line2 line3");
  check("asker-claim isolation: control chars neutralized + capped", (sanitizeAskerText("a\x00b\x07c" + "x".repeat(400)) ?? "").length <= 160);
  check("empty/whitespace purpose → undefined (line may vanish cleanly)", sanitizeAskerText("   ") === undefined);

  const binding = resolveTaskBinding(WORKER_ENV, null);
  check("task binding ok with task env + no contradicting trail", binding.state === "ok" && binding.taskId === "task-x");
  check("task binding unknown without FM_TASK_ID (features disabled, never guessed)", resolveTaskBinding({}, null).state === "unknown");
  check("task binding stale when the pane's trail shows a different task", resolveTaskBinding(
    { ...WORKER_ENV },
    [makeTrailEntry({ pane: "wX:p9", task: "task-old" })],
  ).state === "stale");
  check("other panes' trail entries never stale this pane", resolveTaskBinding(
    { ...WORKER_ENV },
    [makeTrailEntry({ pane: "wX:OTHER", task: "task-old" })],
  ).state === "ok");

  const trail: TrailEntry[] = [
    makeTrailEntry({ task: "task-x", decision: "proceed", actor: "firstmate", ts: new Date(Date.now() - 600_000).toISOString() }),
    makeTrailEntry({ task: "task-x", decision: "proceed", actor: "firstmate" }),
    makeTrailEntry({ task: "task-x", decision: "deny", actor: "firstmate", message: "not now" }),
  ];
  const prior = composePriorLine(trail, "task-x", Date.now(), "worker");
  check("PRIOR composes same-task counts with actor + age", !!prior && prior.includes("3 asks") && prior.includes("2 answered by firstmate") && prior.includes("1 denied with message"));
  const priorCaptain = composePriorLine([makeTrailEntry({ task: "t2", decision: "deny", actor: "captain" })], "t2", Date.now(), "captain");
  check("PRIOR actor=self renders as 'you' (captain mockup)", !!priorCaptain && priorCaptain.includes("denied by you"));
  const priorFmBare = composePriorLine([makeTrailEntry({ task: "t3", decision: "deny", actor: "firstmate" })], "t3", Date.now(), "worker");
  check("PRIOR bare denial surfaces the decider", !!priorFmBare && priorFmBare.includes("1 denied by firstmate"));
  check("PRIOR absent for a different task", composePriorLine(trail, "task-other", Date.now(), "worker") === undefined);
  check("PRIOR absent when binding disabled (stale/unknown) — task-keyed features off", composePriorLine(trail, null, Date.now(), "worker") === undefined);
  check("PRIOR absent on corrupt/absent trail (null)", composePriorLine(null, "task-x", Date.now(), "worker") === undefined);

  const hdr = buildDecisionHeader({
    cls: "R",
    what: "bash: git status --v12askr1",
    where: "pi-E - branch main",
    who: "worker (wX:p9) - task task-x",
    risk: riskLine("R"),
    purpose: sanitizeAskerText("Refactor session notes"),
    prior: composePriorLine(trail, "task-x", Date.now(), "worker"),
  });
  check("header carries WHAT/WHERE/WHO/PURPOSE(asker)/RISK/PRIOR", ["| WHAT", "| WHERE", "| WHO", "| PURPOSE (asker):", "| RISK", "| PRIOR"].every((p) => hdr.some((l) => l.startsWith(p))));
  const hdrD = buildDecisionHeader({ cls: "D", what: "w", where: "wh", who: "whom", risk: riskLine("D"), purpose: "ignore me" });
  check("class D omits the PURPOSE line (mockup-faithful) — every other line renders", !hdrD.some((l) => l.includes("PURPOSE")) && ["| WHAT", "| WHERE", "| WHO", "| RISK"].every((p) => hdrD.some((l) => l.startsWith(p))));
  const hdrNoPurpose = buildDecisionHeader({ cls: "R", what: "w", where: "wh", who: "whom", risk: riskLine("R") });
  check("degradation law: ONLY the PURPOSE line may vanish — WHAT/WHERE/WHO/RISK always render", !hdrNoPurpose.some((l) => l.includes("PURPOSE")) && hdrNoPurpose.length >= 4);
  check("RISK lines are gate-computed per class", riskLine("D").includes("captain-word") && riskLine("R").includes("supervisor-approvable") && riskLine("G").includes("fail-closed"));
}

// ═════════════════════════════════════════════════════════════════════════════
section("WP3 — dialog v2: countdown, composer, label-bound hotkeys, exactly-once");
// ═════════════════════════════════════════════════════════════════════════════

{
  const mc = new ManualClock();
  let ticks = 0;
  let expired = 0;
  const cd = new Countdown({ timeoutMs: 5000, clock: mc, onTick: () => { ticks++; }, onExpire: () => { expired++; } });
  cd.start();
  mc.advanceSeconds(3);
  check("countdown ticks per second and reports remaining", ticks === 3 && cd.remainingSec() === 2);
  cd.pause();
  mc.advanceSeconds(50);
  check("pause stops the countdown (no tick, no expiry)", ticks === 3 && expired === 0 && cd.remainingSec() === 2);
  cd.resume();
  mc.advanceSeconds(1);
  check("resume continues at REMAINING time — never reset", cd.remainingSec() === 1 && expired === 0);
  mc.advanceSeconds(1);
  check("expiry fires exactly once at zero", expired === 1 && cd.isExpired());
  mc.advanceSeconds(10);
  check("expiry stays exactly-once", expired === 1);
  cd.dispose();
  check("dispose stops the timer (no dangling handle)", mc.pending() === 0);
}

{
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const outcomes: DialogOutcome[] = [];
  const dlg = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x", "| RISK y"],
    detailLines: ["d1"],
    options: buildDialogOptions("R", "worker", null),
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes.push(o),
    clock: mc,
  });
  mc.advanceSeconds(179);
  check("unanswered 179s → still open, park not yet fired", outcomes.length === 0);
  mc.advanceSeconds(1);
  check("unanswered 180s window → PARK outcome (timeout distinct from deny)", outcomes.length === 1 && outcomes[0].kind === "park");
  dlg.handleInput("y");
  check("exactly-once: input after settle is ignored", outcomes.length === 1);
  dlg.dispose();
  check("dispose after settle leaves no timer", mc.pending() === 0);
  setDialogClockForTesting(null);
}

{
  const mc = new ManualClock();
  const outcomes: DialogOutcome[] = [];
  const dlg = new DecisionDialog({
    cls: "G",
    headerLines: ["| WHAT x"],
    detailLines: [],
    options: buildDialogOptions("G", "captain", null),
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes.push(o),
    clock: mc,
  });
  mc.advanceSeconds(50); // remaining 130
  dlg.handleInput("a"); // enter composer
  check("composer opens and PAUSES the countdown", renderText(dlg).includes("countdown paused"));
  mc.advanceSeconds(120);
  check("paused countdown neither ticks nor expires (130s remaining preserved)", outcomes.length === 0 && renderText(dlg).includes("130s"));
  for (const ch of "not on my watch") dlg.handleInput(ch);
  dlg.handleInput("\x7f"); // backspace
  dlg.handleInput(KEY_ESC); // nested-Esc layer 1: back to options
  check("nested-Esc: first Esc leaves the composer WITHOUT settling", outcomes.length === 0 && renderText(dlg).includes("[y]"));
  mc.advanceSeconds(129);
  check("countdown resumed at REMAINING (1s left after 129 more ticks — no reset)", outcomes.length === 0);
  mc.advanceSeconds(1);
  check("resumed countdown expires exactly at remaining time → park", outcomes.length === 1 && outcomes[0].kind === "park");
  dlg.dispose();
}

{
  const mc = new ManualClock();
  const outcomes: DialogOutcome[] = [];
  const dlg = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x"],
    detailLines: [],
    options: buildDialogOptions("R", "captain", null),
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes.push(o),
    clock: mc,
  });
  dlg.handleInput("a");
  for (const ch of "because reasons") dlg.handleInput(ch);
  dlg.handleInput(KEY_ENTER);
  check("non-empty composer Enter → block WITH message, exactly once", outcomes.length === 1 && outcomes[0].kind === "block" && outcomes[0].message === "because reasons");
  dlg.dispose();

  const outcomes2: DialogOutcome[] = [];
  const dlg2 = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x"],
    detailLines: [],
    options: buildDialogOptions("R", "captain", null),
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes2.push(o),
    clock: mc,
  });
  dlg2.handleInput("a");
  dlg2.handleInput(KEY_ENTER);
  check("empty composer Enter → plain deny (safe, deterministic)", outcomes2.length === 1 && outcomes2[0].kind === "block" && outcomes2[0].message === undefined);
  dlg2.dispose();
}

{
  // Hotkeys bind to option identity, never row positions: reorder rows, semantics hold.
  const reordered = [
    { id: "proceed" as const, key: "y", label: "Yes" },
    { id: "block" as const, key: "n", label: "No" },
    { id: "session" as const, key: "s", label: "Yes, session" },
  ];
  const outcomes: DialogOutcome[] = [];
  const dlg = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x"],
    detailLines: [],
    options: reordered,
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes.push(o),
    clock: new ManualClock(),
  });
  dlg.handleInput("s");
  check("reordered: 's' still means session-scope proceed", outcomes[0]?.kind === "proceed" && outcomes[0]?.sessionScope === true);
  dlg.dispose();

  const outcomes2: DialogOutcome[] = [];
  const dlg2 = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x"],
    detailLines: [],
    options: reordered,
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes2.push(o),
    clock: new ManualClock(),
  });
  dlg2.handleInput("n");
  check("reordered: 'n' still means block", outcomes2[0]?.kind === "block");
  dlg2.dispose();

  const outcomes3: DialogOutcome[] = [];
  const dlg3 = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x"],
    detailLines: [],
    options: buildDialogOptions("R", "captain", "git log *"),
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes3.push(o),
    clock: new ManualClock(),
  });
  dlg3.handleInput("g");
  check("grant hotkey carries the gate-derived pattern (never asker text)", outcomes3[0]?.kind === "proceed" && outcomes3[0]?.grant?.pattern === "git log *" && outcomes3[0]?.grant?.classFilter === "R");
  dlg3.dispose();
}

{
  const mc = new ManualClock();
  const outcomes: DialogOutcome[] = [];
  const dlg = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x", "| RISK y"],
    detailLines: ["full command here"],
    options: buildDialogOptions("R", "worker", null),
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes.push(o),
    clock: mc,
  });
  check("render carries the decision-context header lines", renderText(dlg).includes("| WHAT") && renderText(dlg).includes("| RISK"));
  const detailHidden = !renderText(dlg).includes("full command here");
  dlg.handleInput("d");
  check("detail hidden by default, toggled with d", detailHidden && renderText(dlg).includes("full command here"));
  dlg.handleInput("d");
  dlg.handleInput(KEY_ESC);
  check("Esc = block (preserved contract)", outcomes[0]?.kind === "block");
  dlg.dispose();

  const outcomes2: DialogOutcome[] = [];
  const dlg2 = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x"],
    detailLines: [],
    options: buildDialogOptions("R", "worker", null),
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes2.push(o),
    clock: mc,
  });
  dlg2.handleInput("y");
  check("y = proceed (preserved contract)", outcomes2[0]?.kind === "proceed");
  dlg2.dispose();

  const outcomes3: DialogOutcome[] = [];
  const dlg3 = new DecisionDialog({
    cls: "R",
    headerLines: ["| WHAT x"],
    detailLines: [],
    options: buildDialogOptions("R", "worker", null),
    timeoutMs: 180000,
    tui: fakeTui(),
    onResult: (o) => outcomes3.push(o),
    clock: mc,
  });
  dlg3.handleInput("n");
  check("n = block (preserved contract)", outcomes3[0]?.kind === "block");
  dlg3.dispose();
  check("repeated open/close: all timers disposed, no dangling handles", mc.pending() === 0);
}

{
  const rowsD = buildDialogOptions("D", "captain", "git push *");
  check("class D captain: proceed row renders, no session/grant rows ever (D-never-scope)", rowsD.some((r) => r.id === "proceed") && !rowsD.some((r) => r.id === "session" || r.id === "grant"));
  const rowsDWorker = buildDialogOptions("D", "worker", "git push *");
  const rowsDFirstmate = buildDialogOptions("D", "firstmate", "git push *");
  check("F1: class D at non-captain seats renders [block, compose] ONLY — no proceed row", rowsDWorker.length === 2 && rowsDWorker.every((r) => r.id === "block" || r.id === "compose") && rowsDFirstmate.length === 2 && rowsDFirstmate.every((r) => r.id === "block" || r.id === "compose"));
  const rowsRCaptain = buildDialogOptions("R", "captain", "git log *");
  check("R + captain answerer: session + grant rows render", rowsRCaptain.some((r) => r.id === "session") && rowsRCaptain.some((r) => r.id === "grant"));
  const rowsRFirstmate = buildDialogOptions("R", "firstmate", "git log *");
  check("R + firstmate-relay answerer: worker-session label + grant row", rowsRFirstmate.some((r) => r.id === "session" && r.label.includes("worker session")) && rowsRFirstmate.some((r) => r.id === "grant"));
  const rowsRWorker = buildDialogOptions("R", "worker", "git log *");
  check("R + crewmate-drivable pane: NO scope rows (C5)", !rowsRWorker.some((r) => r.id === "session" || r.id === "grant"));
  const rowsGCaptain = buildDialogOptions("G", "captain", null);
  check("G + captain: session row renders (C6 captain panes only), grant row never", rowsGCaptain.some((r) => r.id === "session") && !rowsGCaptain.some((r) => r.id === "grant"));
  const rowsGFmEnum = buildDialogOptions("G", "firstmate", null, true);
  check("G + firstmate ENUMERATED steering: proceed row renders, no scope rows", rowsGFmEnum.some((r) => r.id === "proceed") && !rowsGFmEnum.some((r) => r.id === "session" || r.id === "grant"));
  const rowsGFm = buildDialogOptions("G", "firstmate", null, false);
  check("F1: G + firstmate non-enumerated renders [block, compose] ONLY", rowsGFm.length === 2 && rowsGFm.every((r) => r.id === "block" || r.id === "compose"));
  check("G + worker: no scope rows", !buildDialogOptions("G", "worker", null).some((r) => r.id === "session" || r.id === "grant"));
  check("grant rows are R-only (never-D structural)", !buildDialogOptions("G", "captain", "x *").some((r) => r.id === "grant") && !buildDialogOptions("D", "captain", "x *").some((r) => r.id === "grant"));
}

// ═════════════════════════════════════════════════════════════════════════════
section("WP4 — grants store + protection");
// ═════════════════════════════════════════════════════════════════════════════

{
  const store = mkdtempSync(join(os.tmpdir(), "minidc-v12-grants-"));
  setStoreRootForTesting(store);
  check("workers never create grants (Q3)", "error" in (createGrant({ slug: "s", seat: "worker", pattern: "git log *", via: "dialog" }) as { error: string }));
  check("firstmate creates R-class grants via the answer SURFACE only (Q3)", "error" in (createGrant({ slug: "s", seat: "firstmate", pattern: "git log *", via: "dialog" }) as { error: string }));
  const fmGrant = createGrant({ slug: "s", seat: "firstmate", pattern: "git log *", via: "surface" });
  check("firstmate surface grant (R-class) accepted", !("error" in fmGrant));
  const capGrant = createGrant({ slug: "s", seat: "captain", pattern: "cat /var/log/*", via: "dialog" });
  check("captain dialog grant accepted", !("error" in capGrant));
  const grants = loadGrants("s");
  check("grants persist to the agent-home store layout with the full schema", grants.length === 2 && ["id", "created-at", "creator-seat", "pattern", "class-filter"].every((k) => k in grants[0]));
  check("grant class-filter is structurally R (never-D)", grants.every((g) => (g as Grant)["class-filter"] === "R"));
  check("empty pattern refused", "error" in (createGrant({ slug: "s", seat: "captain", pattern: "  ", via: "dialog" }) as { error: string }));
  check("matchGrant prefix-glob matches (with args, not another shape)", matchGrant("s", "git log --oneline -5", "R") !== null && matchGrant("s", "git status", "R") === null);
  check("never-D filter: no grant matches G or D asks", matchGrant("s", "git log --oneline", "G") === null && matchGrant("s", "git log --oneline", "D") === null);
  check("revoke removes by id; unknown id refused", revokeGrant("s", (capGrant as Grant).id) && loadGrants("s").length === 1 && revokeGrant("s", "nope") === false);
  check("deriveGrantPattern is gate-derived from the command (git → sub-scoped)", deriveGrantPattern("git log --oneline -5") === "git log *" && deriveGrantPattern("cat x.txt") === "cat *");
  rmSync(store, { recursive: true, force: true });
}

{
  section("WP4 store protection — three worker attack shapes through the real gate");
  const store1 = mkdtempSync(join(os.tmpdir(), "minidc-v12-prot-"));
  const grantsPath = join(store1, "someRepo", "grants.yaml");
  // shape 1: write tool at the grants file (harness store root = the attacked store)
  const hWrite = await drive({ toolName: "write", path: grantsPath, env: WORKER_ENV, mode: "json", storeDir: store1 });
  check("tool attack: worker write at grants.yaml DENIED (privileged store)", R(hWrite).block === true && (R(hWrite).reason ?? "").includes("privileged mini-dc store"));
  check("tool attack: denial logged with the protection rule", hWrite.entries.some((e) => e.customType === "mini-dc-log" && String((e.data as { rule?: string }).rule ?? "").includes("protected store")));
  cleanupHarness(hWrite);
  // shape 2: edit tool at the trail
  const hEdit = await drive({ toolName: "edit", path: join(store1, "someRepo", "trail.jsonl"), env: WORKER_ENV, mode: "json", storeDir: store1 });
  check("file attack: worker edit of trail.jsonl DENIED", R(hEdit).block === true && (R(hEdit).reason ?? "").includes("privileged mini-dc store"));
  cleanupHarness(hEdit);
  // shape 3: shell redirect + rm
  const hShellR = await drive({ command: `echo forged > ${JSON.stringify(grantsPath)}`, env: WORKER_ENV, mode: "json", storeDir: store1 });
  check("shell attack: worker redirect into grants.yaml DENIED", R(hShellR).block === true && (R(hShellR).reason ?? "").includes("privileged mini-dc store"));
  cleanupHarness(hShellR);
  const hShellD = await drive({ command: `rm -rf ${JSON.stringify(store1)}`, env: WORKER_ENV, mode: "json", storeDir: store1 });
  check("shell attack: worker rm of the store DENIED", R(hShellD).block === true);
  cleanupHarness(hShellD);
  const hCap = await drive({ toolName: "write", path: grantsPath, env: CAPTAIN_ENV, mode: "json", storeDir: store1 });
  check("captain seat is NOT store-denied (captain-managed store)", R(hCap).block === false);
  cleanupHarness(hCap);
  rmSync(store1, { recursive: true, force: true });
}

{
  section("WP4 /dc-grants command surface");
  const h = await drive({ command: "unused", env: WORKER_ENV });
  cleanupHarness(h);
  const store = mkdtempSync(join(os.tmpdir(), "minidc-v12-cmd-"));
  setStoreRootForTesting(store);
  setEnvSourceForTesting(WORKER_ENV);
  // reuse the SAME registered handlers from h for command-surface checks (fresh init below)
  const mk = makeHarness({ command: "unused", env: WORKER_ENV });
  const hh = await mk.run();
  const grantStubUi = { notify: (m: string) => { hh.notifies.push(m); }, setStatus: (_k: string, _v: string) => {} };
  setEnvSourceForTesting(WORKER_ENV);
  await hh.commands["dc-grants"]("", { cwd: hh.tmp, ui: grantStubUi });
  check("worker seat cannot list or revoke via /dc-grants", hh.notifies.some((n) => n.includes("captain-managed")));
  const slug = harnessSlug(hh);
  setEnvSourceForTesting(CAPTAIN_ENV);
  const g = createGrant({ slug, seat: "captain", pattern: "git log *", via: "dialog" }) as Grant;
  setEnvSourceForTesting(WORKER_ENV);
  await hh.commands["dc-grants"](`revoke ${g.id}`, { cwd: hh.tmp, ui: grantStubUi });
  check("worker revoke attempt refused — grant survives", hh.notifies.some((n) => n.includes("captain-managed")) && loadGrants(slug).length === 1);
  setEnvSourceForTesting(CAPTAIN_ENV);
  await hh.commands["dc-grants"]("revoke nope", { cwd: hh.tmp, ui: grantStubUi });
  check("revoke of unknown id reports and changes nothing", hh.notifies.some((n) => n.includes("no such grant")) && loadGrants(slug).length === 1);
  await hh.commands["dc-grants"](`revoke ${g.id}`, { cwd: hh.tmp, ui: grantStubUi });
  check("captain revoke removes the grant", loadGrants(slug).length === 0);
  cleanupHarness(hh);
  rmSync(store, { recursive: true, force: true });
}

// ═════════════════════════════════════════════════════════════════════════════
section("WP5 — authorization matrix + worker-G parking");
// ═════════════════════════════════════════════════════════════════════════════

{
  const q = (cls: "D" | "R" | "G", seat: "captain" | "firstmate" | "worker", enumerated: boolean, answer: "proceed" | "session" | "grant" | "deny") =>
    resolveDecisionMatrix({ cls, answerSeat: seat, enumeratedSteering: enumerated, answer });
  check("D rejects firstmate answers ALWAYS", q("D", "firstmate", false, "proceed").allowed === false);
  check("D rejects worker answers", q("D", "worker", false, "proceed").allowed === false);
  check("D captain explicit proceed/deny honored", q("D", "captain", false, "proceed").allowed && q("D", "captain", false, "deny").allowed && q("D", "captain", false, "deny").effect === "deny");
  check("D never takes session scope or grants — even from the captain", q("D", "captain", false, "session").allowed === false && q("D", "captain", false, "grant").allowed === false);
  check("class R proceeds for firstmate (supervisor-approvable)", q("R", "firstmate", false, "proceed").allowed && q("R", "firstmate", false, "deny").allowed);
  check("enumerated steering-class G proceeds for firstmate", q("G", "firstmate", true, "proceed").allowed && q("G", "firstmate", true, "deny").allowed);
  check("enumerated steering-G carries NO scope discretion for firstmate", q("G", "firstmate", true, "session").allowed === false && q("G", "firstmate", true, "grant").allowed === false);
  check("non-enumerated G PARKS for firstmate (never answered)", q("G", "firstmate", false, "proceed").allowed === false && q("G", "firstmate", false, "proceed").effect === "park");
  check("G session scope: captain panes only (C6); grants are R-only for everyone", q("G", "captain", false, "session").allowed === true && q("G", "captain", false, "grant").allowed === false);
  check("worker pane R: proceed/deny allowed (preserved pane keys)", q("R", "worker", false, "proceed").allowed && q("R", "worker", false, "deny").allowed);
  check("worker pane scope rows never (C5)", q("R", "worker", false, "session").allowed === false && q("R", "worker", false, "grant").allowed === false);
  check("F1 probe: worker pane non-enumerated G proceed → PARK (never proceeds)", q("G", "worker", false, "proceed").allowed === false && q("G", "worker", false, "proceed").effect === "park");
  check("worker pane non-enumerated G deny is always safe", q("G", "worker", false, "deny").allowed === true && q("G", "worker", false, "deny").effect === "deny");
  check("worker pane enumerated steering-G proceed allowed", q("G", "worker", true, "proceed").allowed === true);
  check("R grants allowed for firstmate (supervisor-approvable class)", q("R", "firstmate", false, "grant").allowed === true);
}

{
  section("WP5 parking e2e — keyed state in abort AND continue modes, retry, timeout ≠ deny");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "v12askg42 --now",
    env: WORKER_ENV,
    dialogScript: () => { mc.advanceSeconds(180); }, // unanswered → park
  });
  const slug = harnessSlug(h);
  const parkRecs = h.entries.filter((e) => e.customType === "mini-dc-park");
  check("timeout parks with a supervisor-readable keyed-blocked state", parkRecs.length === 1 && typeof (parkRecs[0].data as { key?: string }).key === "string" && (parkRecs[0].data as { key?: string }).key!.startsWith(`${slug}::`));
  check("park record carries class + task + seat + mode (leg-2 readable)", (parkRecs[0].data as { cls?: string }).cls === "G" && (parkRecs[0].data as { task?: string }).task === "task-x" && (parkRecs[0].data as { seat?: string }).seat === "worker");
  check("park reason wording stays distinct from deny (parked, re-attempt guidance)", (R(h).reason ?? "").includes("(parked)") && (R(h).reason ?? "").includes("re-attempt"));
  check("park decision lands in the trail (actor=gate)", (readTrail(slug) ?? []).some((t) => t.decision === "park" && t.actor === "gate"));
  check("abort mode: park emits AND abort fires", h.abortCalls === 1);
  cleanupHarness(h);

  // continue mode via the REAL /dc-mode toggle — ctx.mode stays "tui" (it is pi's UI mode,
  // not the gate's abort/continue toggle; conflating them correctly reads as headless).
  const h2 = await makeHarness({
    command: "v12askg43 --now",
    env: WORKER_ENV,
    mode: "tui",
    beforeToolCall: async (hh) => {
      await hh.commands["dc-mode"]("continue", {
        cwd: hh.tmp,
        ui: { notify: (m: string) => { hh.notifies.push(m); }, setStatus: () => {} },
      });
    },
    dialogScript: () => { mc.advanceSeconds(180); },
  }).run();
  check("continue mode: park state STILL emitted, no abort", h2.entries.some((e) => e.customType === "mini-dc-park") && h2.abortCalls === 0 && R(h2).block === true && h2.notifies.some((n) => n.includes("mode → continue")));
  cleanupHarness(h2);

  const hRetry = await drive({
    command: "v12askg44 --now",
    env: WORKER_ENV,
    dialogScript: () => { mc.advanceSeconds(180); },
  });
  const firstKey = (parkRecs[0].data as { key?: string }).key ?? "";
  const retryKey = (hRetry.entries.find((e) => e.customType === "mini-dc-park")?.data as { key?: string }).key ?? "";
  check("retry after park re-raises the confirm (fresh dialog, fresh park key)", hRetry.customCalls === 1 && retryKey !== "" && retryKey !== firstKey);
  cleanupHarness(hRetry);
  setDialogClockForTesting(null);
}

// ═════════════════════════════════════════════════════════════════════════════
section("WP6 — session scopes");
// ═════════════════════════════════════════════════════════════════════════════

{
  check("session scope requires EXPLICIT session identity (never guessed)", recordSessionScope(undefined, "p", "R") === false);
  pruneScopesToSession(undefined);
  check("R scope recorded and matched for the owning session", recordSessionScope("s1", "gitstatus", "R") && activeSessionScope("s1", "gitstatus", "R") !== null);
  check("scope does not leak to another session", activeSessionScope("s2", "gitstatus", "R") === null);
  check("scope is class-aware", activeSessionScope("s1", "gitstatus", "G") === null);
  recordSessionScope("s1", "other", "G");
  recordSessionScope("s9", "gitstatus", "R");
  check("R eligible in captain panes too, not worker-only (WP6)", sessionScopeCount() >= 2);
  pruneScopesToSession("s1");
  check("die on session replacement: scopes of other sessions are gone", activeSessionScope("s9", "gitstatus", "R") === null && activeSessionScope("s1", "gitstatus", "R") !== null);
  pruneScopesToSession(undefined);
  check("unscoped prune clears everything", sessionScopeCount() === 0);
}

// ═════════════════════════════════════════════════════════════════════════════
section("WP7 — end-to-end integration (real gate, real dialog, real store)");
// ═════════════════════════════════════════════════════════════════════════════

{
  section("WP7.a R ask end-to-end: header lines, sanitized purpose, worker rows");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "git status --v12askr1",
    env: { ...WORKER_ENV, PI_PURPOSE: "Refactor notes\x1b[31m EVIL\nsecond line" },
    dialogScript: (dlg) => { dlg.handleInput("y"); },
  });
  const dlg = h.dialogs[0];
  const text = renderText(dlg);
  const slug = harnessSlug(h);
  check("R ask renders the decision-context header", text.includes("| WHAT") && text.includes("| WHERE") && text.includes("| WHO") && text.includes("| RISK"));
  check("WHAT is the gate-computed command (never asker text)", text.includes("bash: git status --v12askr1"));
  check("PURPOSE (asker): ANSI + newline injection sanitized into one claim line", text.includes("PURPOSE (asker): Refactor notes EVIL second line") && !text.includes("Refactor notes\x1b"));
  check("PRIOR line absent on empty trail (degradation, not fabrication)", !text.includes("| PRIOR"));
  check("WHERE carries the resolved repo slug + branch", text.includes(`${slug} - branch`));
  check("WHO shows the pane-seat + task honestly", text.includes("worker (wX:p9) - task task-x"));
  check("worker pane renders NO scope rows (C5)", !text.includes("[s]") && !text.includes("[g]"));
  check("dialog outcome proceed → tool allowed + trail proceed (actor=pane-seat honest fallback)", R(h).block === false && (readTrail(slug) ?? []).some((t) => t.decision === "proceed" && t.actor === "worker" && t.cls === "R"));
  check("mini-dc-log carries the classified class additively", h.entries.some((e) => e.customType === "mini-dc-log" && (e.data as { cls?: string }).cls === "R"));
  cleanupHarness(h);
  setDialogClockForTesting(null);
}

{
  section("WP7.b PRIOR + stale binding with a pre-seeded trail (deterministic)");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "v12askg7 --now",
    env: { ...WORKER_ENV, FM_TASK_ID: "task-new" },
    seedEntries: [{ pane: "wX:p9", task: "task-old", decision: "proceed", actor: "firstmate" }],
    dialogScript: () => { mc.advanceSeconds(180); }, // park — park record must carry task=null
  });
  const text = renderText(h.dialogs[0]);
  check("stale binding renders honestly in WHO (never guessed away)", text.includes("task task-new (stale binding)"));
  check("PRIOR-by-task DISABLED under stale binding (line absent)", !text.includes("| PRIOR"));
  check("header still carries WHAT/WHERE/WHO/RISK (only PURPOSE may vanish)", ["| WHAT", "| WHERE", "| WHO", "| RISK"].every((p) => text.includes(p)));
  const parkRec = h.entries.find((e) => e.customType === "mini-dc-park");
  check("park record under stale binding carries task=null (task key never guessed)", !!parkRec && (parkRec.data as { task?: string | null }).task === null);
  check("stale park still keyed for the supervisor", !!parkRec && typeof (parkRec.data as { key?: string }).key === "string");
  cleanupHarness(h);
  setDialogClockForTesting(null);
}

{
  section("WP7.c deny-with-message end-to-end");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "v12askg8 --now",
    env: WORKER_ENV,
    dialogScript: (dlg) => {
      dlg.handleInput("a");
      for (const ch of "ask firstmate next time") dlg.handleInput(ch);
      dlg.handleInput(KEY_ENTER);
    },
  });
  check("deny message rides the block reason for the agent", R(h).block === true && (R(h).reason ?? "").includes("Operator note: ask firstmate next time"));
  const slug = harnessSlug(h);
  check("deny-with-message lands in the trail (R5 message field)", (readTrail(slug) ?? []).some((t) => t.decision === "deny" && t.message === "ask firstmate next time"));
  cleanupHarness(h);
  setDialogClockForTesting(null);
}

{
  section("WP7.d D ask end-to-end: no scope rows, no PURPOSE, captain proceeds");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "git push --v12askd3",
    env: { ...CAPTAIN_ENV, PI_PURPOSE: "captain purpose should not show on D" },
    dialogScript: (dlg) => { dlg.handleInput("y"); },
  });
  const text = renderText(h.dialogs[0]);
  check("D dialog omits PURPOSE (mockup-faithful) and shows captain-word RISK", !text.includes("PURPOSE") && text.includes("captain-word"));
  check("D dialog renders no session/grant rows even for the captain", !text.includes("[s]") && !text.includes("[g]"));
  check("captain explicit y proceeds the D ask", R(h).block === false);
  const slug = harnessSlug(h);
  check("D proceed lands in the trail with class D", (readTrail(slug) ?? []).some((t) => t.cls === "D" && t.decision === "proceed" && t.actor === "captain"));
  cleanupHarness(h);
  setDialogClockForTesting(null);
}

{
  section("WP7.e grants auto-proceed (tui AND headless) — the pooled-worktree F1 story");
  const h0 = await drive({ command: "git log --v12askr4", env: WORKER_ENV, mode: "json" });
  check("headless R ask without a grant → in-band ASK→deny (preserved contract)", R(h0).block === true && (R(h0).reason ?? "").includes("headless ASK→deny") && h0.abortCalls === 0);
  cleanupHarness(h0);
  const h1 = await drive({
    command: "git log --v12askr5",
    env: WORKER_ENV,
    mode: "json",
    preGrants: [{ seat: "captain", pattern: "git log *", via: "dialog" }],
  });
  check("grant auto-proceeds the SAME read shape in HEADLESS (no dialog, no abort)", R(h1).block === false && h1.customCalls === 0 && h1.abortCalls === 0);
  const slug1 = harnessSlug(h1);
  const grantId = (loadGrants(slug1)[0] ?? { id: "" }).id;
  check("grant trail entry records actor=gate + scope=grant + grant id", (readTrail(slug1) ?? []).some((t) => t.decision === "proceed" && t.scope === "grant" && t.actor === "gate" && t.message === grantId));
  cleanupHarness(h1);
  const h2 = await drive({
    command: "git log --v12askr6",
    env: WORKER_ENV,
    mode: "tui",
    preGrants: [{ seat: "captain", pattern: "git log *", via: "dialog" }],
  });
  check("grant auto-proceeds in TUI too (no dialog)", R(h2).block === false && h2.customCalls === 0);
  cleanupHarness(h2);
  const h3 = await drive({
    command: "git push --v12askd5",
    env: WORKER_ENV,
    mode: "json",
    preGrants: [{ seat: "captain", pattern: "git log *", via: "dialog" }],
  });
  check("grant never covers other shapes or classes (prefix + R-only + never-D)", R(h3).block === true);
  cleanupHarness(h3);
}

{
  section("WP7.f session scope end-to-end: dialog-created, matched, dies on replacement");
  pruneScopesToSession(undefined);
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "git status --v12askr8",
    env: CAPTAIN_ENV,
    dialogScript: (dlg) => { dlg.handleInput("s"); }, // captain session-scope row
  });
  const text = renderText(h.dialogs[0]);
  check("captain R ask renders the session row", text.includes("[s]"));
  check("session-scope proceed allowed + recorded", R(h).block === false && activeSessionScope("sess-captain-1", "v12askr\\d*", "R") !== null);
  cleanupHarness(h);
  const h2 = await drive({ command: "git status --v12askr9", env: CAPTAIN_ENV });
  check("second ask under the same rule + session auto-proceeds (no dialog)", R(h2).block === false && h2.customCalls === 0);
  cleanupHarness(h2);
  pruneScopesToSession("some-other-session");
  const h3 = await drive({
    command: "git status --v12askr10",
    env: CAPTAIN_ENV,
    dialogScript: (dlg) => { dlg.handleInput("n"); },
  });
  check("session replacement killed the scope → the gate asks again", h3.customCalls === 1 && R(h3).block === true);
  cleanupHarness(h3);
  pruneScopesToSession(undefined);
  setDialogClockForTesting(null);
}

{
  section("WP7.g preserved contracts: deny-before-ask, path tiers, headless no-abort");
  const hDeny = await drive({
    command: "echo v12deny1x",
    env: WORKER_ENV,
    mode: "json",
  });
  check("deny rules (ask:false) block BEFORE any dialog or classification (deny-additive floor)", R(hDeny).block === true && hDeny.customCalls === 0 && (R(hDeny).reason ?? "").includes("v12 deny rule"));
  cleanupHarness(hDeny);
  const hZap = await drive({
    toolName: "write",
    path: "/secrets/file",
    rulesYaml: "zeroAccessPaths:\n  - /secrets/**\nbashToolPatterns: []\nreadOnlyPaths: []\n",
    env: WORKER_ENV,
    mode: "json",
  });
  check("path tier: zeroAccess write blocked (tier 1 unchanged)", R(hZap).block === true);
  cleanupHarness(hZap);
  const hRop = await drive({
    toolName: "write",
    path: "/lock/f",
    rulesYaml: "readOnlyPaths:\n  - /lock/**\nbashToolPatterns: []\nzeroAccessPaths: []\n",
    env: WORKER_ENV,
    mode: "json",
  });
  check("path tier: readOnly write blocked (tier 1b unchanged)", R(hRop).block === true);
  cleanupHarness(hRop);
  const hRopRead = await drive({
    toolName: "read",
    path: "/lock/f",
    rulesYaml: "readOnlyPaths:\n  - /lock/**\nbashToolPatterns: []\nzeroAccessPaths: []\n",
    env: WORKER_ENV,
    mode: "json",
  });
  check("path tier: readOnly READ still allowed (tier 1b semantics unchanged)", R(hRopRead).block === false);
  cleanupHarness(hRopRead);
}

{
  section("WP7.h headless ASK→deny + trail evidence (v1.2 additive)");
  const h = await drive({ command: "v12askg99 --now", env: WORKER_ENV, mode: "json" });
  check("headless ask denied in-band (no dialog, no abort)", R(h).block === true && h.customCalls === 0 && h.abortCalls === 0);
  const slug = harnessSlug(h);
  check("headless deny lands a trail entry (actor=gate)", (readTrail(slug) ?? []).some((t) => t.decision === "deny" && t.actor === "gate" && t.cls === "G"));
  check("log entry keeps headlessDeny + askClass fields (existing contract)", h.entries.some((e) => e.customType === "mini-dc-log" && (e.data as { headlessDeny?: boolean }).headlessDeny === true && (e.data as { askClass?: boolean }).askClass === true));
  cleanupHarness(h);
}

{
  section("WP7.i /dc-mode preserved + status carries grants/scopes additively");
  const mk = makeHarness({ command: "unused", env: WORKER_ENV });
  const h = await mk.run();
  const modeUi = { notify: (m: string) => { h.notifies.push(m); }, setStatus: (_k: string, _v: string) => {} };
  setEnvSourceForTesting(WORKER_ENV);
  await h.commands["dc-mode"]("continue", { cwd: h.tmp, ui: modeUi });
  check("/dc-mode toggle still works", h.notifies.some((n) => n.includes("mode → continue")));
  await h.commands["dc-mode"]("bogus", { cwd: h.tmp, ui: modeUi });
  check("/dc-mode usage guard preserved", h.notifies.some((n) => n.includes("Usage: /dc-mode abort|continue")));
  check("status line extended additively (grants/scopes counts)", h.statuses.some((s) => s.includes("grants") && s.includes("scopes")));
  cleanupHarness(h);
}

{
  section("WP4 store protection — F4 adversarial defeat shapes (realpath/quote/traversal/glob)");
  const store1 = mkdtempSync(join(os.tmpdir(), "minidc-v12-prot-"));
  mkdirSync(join(store1, "someRepo"), { recursive: true });
  const base = basename(store1);
  const dir = dirname(store1);

  // shape A: parent-traversal write tool — lexical prefix says mid-dir, OS resolves into the store
  const mid = mkdtempSync(join(os.tmpdir(), "minidc-v12-mid-"));
  const traversalPath = join(mid, "..", base, "someRepo", "grants.yaml");
  const hTrav = await drive({ toolName: "write", path: traversalPath, env: WORKER_ENV, mode: "json", storeDir: store1 });
  check("F4: parent-traversal write (realpath of nearest existing ancestor) DENIED", R(hTrav).block === true && (R(hTrav).reason ?? "").includes("privileged mini-dc store"));
  cleanupHarness(hTrav);
  rmSync(mid, { recursive: true, force: true });

  // shape B: quote-split inside the store base name — lexical scan misses, token strip + realpath catch
  const quotedBase = base.replace(/-(?=[^-]*$)/, "'-");
  const quotedPath = join(dir, quotedBase, "someRepo", "grants.yaml");
  const hQuote = await drive({ command: `cat ${quotedPath}`, env: WORKER_ENV, mode: "json", storeDir: store1 });
  check("F4: quote-split store path read DENIED (token dequote + realpath)", R(hQuote).block === true);
  cleanupHarness(hQuote);

  // shape C: glob form — first glob segment expands via readdir, realpath-checked
  const globPrefix = base.slice(0, base.lastIndexOf("-"));
  const hGlob = await drive({ command: `cat ${join(dir, `${globPrefix}-*`, "someRepo", "grants.yaml")}`, env: WORKER_ENV, mode: "json", storeDir: store1 });
  check("F4: glob-form store read DENIED (first-glob-segment expansion)", R(hGlob).block === true);
  cleanupHarness(hGlob);

  // shape B2: shell-escaped quote inside the store NAME (reviewer's ln -s form, escaped-quote class)
  const qStore = mkdtempSync(join(os.tmpdir(), "minidc-v12-sto're-"));
  mkdirSync(join(qStore, "someRepo"), { recursive: true });
  const escapedQ = qStore.replace("'", "'\\''"); // shell single-quote escape of the literal quote
  const hLn = await drive({ command: `ln -s ${escapedQ}/someRepo/grants.yaml ${join(os.tmpdir(), `lnk-probe-v12-${Date.now().toString(36)}`)}`, env: WORKER_ENV, mode: "json", storeDir: qStore });
  check("F4: shell-escaped quote-in-name symlink creation DENIED", R(hLn).block === true);
  cleanupHarness(hLn);
  rmSync(qStore, { recursive: true, force: true });

  // benign control: a non-store path still sails through the tier
  const hBenign = await drive({ command: `cat ${join(mid, "file.txt")}`, env: WORKER_ENV, mode: "json", storeDir: store1 });
  check("F4: token net does not over-block non-store reads", R(hBenign).block === false);
  cleanupHarness(hBenign);
  rmSync(store1, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════════
section("WP7 end-to-end appendix — F1 probe rows through the REAL gate (answered y)");
// ══════════════════════════════════════════════════════════════════════════

{
  section("F1.a worker pane answers Class D with y → refused, never proceeds");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "git push --v12askd1",
    env: WORKER_ENV,
    dialogScript: (dlg) => { dlg.handleInput("y"); dlg.handleInput("n"); }, // y row absent (render gate); n → block answer
  });
  check("F1: worker y on Class D NEVER proceeds", R(h).block === true);
  check("F1: refusal carries the matrix why", (R(h).reason ?? "").includes("Answer refused") && (R(h).reason ?? "").includes("non-captain"));
  const slug = harnessSlug(h);
  check("F1: refused answer lands as a gate deny in the trail", (readTrail(slug) ?? []).some((t) => t.decision === "deny" && t.actor === "gate"));
  cleanupHarness(h);
  setDialogClockForTesting(null);
}

{
  section("F1.b firstmate pane answers Class D with y → refused, never proceeds");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "git push --v12askd2",
    env: { FM_SUPERVISOR: "1", PI_SESSION_ID: "sess-fm-1" },
    dialogScript: (dlg) => { dlg.handleInput("y"); dlg.handleInput("n"); },
  });
  check("F1: firstmate y on Class D NEVER proceeds (D rejects firstmate answers always)", R(h).block === true && (R(h).reason ?? "").includes("Answer refused"));
  cleanupHarness(h);
  setDialogClockForTesting(null);
}

{
  section("F1.c firstmate pane answers non-enumerated G with y → PARKED, never proceeds");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "v12askg51 --now",
    env: { FM_SUPERVISOR: "1", PI_SESSION_ID: "sess-fm-2" },
    dialogScript: (dlg) => { dlg.handleInput("y"); dlg.handleInput("n"); },
  });
  const parkRec = h.entries.find((e) => e.customType === "mini-dc-park");
  check("F1: firstmate y on non-enumerated G parks (never proceeds)", R(h).block === true && !!parkRec);
  check("F1: matrix-park wording is distinct + carries the refusal", (R(h).reason ?? "").includes("(parked)") && (R(h).reason ?? "").includes("refused by the authorization matrix"));
  check("F1: park record carries the refusal for the supervisor", !!parkRec && typeof (parkRec.data as { refusal?: string }).refusal === "string");
  cleanupHarness(h);
  setDialogClockForTesting(null);
}

{
  section("F1.d worker pane answers non-enumerated G with y → PARKED, never proceeds");
  const mc = new ManualClock();
  setDialogClockForTesting(mc);
  const h = await drive({
    command: "v12askg52 --now",
    env: WORKER_ENV,
    dialogScript: (dlg) => { dlg.handleInput("y"); }, // y row IS rendered for worker G; the matrix parks the answer
  });
  const parkRec = h.entries.find((e) => e.customType === "mini-dc-park");
  check("F1: worker y on non-enumerated G parks — the answer seam honors the matrix, never the keystroke", R(h).block === true && !!parkRec && (R(h).reason ?? "").includes("never pane-proceeds"));
  check("F1: matrix-park lands in the trail (actor=gate)", (() => {
    const slug = harnessSlug(h);
    return (readTrail(slug) ?? []).some((t) => t.decision === "park" && t.actor === "gate");
  })());
  cleanupHarness(h);
  setDialogClockForTesting(null);
}

{
  section("F4/N1 — env-expanded + rules-file escape shapes (V8/V9/V10 + write variants)");
  // These pins reference the PRODUCTION store/rules forms as inert command strings — the
  // gate denies them and nothing is executed. Tier 0 protects the production default root
  // regardless of the harness store seam (N1).
  const hV8 = await drive({ command: "cat $HOME/.pi/agent/mini-'dc'/someRepo/grants.yaml", env: WORKER_ENV, mode: "json", storeDir: mkdtempSync(join(os.tmpdir(), "minidc-v12-n1-")) });
  check("N1 V8: $HOME-expanded quote-split store read DENIED", R(hV8).block === true && (R(hV8).reason ?? "").includes("privileged mini-dc store/rules"));
  cleanupHarness(hV8);
  const storeN1 = mkdtempSync(join(os.tmpdir(), "minidc-v12-n1-"));
  const hV9 = await drive({ command: "cat ${HOME}/.pi/agent/mini-'dc'/someRepo/grants.yaml", env: WORKER_ENV, mode: "json", storeDir: storeN1 });
  check("N1 V9: ${HOME}-expanded quote-split store read DENIED", R(hV9).block === true);
  cleanupHarness(hV9);
  const hV10 = await drive({ command: "cat ~/.pi/agent/mini-'dc'-rules.yaml", env: WORKER_ENV, mode: "json", storeDir: storeN1 });
  check("N1 V10: quote-split global rules file read DENIED (protected target in its own right)", R(hV10).block === true);
  cleanupHarness(hV10);
  const hW1 = await drive({ command: "echo forged > $HOME/.pi/agent/mini-'dc'/someRepo/trail.jsonl", env: WORKER_ENV, mode: "json", storeDir: storeN1 });
  check("N1 write variant: $HOME quote-split trail write DENIED", R(hW1).block === true);
  cleanupHarness(hW1);
  const hW2 = await drive({ command: "echo x >> ~/.pi/agent/mini-'dc'-rules.yaml", env: WORKER_ENV, mode: "json", storeDir: storeN1 });
  check("N1 write variant: rules-file append DENIED", R(hW2).block === true);
  cleanupHarness(hW2);
  const hPlain = await drive({ command: "cat $HOME/.pi/agent/notes.txt", env: WORKER_ENV, mode: "json", storeDir: storeN1 });
  check("N1 control: non-store $HOME reads still pass", R(hPlain).block === false);
  cleanupHarness(hPlain);
  rmSync(storeN1, { recursive: true, force: true });
}

{
  section("F4/N2 — unset-var mid-name elision escape shapes (D1-D5 + write + benign control)");
  // Captain round-4 ruling: unset/empty-var segments reconstruct protected paths at
  // execution (mini-d${E}c with E unset). Pins verbatim from the recheck report; inert
  // strings — the gate denies, nothing executes. Production root protected regardless of
  // the harness seam.
  const storeN2 = mkdtempSync(join(os.tmpdir(), "minidc-v12-n2-"));
  const d1 = await drive({ command: 'cat $HOME/.pi/agent/mini-d${E}c/someRepo/grants.yaml', env: WORKER_ENV, mode: "json", storeDir: storeN2 });
  check("N2 D1: unset-var mid-name elision store read DENIED", R(d1).block === true && (R(d1).reason ?? "").includes("privileged mini-dc store/rules"));
  cleanupHarness(d1);
  const d2 = await drive({ command: 'cat $HOME/.pi/agent/mini-d"$E"c/someRepo/grants.yaml', env: WORKER_ENV, mode: "json", storeDir: storeN2 });
  check("N2 D2: quote-delimited unset-var mid-name elision DENIED (raw-first de-env)", R(d2).block === true);
  cleanupHarness(d2);
  const d3 = await drive({ command: 'cat ~/.pi/agent/mini-d${E}c-rules.yaml', env: WORKER_ENV, mode: "json", storeDir: storeN2 });
  check("N2 D3: elided global rules file read DENIED", R(d3).block === true);
  cleanupHarness(d3);
  const d4 = await drive({ command: 'echo forged > $HOME/.pi/agent/mini-d${E}c/someRepo/trail.jsonl', env: WORKER_ENV, mode: "json", storeDir: storeN2 });
  check("N2 D4: elided production trail WRITE DENIED", R(d4).block === true);
  cleanupHarness(d4);
  const d5 = await drive({ command: 'cat $HOME/.pi/a${E}gent/mini-dc/someRepo/grants.yaml', env: WORKER_ENV, mode: "json", storeDir: storeN2 });
  check("N2 D5: elision inside a path segment (agent) DENIED", R(d5).block === true);
  cleanupHarness(d5);
  const dW = await drive({ command: 'echo x >> ~/.pi/agent/mini-d${E}c-rules.yaml', env: WORKER_ENV, mode: "json", storeDir: storeN2 });
  check("N2 write variant: elided rules-file append DENIED", R(dW).block === true);
  cleanupHarness(dW);
  const dBenign = await drive({ command: 'cat ${E}dir/notes.txt', env: WORKER_ENV, mode: "json", storeDir: storeN2 });
  check("N2 benign control: unset-var non-store reads still pass", R(dBenign).block === false);
  cleanupHarness(dBenign);
  rmSync(storeN2, { recursive: true, force: true });
}

{
  section("AF1 — D-net-first: D-shaped bash asks with NO rule match (2026-11-17 both-desk alignment finding)");
  // ddd↔TNT live-smoke finding: `git -C <dir> push` passed UNGATED — the plain-push rule regex
  // missed the -C form and the token D-net only ran after a rule match. The net now fires
  // BEFORE the rules ask/block decision. All fixtures are deny-only inert shapes: the gate
  // blocks or asks, nothing executes.
  const mcAf1 = new ManualClock();
  setDialogClockForTesting(mcAf1);
  const hAf1c = await drive({
    command: "git -C /tmp/x push origin main",
    env: CAPTAIN_ENV,
    dialogScript: (dlg) => { dlg.handleInput("d"); dlg.handleInput("y"); }, // d: open the detail pane for the text pins
  });
  check("AF1: -C-form push with NO rule match raises the D dialog (was: ungated pass)", hAf1c.customCalls === 1);
  const textAf1c = renderText(hAf1c.dialogs[0]);
  check("AF1: the no-rule dialog classifies D on the token net (no rule pin)", textAf1c.includes("class: D") && textAf1c.includes("destructive git form") && textAf1c.includes("matched rule: destructive git form"));
  check("AF1: captain y proceeds the no-rule D ask", R(hAf1c).block === false);
  const slugAf1c = harnessSlug(hAf1c);
  check("AF1: no-rule D proceed lands in the trail (cls D, captain, scope once)", (readTrail(slugAf1c) ?? []).some((t) => t.cls === "D" && t.decision === "proceed" && t.actor === "captain" && t.scope === "once"));
  cleanupHarness(hAf1c);

  const hAf1w = await drive({
    command: "git -C /tmp/x push origin main",
    env: WORKER_ENV,
    dialogScript: (dlg) => { dlg.handleInput("y"); dlg.handleInput("n"); }, // no y row renders for worker D (F1); n resolves
  });
  check("AF1: D at the worker seat is REFUSED on y (park-or-refuse law unchanged)", hAf1w.customCalls === 1 && R(hAf1w).block === true && (R(hAf1w).reason ?? "").includes("class D rejects non-captain answers always"));
  cleanupHarness(hAf1w);

  const hAf1h = await drive({ command: "git -C /tmp/x push origin main", env: WORKER_ENV, mode: "json" });
  check("AF1: -C-form push headless → in-band ASK→deny (no abort)", R(hAf1h).block === true && (R(hAf1h).reason ?? "").includes("headless ASK→deny") && hAf1h.abortCalls === 0 && hAf1h.customCalls === 0);
  cleanupHarness(hAf1h);

  const hAf1q = await drive({ command: "git 'push'", env: WORKER_ENV, mode: "json" });
  check("AF1: quote-split push (rule-miss shape) gates D headless", R(hAf1q).block === true && (R(hAf1q).reason ?? "").includes("headless ASK→deny"));
  cleanupHarness(hAf1q);

  const hAf1bs = await drive({ command: "git pu\\sh origin main", env: WORKER_ENV, mode: "json" });
  check("AF1: backslash-split push (rule-miss shape) gates D headless", R(hAf1bs).block === true && (R(hAf1bs).reason ?? "").includes("headless ASK→deny"));
  cleanupHarness(hAf1bs);

  const hAf1g = await drive({
    command: "gh pr -R o/r merge 5",
    env: WORKER_ENV,
    dialogScript: (dlg) => { dlg.handleInput("d"); dlg.handleInput("y"); dlg.handleInput("n"); }, // d + no-y-row law; n resolves
  });
  check("AF1: gh pr merge (rule-miss shape) asks D at the worker pane and never proceeds on y", hAf1g.customCalls === 1 && renderText(hAf1g.dialogs[0]).includes("class: D") && R(hAf1g).block === true);
  cleanupHarness(hAf1g);

  // Rule matches keep their precedence: an ask-rule still asks ONCE with its rule text.
  const pushRuleYaml = [
    "bashToolPatterns:",
    "  - pattern: '\\bgit\\s+push\\b'",
    "    reason: plain git-push confirm",
    "    ask: true",
    "",
  ].join("\n");
  const hAf1r = await drive({
    command: "git push",
    env: CAPTAIN_ENV,
    rulesYaml: pushRuleYaml,
    dialogScript: (dlg) => { dlg.handleInput("d"); dlg.handleInput("y"); }, // d: open the detail pane for the rule-text pin
  });
  const textAf1r = renderText(hAf1r.dialogs[0]);
  check("AF1: plain git push still asks via its rule — ONCE, rule text unchanged (no double dialog)", hAf1r.customCalls === 1 && textAf1r.includes("matched rule: \\bgit\\s+push\\b"));
  check("AF1: rule-matched push still classifies D and proceeds on captain y", textAf1r.includes("class: D") && R(hAf1r).block === false);
  cleanupHarness(hAf1r);

  // Block wins over ask: a D-shaped command matching a BLOCK rule hard-blocks without dialog.
  const hAf1b = await drive({ command: "git push v12deny2", env: WORKER_ENV, mode: "json" });
  check("AF1: D-shaped command matching a BLOCK rule hard-blocks WITHOUT dialog", hAf1b.customCalls === 0 && R(hAf1b).block === true && (R(hAf1b).reason ?? "").includes("v12 deny rule"));
  cleanupHarness(hAf1b);

  // No over-gate: non-D, rule-unmatched commands stay silent.
  const hAf1n = await drive({ command: "npm test", env: WORKER_ENV });
  check("AF1: npm test stays silent (no rule match, not D-shaped)", hAf1n.customCalls === 0 && R(hAf1n).block === false);
  cleanupHarness(hAf1n);
  const hAf1e = await drive({ command: "echo x >> scratch-note.txt", env: WORKER_ENV });
  check("AF1: plain echo-append stays silent (no over-gate)", hAf1e.customCalls === 0 && R(hAf1e).block === false);
  cleanupHarness(hAf1e);
  setDialogClockForTesting(null);
}

{
  section("R1.a — token D-net widens to the named publication/dispatch families (2026-11-17)");
  // Same AF1 law, more families: every widened D-shaped RULE-MISS form asks D even with no
  // rule match; the raw word-adjacent D_FORMS regexes stay the second net; BLOCK rules still
  // win over ask; the D seat law is seat-generic. All fixtures are deny-only inert strings —
  // the gate blocks or asks, nothing executes. Spellings verified against installed
  // help/docs; gh deployment (no such subcommand) and pip publish (no such command) are
  // recorded gaps, not cells.
  const dCells: Array<[string, string, string]> = [
    ["npm --registry https://reg.invalid publish", "publication form", "npm publish flag-reordered"],
    ["npm 'publish'", "publication form", "npm publish quoted"],
    ["npm pu\"$X\"blish", "publication form", "npm publish env-assembled"],
    ["yarn publish --tag next", "publication form", "yarn publish"],
    ["pnpm -r publish", "publication form", "pnpm publish flag-reordered"],
    ["bun publish", "publication form", "bun publish"],
    ["cargo publish --dry-run", "publication form", "cargo publish (dry-run still publication-class)"],
    ["docker -H unix:///x/y push img:tag", "container publication form", "docker push flag-reordered"],
    ["docker \"push\" img:tag", "container publication form", "docker push quoted"],
    ["docker build --push .", "container publication form", "docker build --push (BuildKit registry shorthand)"],
    ["docker buildx build -q --push .", "container publication form", "docker buildx build --push reordered"],
    ["gh -R o/r release create v1.0", "gh release publication form", "gh release create flag-reordered"],
    ["gh 'release' 'create' v1", "gh release publication form", "gh release create quoted"],
    ["gh release upload v1.0 ./x.tgz", "gh release publication form", "gh release upload"],
    ["gh -R o/r workflow run ci.yml", "gh workflow dispatch form", "gh workflow run reordered"],
  ];
  for (const [cmd, frag, label] of dCells) {
    const h = await drive({ command: cmd, env: WORKER_ENV, mode: "json" });
    check(
      `R1.a: ${label} (rule-miss) gates D headless`,
      R(h).block === true && (R(h).reason ?? "").includes("headless ASK→deny") && (R(h).reason ?? "").includes(frag),
    );
    cleanupHarness(h);
  }

  // Seat law on a widened family: captain y proceeds (trail lands); worker y is refused.
  const hR1cap = await drive({
    command: "npm --registry https://reg.invalid publish",
    env: CAPTAIN_ENV,
    dialogScript: (dlg) => { dlg.handleInput("d"); dlg.handleInput("y"); }, // d: detail pane for the class/why pins
  });
  const textR1cap = renderText(hR1cap.dialogs[0]);
  check("R1.a: widened family at captain seat renders class D + the publication why (no rule pin)", hR1cap.customCalls === 1 && textR1cap.includes("class: D") && textR1cap.includes("publication form"));
  check("R1.a: captain y proceeds the widened-family ask", R(hR1cap).block === false);
  const slugR1cap = harnessSlug(hR1cap);
  check("R1.a: widened-family proceed lands in the trail (cls D, captain, scope once)", (readTrail(slugR1cap) ?? []).some((t) => t.cls === "D" && t.decision === "proceed" && t.actor === "captain" && t.scope === "once"));
  cleanupHarness(hR1cap);
  const hR1w = await drive({
    command: "docker build --push .",
    env: WORKER_ENV,
    dialogScript: (dlg) => { dlg.handleInput("y"); dlg.handleInput("n"); }, // no y row renders for worker D; n resolves
  });
  check("R1.a: widened family at worker seat REFUSES y (class D law unchanged)", hR1w.customCalls === 1 && R(hR1w).block === true && (R(hR1w).reason ?? "").includes("class D rejects non-captain answers always"));
  cleanupHarness(hR1w);

  // BLOCK-rule precedence survives the widening: block beats ask, no dialog.
  const hR1b = await drive({ command: "docker build --push v12deny3", env: WORKER_ENV, mode: "json" });
  check("R1.a: widened D shape matching a BLOCK rule hard-blocks WITHOUT dialog", hR1b.customCalls === 0 && R(hR1b).block === true && (R(hR1b).reason ?? "").includes("v12 deny rule"));
  cleanupHarness(hR1b);

  // F4 wording: the no-rule headless deny speaks of the ACTION, not a rule.
  const hR1f4 = await drive({ command: "cargo publish", env: WORKER_ENV, mode: "json" });
  check("R1/F4: headless deny wording says the ACTION requires confirmation (no rule matched)", (R(hR1f4).reason ?? "").includes("This action requires operator confirmation") && !(R(hR1f4).reason ?? "").includes("This rule requires"));
  cleanupHarness(hR1f4);

  // Benign near-miss controls: the net stays head-scoped and exact-token — reads, PR
  // creation, plain builds, and non-publication npx shapes route R/G (gated), never D.
  // NOTE: these are classifier pins; handler-level no-rule pass cells for the correction
  // shapes live in the correction-round block below (classifier G/D alone never proves a
  // no-rule ask).
  const r1Benign: Array<[string, string]> = [
    ["npm test", "G"],
    ["npm view left-pad versions", "R"],
    ["npm pack --dry-run", "G"],
    ["docker ps", "G"],
    ["docker build .", "G"],
    ["docker buildx build -q .", "G"],
    ["docker pull alpine", "G"],
    ["gh release list", "R"],
    ["gh release view v1.0", "R"],
    ["gh pr create --title x", "G"],
    ["gh workflow list", "G"],
    ["gh workflow view ci.yml", "G"],
    ["gh run list", "R"],
    ["cargo build", "G"],
    ["pip install wheel", "G"],
    // Named npx publication path: routes D at the REAL HANDLER via the token net (see the
    // correction-round drive cells below — classifier pins here are backstops, not proof).
    ["npx npm publish", "D"],
    ["npx npm@latest publish", "D"],
    ["npx -p npm publish", "D"],
    ["npx publish", "G"],
    ["npx cowsay publish", "G"],
    ["npx npm run publish-notes", "G"],
    ["echo release create workflow run", "R"],
    ["cat publish-notes.md", "R"],
  ];
  for (const [cmd, wantCls] of r1Benign) {
    check(`R1.a control: ${cmd} routes ${wantCls}`, classifyBashCommand(cmd).cls === wantCls);
  }
}

{
  section("R1 correction round 1 — review FIX: npx seam, gh de-env pairs, docker --push values (2026-11-17)");
  // Handler-level no-rule cells (the correction spec's proof layer: classifier G/D alone
  // never proves a no-rule ask occurred — these drives go through the real tool_call seam).
  // All inert deny-only strings; each gates D headless where the pre-correction head passed
  // UNGATED (causal: reviewer-verified at 6fad10c vs base a6feda0).
  const fixCells: Array<[string, string, string]> = [
    // (F1) named npx publication at the real seam — help-documented package spellings only
    ["npx npm publish", "publication form via npx", "npx npm publish (was ungated at handler)"],
    ["npx npm@10.9.1 publish", "publication form via npx", "npx version-qualified npm publish"],
    ["npx --package=npm@latest publish", "publication form via npx", "npx --package=<pkg>@<ver> spelling"],
    ["npx --package npm publish", "publication form via npx", "npx --package <pkg> space form"],
    ["npx yarn@1.22 publish", "publication form via npx", "npx version-qualified yarn publish"],
    ["npx -p npm publish", "publication form via npx", "npx -p value spelling (over-gate, fail-closed)"],
    // (F2) gh adjacent-pair matching on the de-env'd variant — real env assembly
    ["gh release \"$X\" create", "gh release publication form", "gh release $X-env assembly (was ungated)"],
    ["gh workflow \"$X\" run", "gh workflow dispatch form", "gh workflow $X-env assembly (was ungated)"],
    // (F3) docker truthy --push flag VALUES
    ["docker build --push=true .", "container publication form", "docker build --push=true (was ungated)"],
    ["docker buildx build --push=1 .", "container publication form", "docker buildx build --push=1 (was ungated)"],
  ];
  for (const [cmd, frag, label] of fixCells) {
    const h = await drive({ command: cmd, env: WORKER_ENV, mode: "json" });
    check(
      `R1.fix: ${label} gates D headless`,
      R(h).block === true && (R(h).reason ?? "").includes("headless ASK→deny") && (R(h).reason ?? "").includes(frag),
    );
    cleanupHarness(h);
  }
  // Nonpublication controls AT THE REAL HANDLER: falsy flag values and publish-merely-named
  // arguments stay silent (no rule match, no ask) — an ask here would be over-gating.
  const fixControls: string[] = [
    "docker build --push=false .",
    "docker build --push=0 .",
    "npx cowsay publish",
    "npx publish",
    "npx npm run publish-notes",
  ];
  for (const cmd of fixControls) {
    const h = await drive({ command: cmd, env: WORKER_ENV, mode: "json" });
    check(`R1.fix control: ${cmd} stays a silent pass at the handler`, h.customCalls === 0 && R(h).block === false);
    cleanupHarness(h);
  }
}

{
  section("R1.b — primary/pool slug unification via canonical origin remote (N2 consistency)");
  // Fixture (real files, no git needed — the resolver reads pointer/config text only):
  // a primary checkout with .git/config origin, plus a pool project dir whose slots point
  // back at it with worktree .git pointer files. Same repo → ONE slug whether asked from the
  // pool branch (path) or the primary branch (remote identity); everything else keeps the
  // collision-proof path hash. Read-only metadata only — never the mini-dc store.
  const poolR1 = mkdtempSync(join(os.tmpdir(), "minidc-r1-pool-"));
  const primaryR1 = mkdtempSync(join(os.tmpdir(), "minidc-r1-primary-"));
  mkdirSync(join(primaryR1, ".git"), { recursive: true });
  writeFileSync(join(primaryR1, ".git", "config"), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/o/fixrepo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  mkdirSync(join(poolR1, "fixrepo-a1b2c3", "1", "work"), { recursive: true });
  writeFileSync(join(poolR1, "fixrepo-a1b2c3", "1", "work", ".git"), `gitdir: ${join(primaryR1, ".git", "worktrees", "w1")}\n`);
  mkdirSync(join(poolR1, "fixrepo-a1b2c3", "2", "work"), { recursive: true });
  writeFileSync(join(poolR1, "fixrepo-a1b2c3", "2", "work", ".git"), `gitdir: ${join(primaryR1, ".git", "worktrees", "w2")}\n`);
  const primaryRemote = "https://github.com/o/fixrepo.git";
  check("R1.b: non-pool primary resolves to the POOL slug via origin identity", resolveRepoSlug(primaryR1, { poolBase: poolR1, remoteUrl: primaryRemote }) === "fixrepo");
  check("R1.b: scp-style spelling canonicalizes to the same identity", resolveRepoSlug(primaryR1, { poolBase: poolR1, remoteUrl: "git@github.com:o/fixrepo.git" }) === "fixrepo");
  check("R1.b: .git-suffix-less https spelling canonicalizes identically", resolveRepoSlug(primaryR1, { poolBase: poolR1, remoteUrl: "https://github.com/o/fixrepo" }) === "fixrepo");
  // Correction round 1 (review F4): path case is identity — host spellings fold, paths don't.
  check("R1.b F4: mixed-case HOST spellings of the same exact path still unify", resolveRepoSlug(primaryR1, { poolBase: poolR1, remoteUrl: "git@GitHub.Com:o/fixrepo.git" }) === "fixrepo" && resolveRepoSlug(primaryR1, { poolBase: poolR1, remoteUrl: "https://GITHUB.com/o/fixrepo" }) === "fixrepo");
  check("R1.b F4: distinct case-sensitive repository paths do NOT share a slug", resolveRepoSlug(primaryR1, { poolBase: poolR1, remoteUrl: "https://github.com/o/FixRepo.git" }) === `r-${sha16(primaryR1)}`);
  check("R1.b: pool slots still resolve by path (unchanged branch)", resolveRepoSlug(join(poolR1, "fixrepo-a1b2c3", "1", "work"), { poolBase: poolR1 }) === "fixrepo");
  check("R1.b: second slot → same slug (recycling stability preserved)", resolveRepoSlug(join(poolR1, "fixrepo-a1b2c3", "2", "work"), { poolBase: poolR1 }) === "fixrepo");
  check("R1.b: poolSlugForRemote direct hit → pool-derived slug", poolSlugForRemote(primaryRemote, { poolBase: poolR1 }) === "fixrepo");
  // Two pool projects of the SAME repo: sorted-first, same stripped slug.
  mkdirSync(join(poolR1, "fixrepo-dddddd", "w"), { recursive: true });
  writeFileSync(join(poolR1, "fixrepo-dddddd", "w", ".git"), `gitdir: ${join(primaryR1, ".git", "worktrees", "w3")}\n`);
  check("R1.b: multiple pool projects of one repo → same unified slug (deterministic)", poolSlugForRemote(primaryRemote, { poolBase: poolR1 }) === "fixrepo");
  rmSync(join(poolR1, "fixrepo-dddddd"), { recursive: true, force: true });
  // Basename coincidence is NOT identity: same name, different/no remote → path hash.
  const otherR1 = mkdtempSync(join(os.tmpdir(), "minidc-r1-other-"));
  check("R1.b: basename coincidence is NOT identity (different remote → path hash)", resolveRepoSlug(otherR1, { poolBase: poolR1, remoteUrl: "https://github.com/x/other.git" }) === `r-${sha16(otherR1)}`);
  check("R1.b: remote-less repo keeps the path hash (no origin → no unification)", resolveRepoSlug(otherR1, { poolBase: poolR1 }) === `r-${sha16(otherR1)}`);
  check("R1.b: absent pool base → path hash even with a remote", resolveRepoSlug(primaryR1, { poolBase: join(poolR1, "missing"), remoteUrl: primaryRemote }) === `r-${sha16(primaryR1)}`);
  // Registry robustness: malformed pointer / marker-less projects are skipped, not fatal.
  mkdirSync(join(poolR1, "broken-9f8e7d", "w"), { recursive: true });
  writeFileSync(join(poolR1, "broken-9f8e7d", "w", ".git"), "not-a-pointer\n");
  mkdirSync(join(poolR1, "z-empty-123ab"), { recursive: true });
  check("R1.b: malformed pointer + marker-less pool projects are skipped, resolution still lands", resolveRepoSlug(primaryR1, { poolBase: poolR1, remoteUrl: primaryRemote }) === "fixrepo");
  // Direct-checkout pool layout: <proj>-<hex>/.git as a DIRECTORY with its own config.
  mkdirSync(join(poolR1, "direct-b7c6d5", ".git"), { recursive: true });
  writeFileSync(join(poolR1, "direct-b7c6d5", ".git", "config"), '[remote "origin"]\n\turl = https://github.com/o/directrepo.git\n');
  const directPrimary = mkdtempSync(join(os.tmpdir(), "minidc-r1-directp-"));
  check("R1.b: pool project as direct checkout (config at .git/config) unifies too", resolveRepoSlug(directPrimary, { poolBase: poolR1, remoteUrl: "https://github.com/o/directrepo.git" }) === "direct");
  // E2E: the GATE's handler slug unifies through the remote — the trail lands under the
  // pool slug, and the old r-hash store dir is never created. Scratch pool base via the
  // testing seam; scratch store via storeDir; the ask lands a deny trail (actor=gate).
  const storeR1 = mkdtempSync(join(os.tmpdir(), "minidc-r1-store-"));
  setPoolBaseForTesting(poolR1);
  const hR1e2e = makeHarness({ command: "echo v12askg7", env: WORKER_ENV, mode: "json", storeDir: storeR1 });
  execSync(`git -C ${JSON.stringify(hR1e2e.tmp)} remote add origin https://github.com/o/fixrepo.git`);
  await hR1e2e.run();
  check("R1.b e2e: the gate resolves the handler slug through the remote identity", existsSync(join(storeR1, "fixrepo", "trail.jsonl")));
  check("R1.b e2e: the r-hash store dir is NOT created for the unified repo", !existsSync(join(storeR1, `r-${sha16(hR1e2e.tmp)}`)));
  cleanupHarness(hR1e2e);
  setPoolBaseForTesting(null);
  rmSync(poolR1, { recursive: true, force: true });
  rmSync(primaryR1, { recursive: true, force: true });
  rmSync(otherR1, { recursive: true, force: true });
  rmSync(directPrimary, { recursive: true, force: true });
  rmSync(storeR1, { recursive: true, force: true });
}

// ── restore production seams ─────────────────────────────────────────────────
setStoreRootForTesting(null);
setEnvSourceForTesting(null);
setGlobalRulesPathForTesting(null);
setPoolBaseForTesting(null);
setDialogClockForTesting(null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
