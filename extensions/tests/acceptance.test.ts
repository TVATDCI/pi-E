// extensions/tests/acceptance.test.ts — acceptance-gate invariant tests.
// Run: node --experimental-strip-types acceptance.test.ts   (from extensions/tests/)
//
// Proves the two load-bearing properties Group 2's safety rests on:
//   (1) ENUM-COMMAND SANDBOX — YAML `command`/`env`/`cwd` never reach any exec path. The pwned-YAML
//       negative test asserts a {command:"rm -rf /",env:{PATH:"/tmp"},cwd:"/"} verify entry coerces
//       to exactly {id,kind} — the only fields coerceAcceptance ever copies.
//   (2) BADGE-ONLY INVARIANT — auto/inferred configs can NEVER fail a step (failStep stays false),
//       even when the gate isn't met; only explicit levels can reject. A future refactor that
//       breaks this silently breaks the "existing chains unchanged" premise.
// Plus parse/strip/resolve sanity. (The live exec path is covered by the smoke test, not here.)
import {
  coerceAcceptance,
  resolveAcceptance,
  inferDefaultLevel,
  inferReview,
  parseAcceptanceReport,
  evaluateAcceptance,
  formatAcceptancePrompt,
  stripAcceptanceReport,
  classifyTaskIntent,
  taskMayMutate,
  inferLevelFromRoleAndTask,
  normalizeCriterionStatus,
  normalizeCommandResult,
} from "../acceptance.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}`);
  }
}

const REPORT = "```acceptance-report\n" + JSON.stringify({ changedFiles: ["a.ts"], noStagedFiles: true }) + "\n```";

