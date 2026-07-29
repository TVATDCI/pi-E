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
  parseAcceptanceReport,
  evaluateAcceptance,
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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
