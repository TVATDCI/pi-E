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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
