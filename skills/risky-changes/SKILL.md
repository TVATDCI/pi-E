---
name: risky-changes
description: |
  Mandatory verification discipline BEFORE implementing any risky change — new or
  changed public API fields or filters, provider/data-source behavior changes,
  billing/pricing/caps logic, changed defaults that shape what users see. Fires
  whenever a change rests on an unverified assumption about real-world data or
  user behavior. Triggers: "risky change", "is this safe to ship", "verify this
  assumption", planning anything customer-visible or expensive-if-wrong. Do NOT
  use for: code correctness (that's review-loop), routine refactors, or changes
  whose worst case is a localized fixable bug.
---

# Risky Changes

Unit and integration tests prove the code does what you coded. They cannot prove
the change is a good idea. That takes research and live measurement. (Pattern
absorbed from davidondrej/skills 2026-08-17; born from a real failure — a
"source-backed answers only" filter shipped on assumption + green tests, and
live data later showed it killed ~99% of the feature.)

## When this fires

Any change where being wrong is expensive or user-visible:

- New or changed public API fields, filters, or response shaping
- Anything that drops, transforms, or reorders upstream/provider data
- Billing, pricing, caps, or quota logic
- Changed defaults, thresholds, or provider request parameters
- Any assumption about how external data behaves ("X usually has Y")

If unsure whether a change qualifies, it qualifies.

## The process

### 1. Name the assumptions out loud
List every assumption the change rests on. For each: "verified, or just sounds
reasonable?" Sounding reasonable is how dead features ship.

### 2. Research per distinct question — pi-native
One research pass per distinct question, never one vague mega-prompt:

- What do best-in-class products do for this exact design decision?
- What does the real-world data distribution look like (frequencies, shapes, edge cases)?
- What do users/agents actually need in this situation?

Compose each as a tight research brief (research-prompt discipline), then run it
web-side (`web_search` batches, ≥4 queries for extensive research, citation
contract: provider+URL per load-bearing claim) or via a `researcher` dispatch.
If findings contradict the assumption, stop and rethink BEFORE writing code.

### 3. Live measurement suite — 10–20+ real tests
Not unit tests. Real requests against the real endpoint/service, measuring the
actual change:

- 10–20+ unique, creative, REALISTIC cases from real usage — topics, params,
  languages, edge conditions
- Hard numbers per case where possible (faster? better? how often does the new
  behavior fire?); blind criteria-based LLM-as-judge where quality is subjective
- Compare before vs after when both are measurable; reads of live/production
  data count as measurement

Record the suite + numbers in `docs/evals/YYYY-MM-DD-<slug>.md` in the project
(create the folder if missing). A change with no measurement file is not verified.

### 4. Human sign-off
Anything a user sees or pays for is the operator's decision — surface the
choice BEFORE shipping, with research and numbers attached. Never bury it in a
plan or a code default. (Operator-arbiter doctrine.)

### 5. Verify after shipping
Within a day of deploy, measure the change on real traffic. If numbers disagree
with expectation, say so immediately — don't wait for someone to notice.

## Failure modes

- "The unit tests pass" — irrelevant to whether the change is good. Run the live suite.
- "Research would slow me down" — one research pass takes a minute and costs
  cents; a dead feature costs a day plus rework.
- "The assumption is obviously true" — that is exactly the assumption this
  skill exists for.
