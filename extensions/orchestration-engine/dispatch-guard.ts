// dispatch-guard.ts — operator-only vehicle guard (sis plan 2026-09-18 §1.2 layer 2, C10).
// PURE + zero-dep (unit-testable in isolation — the wiring lives in index.ts).
//
// CONTRACT:
//  - The AUTO dispatch path (caller omitted `agent=`) into an operator-only category or onto an
//    operator-only persona (frontmatter `operatorOnly: true`, parsed by loadPersona) is REFUSED
//    with a bounce unless the OPERATOR DISPATCH MARKER is present with valid provenance.
//  - The EXPLICIT `agent=` path is NEVER guarded (Charter 0.6 — explicit dispatch stays legal).
//  - MARKER PROVENANCE ([ORACLE CONDITION 1]): the marker is honored ONLY when injected by the
//    operator dispatch path itself — a human-typed pi input (source "interactive", the seam owned
//    by lib/upstream-adapter.ts) whose text names the vehicle. A marker self-asserted in task
//    text, handoff/sub-agent context, or persona output FAILS CLOSED: detected, named in the
//    bounce, never honored. The index.ts wiring feeds trustedOperatorText exclusively from that
//    input seam, so an LLM-emitted string can never satisfy it.
//  - Fail-closed: a missing or unverifiable marker on the auto path bounces.

import type { TaskCategory } from "./tier-map.ts";

/** The marker token: the operator naming the vehicle in their own typed input arms the guard's
 *  pass path. Deliberately the persona name — "mention it to dispatch it" needs no new syntax. */
export const OPERATOR_ONLY_MARKER = "home-keeper";

/** The bounce (§1.2 layer 2 wording). Distinct from tier-map.ts familyExhaustedMessage —
 *  "not authorized" vs "vehicle unavailable" ([ORACLE CONDITION 3]). */
export const OPERATOR_ONLY_BOUNCE =
  "Error: home-keeper is an operator-only vehicle; re-route or hand to the operator. " +
  "Explicit agent=home-keeper stays legal; auto-routing into local-research requires the " +
  "operator's own dispatch marker (name home-keeper in a typed message, same turn).";

export type MarkerProvenance =
  | "operator-input"
  | "task-text"
  | "sub-agent-context"
  | "persona-output";

export interface OperatorOnlyGuardInput {
  category: TaskCategory | string;
  /** true when the caller passed an explicit agent= — the legal, unguarded path. */
  agentProvided: boolean;
  /** persona name the AUTO path would seat (resolveFunctionalAgent(category)). */
  autoAgent?: string;
  /** the auto persona's operatorOnly frontmatter marker (loadPersona). */
  autoAgentOperatorOnly?: boolean;
  /** the dispatch task text — UNTRUSTED surface for the marker. */
  task: string;
  /** handoff / sub-agent context — UNTRUSTED surface for the marker. */
  context?: string;
  /** prior persona output — UNTRUSTED surface for the marker. */
  personaOutput?: string;
  /** raw text of the operator's typed input — ONLY ever sourced from a human turn
   *  (input source "interactive"). This is the sole honored provenance. */
  trustedOperatorText?: string;
}

export type OperatorOnlyGuardResult =
  | { decision: "allow"; guarded: boolean }
  | {
      decision: "bounce";
      message: string;
      error: "operator-only-bounce";
      /** the untrusted surface a self-asserted marker was detected in (named, not honored). */
      rejectedProvenance?: MarkerProvenance;
    };

function carriesMarker(text: string | undefined): boolean {
  return typeof text === "string" && text.toLowerCase().includes(OPERATOR_ONLY_MARKER);
}

/** Decide one dispatch. Pure: no I/O, no side effects. */
export function guardOperatorOnlyAutoPath(
  input: OperatorOnlyGuardInput,
): OperatorOnlyGuardResult {
  // Explicit agent= is the legal operator path (Charter 0.6) — guard inert.
  if (input.agentProvided) return { decision: "allow", guarded: false };

  // The auto path is guarded when it routes into the operator-only category OR auto-seats a
  // persona carrying the operatorOnly marker (category route OR persona name — both legs).
  const guardedCategory = input.category === "local-research";
  const guardedPersona = input.autoAgentOperatorOnly === true;
  if (!guardedCategory && !guardedPersona) return { decision: "allow", guarded: false };

  // Trusted provenance: only the operator's own typed input satisfies the marker.
  if (carriesMarker(input.trustedOperatorText)) {
    return { decision: "allow", guarded: true };
  }

  // Fail closed — and NAME the untrusted surface when a marker was self-asserted there.
  const rejected: MarkerProvenance | undefined = carriesMarker(input.task)
    ? "task-text"
    : carriesMarker(input.context)
      ? "sub-agent-context"
      : carriesMarker(input.personaOutput)
        ? "persona-output"
        : undefined;
  return {
    decision: "bounce",
    message: OPERATOR_ONLY_BOUNCE,
    error: "operator-only-bounce",
    ...(rejected ? { rejectedProvenance: rejected } : {}),
  };
}
