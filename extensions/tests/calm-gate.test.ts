// Unit tests for the Calm fleet gate (absorption round item D).
// The gate is the only fleet-authored logic; calm.ts itself is upstream
// (MIT, verbatim) and is exercised by the operator's PI_CALM=1 trial.
// Importing index.ts also smoke-tests the whole calm module graph (calm.ts
// + 5 lib files) — an upstream import break fails this file at load time.

import { calmActive } from "../calm/index.ts";

let passed = 0;
const failures: string[] = [];

function run(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`);
        console.error(`  ✗ ${name}: ${(e as Error).message}`);
    }
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

run("gate: default env → inactive (staged off)", () => {
    assertEq(calmActive({}), false, "unset");
});
run("gate: PI_CALM=1 → active (trial sessions)", () => {
    assertEq(calmActive({ PI_CALM: "1" }), true, "=1");
});
run("gate: PI_CALM=0 → inactive (explicit opt-out)", () => {
    assertEq(calmActive({ PI_CALM: "0" }), false, "=0");
});
run("gate: PI_CALM=anything-else → inactive (strict match)", () => {
    assertEq(calmActive({ PI_CALM: "true" }), false, "true");
    assertEq(calmActive({ PI_CALM: "yes" }), false, "yes");
});
run("module graph: calm.ts + libs import cleanly (load-time smoke)", () => {
    // reaching here means every import in the chain resolved — the smoke test IS the pass
    assertEq(typeof calmActive, "function", "export shape");
});

if (failures.length > 0) {
    console.error(`calm-gate: ${failures.length}/${passed + failures.length} FAILED`);
    process.exit(1);
}
console.log(`calm-gate: ${passed} passed`);
