---
name: ask-jev
description: |
  Throw an ambiguous question at Jev — TypeSafe's System One classifier model —
  and get back calibrated typed answers with probabilities, at zero cost on the
  free tier (opencode provider, jev-1.13-free). Use when the operator says
  "ask jev", "second opinion", "what does jev think", or wants a structured,
  probabilistic take on a bounded question. Jev answers CHOICE / BOOL / SCORE
  questions about provided state — it never writes prose, so the question must
  be decomposed into typed questions with explicit criteria first. Do NOT use
  for: open-ended "what should I do" questions that cannot be framed as bounded
  options, code generation, or anything needing text output (jev cannot).
---

# ask-jev

Run the classify call through the `codemode` tool directly (no sub-agent —
the task-gate extension deadlocks headless sessions; this session's codemode
is the surface). Recipe:

```js
const jev = await models.getModelOfType("classifier", "opencode", "jev-1.13-free");
const r = await models.classify(jev, {
  state: { /* unstructured context: the situation, verbatim facts, constraints */ },
  questions: {
    q1: { type: "choice", instructions: "...", criteria: { A: "...", B: "...", C: "..." } },
    q2: { type: "bool", instructions: "...", criteria: { true: "...", false: "..." } },
    q3: { type: "score", instructions: "...", criteria: ["lowest", "...", "highest"] }, // MAX 5 levels — more returns {}
  },
});
return JSON.stringify({ answers: r.answers, usage: r.usage }, null, 1);
```

## Decomposition rules (this is the craft)

1. **State carries the facts, questions carry the judgment.** Put verbatim
   quotes, numbers, and constraints in `state`; never bury facts in criteria.
2. **One decision per question.** Split "should we do X and when" into a bool
   + a choice.
3. **Criteria are the ONLY place definitions live.** Each option gets a
   one-line meaning; make them mutually exclusive.
4. **Score scales: 3–5 levels, lowest first.** 11 levels silently returns
   empty answers on the free tier.
5. **Batch related questions in ONE call** — parallel sampler, same latency,
   one usage row.

## Reading the answer

- `choice` → `choice`, `probabilities` (full distribution), `confidence`.
- `bool` → `probability` (of true).
- `score` → `score` (expected level on the criteria scale), `confidence`.
- **Low confidence IS the answer** when the question is genuinely ambiguous —
  surface it as "Jev is split", not a failure.
- Usage arrives per call; free tier reports $0.00 (verified 2026-10-05).
  Paid `jev-1.13` same shape at $0.042/MTok input.

## Honesty protocol

Report Jev's answers AS a classifier's answers, alongside your own reasoning —
never as a verdict. Calibration quality is the thing being trialed; note
where Jev's confidence disagrees with your judgment. If the captain's
question cannot be bounded into typed questions, say so and propose the
decomposition first instead of forcing a frame.
