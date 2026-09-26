// Wrapper: runs the ported Calm behavioral suite (tests/calm/pi-calm.test.sh)
// inside the pi-E test runner so the bash suite rides the same discovery,
// pre-commit gate, and CI surface as the TS tests. The bash suite self-skips
// environment-dependent classes (tsc, chrome, pi/tmux) when tools are absent.
// run-tests-timeout: 300000
//
// ENV NOTE (2026-09-26 promote): the runner's env whitelist strips mise's
// injected vars, and ~/.local/bin/pi (the mise wrapper) BLOCKS without them
// (mise use -g hangs). Fix: resolve the real mise-installed pi ELF and front
// a shim dir on PATH so every `pi` invocation in the suite — including the
// in-tmux spawn — hits the binary directly. Falls back to inherited PATH
// when the mise layout is absent (interactive runs work either way).

import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const suite = join(import.meta.dirname, "..", "..", "tests", "calm", "pi-calm.test.sh");

const env: Node.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TERM: process.env.TERM ?? "xterm-256color",
    LANG: "C.UTF-8",
};

// Real pi binary (mise layout) — bypasses the blocking wrapper script.
const misePi = join(process.env.HOME ?? "", ".local", "share", "mise", "installs", "pi", "latest", "pi", "pi");
let shimDir = "";
try {
    // probe: the ELF must answer --version fast under this stripped env
    execFileSync(misePi, ["--version"], { encoding: "utf8", timeout: 15_000, env });
    shimDir = join(tmpdir(), `calm-suite-shim-${process.pid}`);
    mkdirSync(shimDir, { recursive: true });
    symlinkSync(misePi, join(shimDir, "pi"));
    env.PATH = `${shimDir}:${env.PATH}`;
} catch {
    shimDir = ""; // no mise layout / probe failed → inherited PATH (interactive ctx is fine)
}

try {
    const out = execFileSync("bash", [suite], {
        encoding: "utf8",
        timeout: 280_000,
        env,
        maxBuffer: 16 * 1024 * 1024,
    });
    for (const line of out.split("\n")) {
        if (line.startsWith("ok -") || line.startsWith("skip:")) console.log(`  ${line}`);
    }
    console.log(`  ✓ calm behavioral suite (bash) exited 0`);
} catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    console.error(`  ✗ calm behavioral suite failed: ${err.message}`);
    if (err.stdout) console.error(err.stdout.split("\n").slice(-40).join("\n"));
    if (err.stderr) console.error(err.stderr.split("\n").slice(-10).join("\n"));
    process.exitCode = 1;
} finally {
    if (shimDir) rmSync(shimDir, { recursive: true, force: true });
}
