// Pi Calm — PROMOTED first-class fleet extension (ADR-0008, 2026-09-26).
// Copyright (c) 2026 Kun Chen. MIT License - see the LICENSE file in this directory.
//
// Source: kunchenguid/dotfiles calm extension (MIT, Kun Chen). Implementation adapted from Firstmate.
// Presentation-only: hides collapsed thinking + built-in tool
// shells from the transcript; /export and /share render the full stock
// transcript. Implementation lives in ./calm.ts (verbatim upstream; index.ts
// of the source repo, renamed to keep this fleet header).
//
// History: staged 2026-09-25 behind an env gate (absorption item D); operator
// trials passed BOTH desks 2026-09-26 (combo: pi-native Ctrl+T collapses
// thinking content, /calm then hides the residual label rows — see ADR-0008);
// promote ruling same day — the env gate is RETIRED. /calm toggles
// presentation per agent-dir (state file ~/.pi/agent/calm, gitignored).
// Full behavioral suite: tests/calm/pi-calm.test.sh (ported upstream suite).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import calmImpl from "./calm.ts";

export default function calm(pi: ExtensionAPI): void {
    calmImpl(pi);
}
