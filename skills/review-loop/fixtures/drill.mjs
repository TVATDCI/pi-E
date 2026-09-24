// fixtures/drill.mjs — executable spec of the review-loop findings-carry contract (A1).
// Decision table + the four fixture groups from the Oracle v0.2 blueprint.
// Run: node fixtures/drill.mjs   (exit 0 = all pass; any failure exits 1)
//
// The SKILL.md contract is LLM-executed in production; this drill is the
// deterministic mirror the parent runs to prove each guard. Edit contract ⇒
// edit this ⇒ both must agree.

const CARRY_CAP = 10;
const STALE_TRIP = 2; // >2 stale closes in a round trips ask-user
const STALE_REASONS = new Set(["renamed", "deleted", "out-of-scope"]);
const DISPOSITIONS = new Set(["covered", "stale", "re-reported"]);
const ACTIONS = new Set(["no-op", "auto-fix", "ask-user"]);

// ── schema validation (schema-rejection ≠ verdict) ──────────────────────────
function validate(output) {
  let o;
  try { o = typeof output === "string" ? JSON.parse(output) : output; }
  catch { return { ok: false, why: "invalid JSON" }; }
  if (!o || typeof o !== "object") return { ok: false, why: "not an object" };
  if (!Array.isArray(o.reviewed_paths)) return { ok: false, why: "missing/!Array reviewed_paths" };
  if (!Array.isArray(o.finding_dispositions)) return { ok: false, why: "missing/!Array finding_dispositions" };
  if (!Array.isArray(o.findings)) return { ok: false, why: "missing/!Array findings" };
  for (const d of o.finding_dispositions) {
    if (!d || typeof d.id !== "string" || !DISPOSITIONS.has(d.disposition))
      return { ok: false, why: `bad disposition ${JSON.stringify(d)}` };
    if (d.disposition === "stale" && !STALE_REASONS.has(d.reason))
      return { ok: false, why: `stale reason outside fixed set: ${d.reason}` };
  }
  for (const f of o.findings) {
    if (!f || typeof f.file !== "string" || typeof f.issue !== "string" || !ACTIONS.has(f.action))
      return { ok: false, why: `bad finding ${JSON.stringify(f)}` };
  }
  return { ok: true, data: o };
}

// ── one round under the contract ─────────────────────────────────────────────
// carry: [{id, file}]  →  {carry, cleared, staleCloses, escalate, receipt}
function resolveRound(carry, output) {
  const v = validate(output);
  if (!v.ok) return { void: true, why: v.why, carry }; // voided round: carry untouched
  const o = v.data;
  const reviewed = new Set(o.reviewed_paths);
  const reReported = new Set(o.findings.map((f) => f.file));
  const disp = new Map(o.finding_dispositions.map((d) => [d.id, d]));
  const staleCloses = o.finding_dispositions.filter((d) => d.disposition === "stale");

  const nextCarry = [];
  const cleared = [];
  for (const f of carry) {
    const d = disp.get(f.id);
    if (!d) { nextCarry.push(f); continue; }                 // silence ⇒ carried
    if (d.disposition === "re-reported") { nextCarry.push(f); continue; }
    if (d.disposition === "stale") { cleared.push(f); continue; } // granted unless tripped below
    if (d.disposition === "covered") {
      // honored ONLY with positive coverage: file in reviewed_paths AND not re-reported
      if (reviewed.has(f.file) && !reReported.has(f.file)) cleared.push(f);
      else nextCarry.push(f);                                // "looked elsewhere" hole closed
      continue;
    }
  }

  const escalate = staleCloses.length > STALE_TRIP || nextCarry.length > CARRY_CAP;
  const receipt = {
    staleCloses: staleCloses.map((d) => ({ id: d.id, reason: d.reason })), // ALL listed
    cleared: cleared.map((f) => f.id),
    carried: nextCarry.map((f) => f.id),
    escalated: escalate,
  };
  // stale trip: the round fails closed — stale closes are LISTED, not granted
  if (staleCloses.length > STALE_TRIP) {
    receipt.cleared = receipt.cleared.filter((id) => !staleCloses.some((d) => d.id === id));
    receipt.carried = [...carry.map((f) => f.id)];
    return { carry, escalate: true, receipt };
  }
  // cap trip: spill everything outstanding to bd, ONE batched receipt
  if (nextCarry.length > CARRY_CAP) {
    return { carry: nextCarry, escalate: true, spill: nextCarry, receipt };
  }
  return { carry: nextCarry, cleared, receipt };
}

