// Pi Calm — fleet-staged deployment (absorption round item D, 2026-09-25).
//
// Source: kunchenguid/dotfiles calm extension (MIT, Kun Chen; adapted from
// Firstmate). Presentation-only: hides collapsed thinking + built-in tool
// shells from the transcript; /export and /share render the full stock
// transcript. Implementation lives in ./calm.ts (renamed from index.ts,
// otherwise verbatim).
//
// FLEET GATE: staged INACTIVE by default. Set PI_CALM=1 in the environment
// to activate for a trial session. Operator verdict pending (promote →
// ADR-0008 + full test-port; drop → delete directory). Until then this file
// guarantees zero behavior change fleet-wide: ungated sessions register
// nothing, write nothing, render stock.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import calmImpl from "./calm.ts";

/** Gate decision, exported for unit tests. */
export function calmActive(env: Record<string, string | undefined> = process.env): boolean {
    return env.PI_CALM === "1";
}

export default function calm(pi: ExtensionAPI): void {
    if (!calmActive()) return; // staged off — stock presentation, no writes
    calmImpl(pi);
}
