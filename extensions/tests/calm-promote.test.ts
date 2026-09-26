// Calm promote tests (ADR-0008): registration contract — the ungated default
// export registers the /calm command + the four lifecycle handlers, and NEVER
// registers semantic interceptors (input/tool_call/tool_result/context — the
// zero-coupling runtime proof, TS mirror of the ported bash suite's node
// checks). Module-graph load smoke included.

import calm from "../calm/index.ts";

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

function assert(cond: boolean, label: string): void {
    if (!cond) throw new Error(label);
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

const handlers = new Map<string, number>();
const commands = new Map<string, unknown>();
let registerToolCalls = 0;

const pi = {
    on(event: string): void {
        handlers.set(event, (handlers.get(event) ?? 0) + 1);
    },
    registerCommand(name: string, def: unknown): void {
        commands.set(name, def);
    },
    registerTool(): void {
        registerToolCalls++;
    },
} as never;

calm(pi);

run("registers the /calm command", () => {
    assert(commands.has("calm"), "/calm command not registered");
});
run("registers all four lifecycle handlers", () => {
    for (const ev of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) {
        assert(handlers.has(ev), `missing ${ev} handler`);
    }
});
run("NO semantic interceptors (zero coupling)", () => {
    for (const forbidden of ["input", "tool_call", "tool_result", "context"]) {
        assert(!handlers.has(forbidden), `registered forbidden ${forbidden} interceptor`);
    }
    assertEq(registerToolCalls, 0, "registered tools");
});
run("module graph loads clean (load-time smoke)", () => {
    assertEq(typeof calm, "function", "default export shape");
});

if (failures.length > 0) {
    console.error(`calm-promote: ${failures.length}/${passed + failures.length} FAILED`);
    process.exit(1);
}
console.log(`calm-promote: ${passed} passed`);