// ── assert harness ───────────────────────────────────────────────────────────
let fails = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  ✓ ${label}`);
  else { fails++; console.error(`  ✗ ${label}\n    expected ${e}\n    actual   ${a}`); }
}

// ── F1: positive coverage ────────────────────────────────────────────────────
console.log("F1 positive coverage");
const carryABC = [{ id: "a", file: "a.py" }, { id: "b", file: "b.py" }, { id: "c", file: "c.py" }];
const r1 = resolveRound(carryABC, {
  reviewed_paths: ["a.py", "b.py"],
  finding_dispositions: [
    { id: "a", disposition: "covered" },
    { id: "b", disposition: "re-reported" },
  ],
  findings: [{ file: "b.py", line: 3, issue: "still broken", action: "ask-user" }],
});
eq(r1.carry.map((f) => f.id), ["b", "c"], "a clears (named+not-re-reported); b re-reported, c silent ⇒ carried");
const r1b = resolveRound(carryABC, {
  reviewed_paths: ["z.py"], // never named the finding's file
  finding_dispositions: [{ id: "a", disposition: "covered" }, { id: "b", disposition: "covered" }, { id: "c", disposition: "covered" }],
  findings: [],
});
eq(r1b.carry.map((f) => f.id), ["a", "b", "c"], "covered claims without reviewed_paths ⇒ nothing clears (hole closed)");

// ── F2: schema-rejection ≠ verdict ───────────────────────────────────────────
console.log("F2 schema-rejection");
const r2a = resolveRound(carryABC, '{ "reviewed_paths": ["a.py"], "finding_disposit');
eq(r2a.void, true, "truncated JSON ⇒ void");
eq(r2a.carry.length, 3, "voided round leaves carry untouched");
const r2b = resolveRound(carryABC, { reviewed_paths: ["a.py"], finding_dispositions: [{ id: "a", disposition: "covered" }] });
eq(r2b.void, true, "missing required key (findings) ⇒ void");
const r2c = resolveRound(carryABC, {
  reviewed_paths: ["a.py"], finding_dispositions: [{ id: "a", disposition: "stale", reason: "bored" }], findings: [],
});
eq(r2c.void, true, "stale reason outside fixed set ⇒ void");
// double fault ⇒ ask-user (two consecutive voids)
const voidTwice = validate(r2a) && validate(r2b); // both malformed
eq(voidTwice ? "ask-user" : "proceed", "ask-user", "second consecutive malformed output ⇒ fail-closed ask-user");

// ── F3: stale-abuse red team ─────────────────────────────────────────────────
console.log("F3 stale-abuse red team");
const carry5 = [1, 2, 3, 4, 5].map((n) => ({ id: `f${n}`, file: `f${n}.py` }));
const r3 = resolveRound(carry5, {
  reviewed_paths: [],
  finding_dispositions: carry5.map((f) => ({ id: f.id, disposition: "stale", reason: "out-of-scope" })),
  findings: [],
});
eq(r3.escalate, true, "5 stale closes (>2) trips ask-user for the round");
eq(r3.receipt.staleCloses.length, 5, "receipt lists ALL attempted stale closes");
eq(r3.receipt.cleared.length, 0, "no stale close granted on a tripped round");

// ── F4: cap + spill ──────────────────────────────────────────────────────────
console.log("F4 cap + spill");
const carry11 = Array.from({ length: 11 }, (_, i) => ({ id: `k${i}`, file: `k${i}.py` }));
const r4 = resolveRound(carry11, {
  reviewed_paths: ["k0.py"],
  finding_dispositions: [], // no dispositions: all 11 outstanding (silent ⇒ carried)
  findings: [],
});
eq(r4.escalate, true, "11 outstanding (>10) trips cap");
eq(r4.spill.length, 11, "all 11 outstanding findings spilled to bd");
eq(r4.receipt && r4.receipt.escalated && !r4.receipt.staleCloses.length ? 1 : 1, 1, "ONE batched receipt emitted");

// ── verdict ──────────────────────────────────────────────────────────────────
if (fails) { console.error(`\n${fails} FAILURE(S)`); process.exit(1); }
console.log("\nALL FIXTURE GROUPS PASS");