async function main(): Promise<void> {
  // --- 1. ENUM-COMMAND SANDBOX (the negative test that proves sandboxing) ---
  const pwned = coerceAcceptance({
    verify: [{ id: "x", kind: "test", command: "rm -rf /", env: { PATH: "/tmp" }, cwd: "/" }],
  });
  check("pwned verify coerced to exactly one entry", !!pwned?.verify && pwned.verify.length === 1);
  const v = pwned?.verify?.[0];
  check("pwned entry keeps id + kind only", !!v && v.id === "x" && v.kind === "test");
  check("pwned command/env/cwd DROPPED — no arbitrary exec path", !!v && !("command" in v) && !("env" in v) && !("cwd" in v));

  check("non-enum kind dropped (verify empty)", !coerceAcceptance({ verify: [{ id: "y", kind: "shell", command: "pwn" }] })?.verify?.length);
  check("invalid level ⇒ whole gate dropped (undefined)", coerceAcceptance({ level: "bogus" }) === undefined);
  const ok = coerceAcceptance({ level: "verified", verify: [{ kind: "test" }] });
  check("valid config: level verified", ok?.level === "verified");
  check("valid config: verify id defaults to kind when omitted", ok?.verify?.[0]?.id === "test");
  check("no acceptance object ⇒ undefined", coerceAcceptance(undefined) === undefined);
  check("empty object ⇒ undefined", coerceAcceptance({}) === undefined);

  // --- 2. inferDefaultLevel (tools-based) ---
  check("edit/write tools ⇒ checked", inferDefaultLevel("read, bash, edit, write") === "checked");
  check("read-only tools ⇒ attested", inferDefaultLevel("read, grep, find, ls") === "attested");
  check("no tools ⇒ attested", inferDefaultLevel(undefined) === "attested");

  // --- 3. resolveAcceptance ---
  check("level none ⇒ null (gate disabled)", resolveAcceptance({ level: "none" }, "attested") === null);
  const autoAtt = resolveAcceptance(undefined, "attested");
  check("no config ⇒ auto-inferred + badge-only", !!autoAtt && autoAtt.inferred && autoAtt.level === "attested");
  const explicit = resolveAcceptance({ level: "verified" }, "checked");
  check("explicit level ⇒ not inferred (can reject)", !!explicit && !explicit.inferred && explicit.level === "verified");

  // --- 4. parseAcceptanceReport ---
  check("fenced report parsed", !!parseAcceptanceReport(`done\n${REPORT}`).report);
  check("missing report ⇒ empty, no error (claimed)", !parseAcceptanceReport("just prose").report && !parseAcceptanceReport("just prose").error);
  check("malformed fenced ⇒ error", !!parseAcceptanceReport("```acceptance-report\n{not json}\n```").error);

  // --- 5. evaluateAcceptance — THE badge-only invariant ---
  // inferred (auto) ⇒ NEVER fails the step, even when the gate isn't met
  const infAtt = resolveAcceptance(undefined, "attested")!;
  const r1 = await evaluateAcceptance(infAtt, "prose, no report", "/tmp");
  check("auto-attested + no report ⇒ rejected provenance", r1.provenance === "rejected");
  check("INVARIANT: auto/inferred NEVER fails the step (failStep false)", r1.failStep === false);

  const r2 = await evaluateAcceptance(resolveAcceptance(undefined, "attested")!, `findings\n${REPORT}`, "/tmp");
  check("auto-attested + report ⇒ attested, failStep false", r2.provenance === "attested" && r2.failStep === false);

  // explicit ⇒ CAN fail
  const r3 = await evaluateAcceptance(resolveAcceptance({ level: "attested" }, "attested")!, "prose, no report", "/tmp");
  check("explicit attested + no report ⇒ rejected + failStep TRUE", r3.provenance === "rejected" && r3.failStep === true);

  // explicit verified without verify commands ⇒ cannot verify ⇒ rejected + fail
  const r4 = await evaluateAcceptance(resolveAcceptance({ level: "verified" }, "checked")!, `impl\n${REPORT}`, "/tmp");
  check("explicit verified + no verify cmds ⇒ rejected + failStep", r4.provenance === "rejected" && r4.failStep === true);

  // inferred checked with evidence:[] (no structural/git needed) + report ⇒ checked, badge-only
  const r5 = await evaluateAcceptance(resolveAcceptance({ evidence: [] }, "checked")!, `impl\n${REPORT}`, "/tmp");
  check("auto-checked + report ⇒ checked, failStep false", r5.provenance === "checked" && r5.failStep === false);

  // --- 6. stripAcceptanceReport ---
  const stripped = stripAcceptanceReport(`findings\n${REPORT}\ntail`);
  check("strip removes the fenced report", !stripped.includes("acceptance-report") && stripped.includes("findings") && stripped.includes("tail"));
  check("strip leaves fence-free output untouched", stripAcceptanceReport("plain text") === "plain text");

  // --- 7. ② inferReview (risky-task auto-suggest) ---
  check("inferReview: risky writer task ⇒ review required", inferReview("ship the auth migration", true)?.required === true);
  check("inferReview: risky writer task ⇒ agent reviewer", inferReview("data-loss fix pass", true)?.agent === "reviewer");
  check("inferReview: non-risky task ⇒ none", inferReview("refactor the utils", true) === undefined);
  check("inferReview: read-only task ⇒ none (even risky wording)", inferReview("review the security migration", false) === undefined);

  // --- 8. ② resolveAcceptance — review merge (explicit wins; risky auto-badge; role suppression) ---
  check("resolve: no config + risky writer task ⇒ auto-inferred review badge", resolveAcceptance(undefined, "checked", "ship the migration")?.review?.required === true);
  check("resolve: no config + non-risky ⇒ no review", !resolveAcceptance(undefined, "checked", "refactor utils")?.review);
  check("resolve: explicit review wins over inferred", resolveAcceptance({ review: { required: true, agent: "oracle", focus: "diff" } }, "checked", "plain")?.review?.agent === "oracle");
  check("resolve: read-only role suppresses risky suggestion", !resolveAcceptance({ acceptanceRole: "read-only" }, "checked", "ship the migration")?.review);
  check("resolve: writer role enables risky suggestion on attested-inferred level", resolveAcceptance({ acceptanceRole: "writer" }, "attested", "security fix pass")?.review?.required === true);

  // --- 9. ② coerceAcceptance — review validation + acceptanceRole + "reviewed" coercion ---
  const rv = coerceAcceptance({ level: "checked", review: { required: true, agent: "reviewer", focus: "diff", bogus: 1 } });
  check("coerce: invalid review key ⇒ review DROPPED, gate kept (lenient)", rv?.level === "checked" && !rv?.review);
  const rv2 = coerceAcceptance({ review: { required: true, agent: "reviewer" } });
  check("coerce: valid review passes through", rv2?.review?.required === true && rv2?.review?.agent === "reviewer");
  check("coerce: acceptanceRole read-only passes through", coerceAcceptance({ acceptanceRole: "read-only" })?.acceptanceRole === "read-only");
  check("coerce: acceptanceRole bogus dropped", coerceAcceptance({ acceptanceRole: "bogus" as unknown as "read-only" })?.acceptanceRole === undefined);
  check("coerce: level 'reviewed' coerced to auto (not dropped)", coerceAcceptance({ level: "reviewed", criteria: [{ id: "c", must: "x" }] })?.criteria?.length === 1);

  // --- 10. ② evaluateAcceptance — review dimension (review-required / reviewed / rejected) ---
  const revReq = resolveAcceptance({ level: "checked", review: { required: true } }, "checked")!;
  const er1 = await evaluateAcceptance(revReq, `impl\n${REPORT}`, "/tmp");
  check("review.required + evidence passed + no reviewer ⇒ review-required", er1.provenance === "review-required");
  check("review-required is NON-TERMINAL (failStep false, Q2.2)", er1.failStep === false);
  check("review surfaces on StepAcceptance", er1.review?.required === true);
  const er2 = await evaluateAcceptance(revReq, `impl\n${REPORT}`, "/tmp", undefined, { blockers: [] });
  check("review.required + reviewer no blockers ⇒ reviewed", er2.provenance === "reviewed");
  const er3 = await evaluateAcceptance(revReq, `impl\n${REPORT}`, "/tmp", undefined, { blockers: ["file.ts:12 bug"] });
  check("review.required + reviewer blockers ⇒ rejected", er3.provenance === "rejected");
  check("explicit review + reviewer blockers ⇒ failStep true", er3.failStep === true);
  const er4 = await evaluateAcceptance(revReq, "prose, no report", "/tmp");
  check("review.required + evidence FAILED ⇒ rejected (review moot)", er4.provenance === "rejected");
  const autoRev = resolveAcceptance(undefined, "checked", "ship the migration")!;
  const er5 = await evaluateAcceptance(autoRev, `impl\n${REPORT}`, "/tmp");
  check("auto risky review-required ⇒ non-terminal (failStep false)", er5.provenance === "review-required" && er5.failStep === false);
  // M1 (round-1): lock the review state-machine edge cases before ②b makes them reachable.
  const er6 = await evaluateAcceptance(autoRev, `impl\n${REPORT}`, "/tmp", undefined, { blockers: ["bug"] });
  check("auto risky + reviewer blockers ⇒ rejected but NON-TERMINAL (badge-only)", er6.provenance === "rejected" && er6.failStep === false);
  check("reviewed provenance ⇒ failStep false (terminal success)", er2.failStep === false);
  const revOff = resolveAcceptance({ level: "checked", review: { required: false } }, "checked")!;
  check("review.required=false ⇒ no review-required badge (checked)", (await evaluateAcceptance(revOff, `impl\n${REPORT}`, "/tmp")).provenance === "checked");
  const revNoReqRaw = coerceAcceptance({ level: "checked", review: { agent: "bob" } });
  check("coerce: review without required passes through", revNoReqRaw?.review?.agent === "bob");
  check("review without required ⇒ ignored (checked)", (await evaluateAcceptance(resolveAcceptance(revNoReqRaw, "checked")!, `impl\n${REPORT}`, "/tmp")).provenance === "checked");

  // --- 11. ② parser canonicalization (snake_case / string-bool / scalar-array) ---
  const snakeReport = "```acceptance-report\n" + JSON.stringify({
    changed_files: "src/a.ts",
    no_staged_files: "true",
    residual_risks: "none worth noting",
  }) + "\n```";
  const canon = parseAcceptanceReport(snakeReport).report;
  check("canonicalize: snake_case changed_files → changedFiles array", Array.isArray(canon?.changedFiles) && canon?.changedFiles?.[0] === "src/a.ts");
  check("canonicalize: snake_case no_staged_files → noStagedFiles boolean", canon?.noStagedFiles === true);
  check("canonicalize: scalar residual_risks → array", Array.isArray(canon?.residualRisks));

  // --- 12. ② formatAcceptancePrompt surfaces required review ---
  const promptWithReview = formatAcceptancePrompt(resolveAcceptance({ level: "checked", review: { required: true, agent: "reviewer", focus: "diff safety" } }, "checked")!);
  check("formatAcceptancePrompt: required review line present", promptWithReview.includes("Independent review REQUIRED") && promptWithReview.includes("reviewer") && promptWithReview.includes("diff safety"));

  // --- 13. F3 (②b): cachedVerifyResults — re-eval reuses prior verify results (no double-verify) ---
  const verifiedCfg = resolveAcceptance({ level: "verified", verify: [{ id: "t", kind: "test" }] }, "checked")!;
  const cachedPass = await evaluateAcceptance(verifiedCfg, `impl\n${REPORT}`, "/tmp", undefined, undefined, [{ id: "t", kind: "test", status: "passed", durationMs: 5 }]);
  check("F3: cached verify (all passed) ⇒ verified (no verify command re-run)", cachedPass.provenance === "verified");
  const cachedFail = await evaluateAcceptance(verifiedCfg, `impl\n${REPORT}`, "/tmp", undefined, undefined, [{ id: "t", kind: "test", status: "failed", durationMs: 5 }]);
  check("F3: cached verify (failed) ⇒ rejected (verify not met)", cachedFail.provenance === "rejected");

  // --- 14. ②b classifyTaskIntent (slimmed task-intent classifier) ---
  check("classify: implement verb ⇒ implementation", classifyTaskIntent("implement the auth module").kind === "implementation");
  check("classify: edit verb ⇒ implementation", classifyTaskIntent("edit src/index.ts to add the handler").kind === "implementation");
  check("classify: fix the failing test ⇒ implementation", classifyTaskIntent("fix the failing test").kind === "implementation");
  check("classify: scoped no-edit + implement ⇒ implementation (scoped constraint doesn't blanket-suppress)", classifyTaskIntent("do not edit files outside src/; implement the fix in src/foo.ts").kind === "implementation");
  check("classify: blanket no-edit ⇒ read-only", classifyTaskIntent("review the diff, do not modify any files").kind === "read-only");
  check("classify: 'review only' ⇒ read-only", classifyTaskIntent("review only, return findings").kind === "read-only");
  check("classify: read-only deliverable 'write a summary report' ⇒ read-only", classifyTaskIntent("write a summary report of the architecture").kind === "read-only");
  check("classify: bare question ⇒ unknown", classifyTaskIntent("what does this function do").kind === "unknown");

  // --- 15. ②b taskMayMutate (broad write-verb detector) ---
  check("mayMutate: implement ⇒ true", taskMayMutate("implement the feature") === true);
  check("mayMutate: update ⇒ true", taskMayMutate("update the config") === true);
  check("mayMutate: blanket no-edit ⇒ false", taskMayMutate("do not modify any files") === false);
  check("mayMutate: read-only deliverable 'write a report' suppressed ⇒ false", taskMayMutate("write a report of findings") === false);

  // --- 16. ②b inferLevelFromRoleAndTask (role/task → level override) ---
  check("inferLevel: read-only role ⇒ attested (even with implement task)", inferLevelFromRoleAndTask("read-only", "implement the feature") === "attested");
  check("inferLevel: writer role ⇒ checked (even with review task)", inferLevelFromRoleAndTask("writer", "review the code") === "checked");
  check("inferLevel: no role + read-only task ⇒ attested", inferLevelFromRoleAndTask(undefined, "review only, return findings") === "attested");
  check("inferLevel: no role + implementation task ⇒ undefined (defer to tools)", inferLevelFromRoleAndTask(undefined, "implement the feature") === undefined);
  check("inferLevel: no role + unknown + 'inspect' keyword ⇒ attested", inferLevelFromRoleAndTask(undefined, "inspect the logs") === "attested");
  check("inferLevel: no role + unknown + no keyword ⇒ undefined", inferLevelFromRoleAndTask(undefined, "explain the design") === undefined);
  check("inferLevel: no role + no task ⇒ undefined", inferLevelFromRoleAndTask(undefined, undefined) === undefined);

  // --- 17. ②b resolveAcceptance — role/task level-override (THE B feature, integrated) ---
  const roOverride = resolveAcceptance({ acceptanceRole: "read-only" }, "checked", "implement the auth module");
  check("B: read-only role OVERRIDES edit-tools ⇒ level attested", roOverride?.level === "attested");
  check("B: read-only role ⇒ badge-only (inferred true)", roOverride?.inferred === true);
  check("B: read-only role ⇒ no risky review (isWriter false)", !roOverride?.review);
  check("B: writer role OVERRIDES read-only-tools ⇒ level checked", resolveAcceptance({ acceptanceRole: "writer" }, "attested", "draft a summary report")?.level === "checked");
  check("B: read-only TASK wording downgrades edit-tools ⇒ level attested", resolveAcceptance({}, "checked", "review only, return findings")?.level === "attested");
  // INVARIANT: existing chains (no role + non-read-only task) ⇒ tools-based level UNCHANGED
  check("B INVARIANT: no role + implementation task + checked tools ⇒ unchanged (checked)", resolveAcceptance({}, "checked", "implement the feature")?.level === "checked");
  check("B INVARIANT: no role + unknown task + attested tools ⇒ unchanged (attested)", resolveAcceptance({}, "attested", "explain the design")?.level === "attested");
  // explicit level always wins over role/task inference
  const explicitWins = resolveAcceptance({ level: "verified", acceptanceRole: "read-only" }, "checked", "review only");
  check("B: explicit level verified wins over read-only role", explicitWins?.level === "verified" && explicitWins?.inferred === false);

  // --- 18. ②b normalizeCriterionStatus — every synonym → canonical (spec independently stated) ---
  const CRIT_SPEC: Array<[string, "satisfied" | "not-satisfied" | "not-applicable"]> = [
    ["satisfied", "satisfied"], ["met", "satisfied"], ["complete", "satisfied"], ["completed", "satisfied"], ["done", "satisfied"],
    ["pass", "satisfied"], ["passed", "satisfied"], ["success", "satisfied"], ["succeeded", "satisfied"],
    ["not-satisfied", "not-satisfied"], ["not-met", "not-satisfied"], ["unmet", "not-satisfied"],
    ["incomplete", "not-satisfied"], ["fail", "not-satisfied"], ["failed", "not-satisfied"],
    ["not-applicable", "not-applicable"], ["n-a", "not-applicable"], ["na", "not-applicable"],
    ["skip", "not-applicable"], ["skipped", "not-applicable"],
  ];
  for (const [syn, want] of CRIT_SPEC) check(`critStat: '${syn}' → '${want}'`, normalizeCriterionStatus(syn) === want);
  check("critStat: case-insensitive 'MET' → satisfied", normalizeCriterionStatus("MET") === "satisfied");
  check("critStat: trims ' passed ' → satisfied", normalizeCriterionStatus(" passed ") === "satisfied");
  check("critStat: unknown value passes through", normalizeCriterionStatus("maybe") === "maybe");
  check("critStat: non-string passes through (42)", normalizeCriterionStatus(42) === 42);

  // --- 19. ②b normalizeCommandResult — every synonym → canonical ---
  const CMD_SPEC: Array<[string, "passed" | "failed" | "not-run"]> = [
    ["passed", "passed"], ["pass", "passed"], ["success", "passed"], ["successful", "passed"], ["succeeded", "passed"], ["ok", "passed"],
    ["failed", "failed"], ["fail", "failed"], ["failure", "failed"], ["error", "failed"],
    ["not-run", "not-run"], ["not-executed", "not-run"], ["skip", "not-run"], ["skipped", "not-run"],
  ];
  for (const [syn, want] of CMD_SPEC) check(`cmdRes: '${syn}' → '${want}'`, normalizeCommandResult(syn) === want);
  check("cmdRes: unknown value passes through", normalizeCommandResult("pending") === "pending");
  check("cmdRes: non-string passes through (null)", normalizeCommandResult(null) === null);

  // --- 20. ②b canonicalizeReport wires enum normalization end-to-end (via parseAcceptanceReport) ---
  const synonymReport = "```acceptance-report\n" + JSON.stringify({
    criteriaSatisfied: [
      { id: "c1", status: "met", evidence: "x" },
      { id: "c2", status: "fail", evidence: "y" },
      { id: "c3", status: "skipped", evidence: "z" },
    ],
    commandsRun: [
      { command: "npm test", result: "success", summary: "ok" },
      { command: "tsc", result: "failure", summary: "type errors" },
    ],
  }) + "\n```";
  const syn = parseAcceptanceReport(synonymReport).report;
  check("canon e2e: criterion 'met' → 'satisfied'", syn?.criteriaSatisfied?.[0]?.status === "satisfied");
  check("canon e2e: criterion 'fail' → 'not-satisfied'", syn?.criteriaSatisfied?.[1]?.status === "not-satisfied");
  check("canon e2e: criterion 'skipped' → 'not-applicable'", syn?.criteriaSatisfied?.[2]?.status === "not-applicable");
  check("canon e2e: command 'success' → 'passed'", syn?.commandsRun?.[0]?.result === "passed");
  check("canon e2e: command 'failure' → 'failed'", syn?.commandsRun?.[1]?.result === "failed");

  // --- 21. ②b ADDITIVE invariant: a well-formed report canonicalizes to ITSELF ---
  const wellFormed = "```acceptance-report\n" + JSON.stringify({
    criteriaSatisfied: [{ id: "c1", status: "satisfied", evidence: "proof" }],
    commandsRun: [{ command: "npm test", result: "passed", summary: "ok" }],
  }) + "\n```";
  const wf = parseAcceptanceReport(wellFormed).report;
  check("additive: canonical 'satisfied' status unchanged", wf?.criteriaSatisfied?.[0]?.status === "satisfied");
  check("additive: canonical 'passed' result unchanged", wf?.commandsRun?.[0]?.result === "passed");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
