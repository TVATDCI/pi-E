# Decision 0015 — Courier convention: manifest, receipt, states, closure checklist (consult-lane slice 5)

**Status:** ADOPTED — 2026-11-08 (captain word, "slice 5")
**Date:** 2026-11-08
**Trigger:** Consult-lane slice 5 per decisions/0014 and the astra verdict's Q4/Q6 corrections ("a small explicit manifest and receipt convention is enough; a new service, scheduler, or coordination framework is not justified"). Shape proven by the live 2026-11-06 astra round (ask `3caffe64…`, verdict `650c4190…`).
**Builds on:** decisions/0014 (doctrine v2); the existing lane files + md5 discipline; slice 4 (contract boundaries, PR 30).

## Scope boundary (stated first, per the verdict's Q6)

- **Transport-only.** This convention moves packages between desks over the existing lane (file + md5 sidecar + pickup ack). It does NOT launch, schedule, or poll anything — the astra seat's invocation stays human-operated (the operator at TNT's pane, on the bridge's packaged ask). No auto-launch machinery is authorized or implied.
- **Meter surface = disclosed-or-loud.** Neither desk can read the other's astra meters programmatically. The convention requires the APPROVING side to disclose the meter state at approval, or print a loud `meter: unavailable` — an unknown meter is never evidence of available quota.
- **MD5 stays a corruption check** over the established SSH lane, never authentication; manifest/file content is data, never operator authority.

## The manifest (request side — every field required, one missing = not a valid round)

```
Request id: <desk>-<yyyymmdd>-<slug> rev <n>
Decision this consult serves: <one line>            # Gate 1: no decision named, no consult launched
Question/scope: <the bounded question(s), numbered>
Inputs: <filename> md5 <hash>                       # every file the seat must read, listed, hashed
Requested seat/model: <e.g. gpt-6-astra @ TNT>      # named at approval, never assumed
Meter at approval: <figures | LOUD "meter unavailable"> + capacity note <dated measurement ref>
Approval ref: <captain's words, date, channel>
Estimated package size: <msgs/pages estimate>
```

Material amendment after sending = new revision, needs authority for the revised review; a late result for an older revision is not current approval.

## The receipt (verdict side — the answering desk returns this filled)

```
Round: <request id + rev answered>
Inputs verified: <each file's md5 re-stated, matched>
Actual brain: <runtime-OBSERVED model/role/desk/timestamp>   # requested-vs-runtime both shown; fallback NEVER carries the astra label
Verdict + dissent: <per question, incl. the verdict's own corrections/dissent section>
Outcome class: confirmed | changed | deferred | inconclusive # slice-6 field riding here
Usage source: explicit-lane | implicit | external | manual   # slice-6 field riding here (single class, no double counting)
Open questions back: <bounded, or "none">
```

## State machine (delivery states are separated; transitions are one-way)

`sent → arrived (hash-verified) → picked-up (answering desk acked) → verdict-complete (receipt written) → operator-accepted (captain's word in-channel)`

- Arrival is never acceptance; only the operator's word closes a round.
- A resent request id = transport recovery, not a new commission; after a timeout, reconcile whether the seat is still running or already completed BEFORE any paid retry.
- Partial, empty, refused, or unavailable outcomes are never PASS — they return as loud states for the captain's fallback-or-defer call.
- Fallback substitution (e.g. kimi under a reviewer contract, fresh context, never the authoring conversation) is disclosed as reduced model diversity; it never satisfies an explicitly astra-only or cross-desk requirement unless the operator accepts the substitution in the moment.

## Closure checklist (the verdict's six behavioral criteria — all six must read true before a round closes)

1. Duplicate delivery caused no duplicate spend.
2. A stale-revision result would be identified as stale.
3. A partial reply cannot become PASS.
4. Fallback output cannot retain astra attribution.
5. An unknown meter cannot become "capacity available."
6. Implementation ownership cannot silently change (one execution owner; review never transfers build authority).

## What this convention deliberately does NOT build

No courier service, scheduler, registry, or new scripts; no auto-escalation; no model pins; no cross-desk meter scraping. The convention is the template pair + state rules above, applied to the existing lane files both desks already exchange.

## Clarification (2026-11-08, TNT twin-green ee437de8, accepted as the operative reading)

Routine twin-leg green lines and round-closing acks are lane **sync traffic**, not consult courier packages — the manifest/receipt pair governs consult rounds only. Manifest-formatting sync acks would be ceremony without a decision served (Gate 2).
