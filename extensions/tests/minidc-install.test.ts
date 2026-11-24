// extensions/tests/minidc-install.test.ts — the R2 install.sh unit matrix (design §8).
// Run: node --experimental-strip-types minidc-install.test.ts
// run-tests-timeout: 120000
//
// Drives broker/install.sh in its TEST MODE (MINIDC_INSTALL_TEST_ROOT scratch tree;
// systemctl/findmnt/fuser/brokerctl/mount-helper are harness stubs in $T/bin). Covers:
// the full fresh install (ledger phases, P4 mode pass, the EMPTY P4 journal, unit
// templates substituted, marker, stub mirroring AFTER activation), the broker-marker
// P0 refusal, the NOPASSWD assertion, full rollback to the restored end state, the
// ordered-discard crash pins (before/after the ledger unlink), the no-ledger
// finalization (idempotence, residue sweep, orphan-marker removal), resume after a
// P3 crash, the rules:null variant, legacy mode, repair-mode reconciliation, and
// code-shape pins (ledger-first discard; no post-unlink ledger write; no --now).
// Soak-defect matrix (2026-11-24): D2 (legacy flip materializes/restores the rules
// file), D3 (every mode command exits tuple-consistent — BROKER/LEGACY, never
// CONFLICT), D4 (readable rules-view modes + the old-install repair heal).
// Root-dependent legs (real systemd, real mounts, chown, the compiled helper's live
// syscalls) are install-stage validation — named in the build report.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as yamlParse } from "yaml";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALL = join(REPO, "broker", "install.sh");
const INSTALL_SRC = fs.readFileSync(INSTALL, "utf8");

let pass = 0, fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}
function section(name: string): void { console.log(`\n— ${name}`); }

const T = fs.mkdtempSync("/tmp/minidc-install-test-");
const HOME = join(T, "home", "tester");
const STORE = join(HOME, ".pi", "agent", "mini-dc");
const LEGACY_RULES = join(HOME, ".pi", "agent", "mini-dc-rules.yaml");
const MARKER = join(HOME, ".pi", "agent", "mini-dc-install-mode");
const BACKING = join(T, "var", "lib", "minidc-broker");
const LEDGER = join(BACKING, "install-state.json");
const JOURNAL = join(BACKING, "repair-journal.jsonl");
const STATE = join(BACKING, "state");
const UNIT_DIR = join(T, "etc", "systemd/system");
const BIN = join(T, "bin");
const MOUNTS = join(T, "mounts.table"); // the real-semantics mount table (finding 9)

function w(path: string, content: string, mode?: number): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
  if (mode !== undefined) fs.chmodSync(path, mode);
}

function stubs(): void {
  // real-semantics mount table base: the root filesystem + /tmp (an ordinary parent
  // mount — the containing-filesystem control finding 9 requires)
  w(MOUNTS, "/\n/tmp\n");
  w(join(BIN, "systemctl"), `#!/usr/bin/env bash
# test stub: state-driven ActiveState answers + call log
LOG="\${MINIDC_INSTALL_TEST_ROOT}/systemctl.log"
echo "$*" >> "$LOG"
mkdir -p "\${MINIDC_INSTALL_TEST_ROOT}/unitstate"
CMD="$1"; shift
u=""
for a in "$@"; do
  [[ "$a" == -* ]] && continue
  [[ "$a" == ActiveState || "$a" == --value || "$a" == -p ]] && continue
  u="$a"
done
case "$CMD" in
  show) f="\${MINIDC_INSTALL_TEST_ROOT}/unitstate/$u"
    if [[ -f "$f" ]]; then cat "$f"; else echo inactive; fi ;;
  start) for a in "$@"; do [[ "$a" == -* ]] && continue
      u="$a"
      if [[ -f "\${MINIDC_INSTALL_TEST_ROOT}/unitfail/$u" ]]; then
        echo failed > "\${MINIDC_INSTALL_TEST_ROOT}/unitstate/$u"
      else
        echo active > "\${MINIDC_INSTALL_TEST_ROOT}/unitstate/$u"
        if [[ "$u" == minidc-mounts.service ]]; then
          "\${MINIDC_INSTALL_TEST_ROOT}/usr/lib/minidc/minidc-mount-helper" || true
        fi
      fi
    done ;;
  stop) for a in "$@"; do [[ "$a" == -* ]] && continue
      echo inactive > "\${MINIDC_INSTALL_TEST_ROOT}/unitstate/$a"
      if [[ "$a" == minidc-mounts.service ]]; then
        "\${MINIDC_INSTALL_TEST_ROOT}/usr/lib/minidc/minidc-mount-helper" --stop || true
      fi
    done ;;
  daemon-reload|enable|disable) : ;;
  *) : ;;
esac
exit 0
`, 0o755);
  w(join(BIN, "findmnt"), "#!/usr/bin/env bash\n# real-semantics stub (finding 9): answers the DEEPEST mount at-or-above\n# --target, exactly what real findmnt answers - the containing filesystem\n# for ordinary paths, P itself when P is the mountpoint. The installer's\n# mounted_exactly() then pins exact-identity against BOTH shapes.\ntab=\"\${MINIDC_INSTALL_TEST_ROOT}/mounts.table\"\ntarget=\"\"\nfor a in \"$@\"; do\n  case \"$a\" in\n    --target|-n|-o|TARGET) : ;;\n    *) target=\"$a\" ;;\n  esac\ndone\n[[ -f \"$tab\" ]] || exit 1\nbest=\"\"\nwhile IFS= read -r m; do\n  [[ -z \"$m\" ]] && continue\n  if [[ \"$target\" == \"$m\" || \"$target\" == \"$m\"/* ]]; then\n    if (( ${#m} > ${#best} )); then best=\"$m\"; fi\n  fi\ndone < \"$tab\"\nif [[ -n \"$best\" ]]; then echo \"$best\"; exit 0; fi\nexit 1\n", 0o755);
  w(join(BIN, "fuser"), `#!/usr/bin/env bash
exit 1
`, 0o755);
  w(join(BIN, "minidc-brokerctl"), `#!/usr/bin/env bash
# status probe stub — always a well-formed frame
echo '{"ok":true}'
exit 0
`, 0o755);
  // the mount-helper stub: activation journals created-stub rows + writes health;
  // --stop writes unhealthy first and clears the mount flags
  const storeWhere = STORE;
  const rulesWhere = join(HOME, ".pi", "agent", "mini-dc-rules");
  void 0;
  w(join(BIN, "minidc-mount-helper"), `#!/usr/bin/env bash
# helper stub (bin/ copy — same semantics as the payload below): activation
# APPENDS the two mountpoints to mounts.table (exact binds) + journals
# created-stub rows; --stop writes unhealthy FIRST then removes exactly those
# two table lines. Template literal: storeWhere/rulesWhere INTERPOLATE (fix2
# new-finding-3 — the JSON-string form emitted literal '${storeWhere}'
# and its mkdir created the debris dirs under the test cwd).
ROOT="\${MINIDC_INSTALL_TEST_ROOT}"
BACKING="$ROOT/var/lib/minidc-broker"
JOURNAL="$BACKING/repair-journal.jsonl"
HEALTH="$BACKING/state/mount-health.json"
TAB="$ROOT/mounts.table"
add_mount() { grep -qxF "$1" "$TAB" 2>/dev/null || echo "$1" >> "$TAB"; }
del_mount() { grep -vxF "$1" "$TAB" 2>/dev/null > "$TAB.new" || true; mv "$TAB.new" "$TAB"; }
if [[ "\${1:-}" == "--stop" ]]; then
  printf '{"healthy":false,"boot-id":"stop","checked-at":"now","findings":["service-stop"]}' > "$HEALTH"
  del_mount '${storeWhere}'
  del_mount '${rulesWhere}'
  exit 0
fi
printf '{"healthy":false,"boot-id":"start","checked-at":"now","findings":["activation-started"]}' > "$HEALTH"
if [[ ! -d '${storeWhere}' ]]; then
  mkdir -p '${storeWhere}'
  echo "created-stub:${storeWhere}" >> "$JOURNAL"
fi
add_mount '${storeWhere}'
if [[ ! -d '${rulesWhere}' ]]; then
  mkdir -p '${rulesWhere}'
  echo "created-stub:${rulesWhere}" >> "$JOURNAL"
fi
add_mount '${rulesWhere}'
printf '{"healthy":true,"boot-id":"ok","checked-at":"now","findings":[]}' > "$HEALTH"
exit 0
`, 0o755);
  w(join(BIN, "minidc-mount-helper.payload"), `#!/usr/bin/env bash
# payload stub (what install.sh copies to LIB_DIR in test mode): activation
# journals created-stub rows + adds exact mount-table entries + writes health;
# --stop writes unhealthy FIRST then removes exactly those two table lines.
ROOT="\${MINIDC_INSTALL_TEST_ROOT}"
BACKING="$ROOT/var/lib/minidc-broker"
JOURNAL="$BACKING/repair-journal.jsonl"
HEALTH="$BACKING/state/mount-health.json"
TAB="$ROOT/mounts.table"
add_mount() { grep -qxF "$1" "$TAB" 2>/dev/null || echo "$1" >> "$TAB"; }
del_mount() { grep -vxF "$1" "$TAB" 2>/dev/null > "$TAB.new" || true; mv "$TAB.new" "$TAB"; }
if [[ "\${1:-}" == "--stop" ]]; then
  printf '{"healthy":false,"boot-id":"stop","checked-at":"now","findings":["service-stop"]}' > "$HEALTH"
  del_mount '${storeWhere}'
  del_mount '${rulesWhere}'
  exit 0
fi
printf '{"healthy":false,"boot-id":"start","checked-at":"now","findings":["activation-started"]}' > "$HEALTH"
if [[ ! -d '${storeWhere}' ]]; then
  mkdir -p '${storeWhere}'
  echo "created-stub:${storeWhere}" >> "$JOURNAL"
fi
add_mount '${storeWhere}'
if [[ ! -d '${rulesWhere}' ]]; then
  mkdir -p '${rulesWhere}'
  echo "created-stub:${rulesWhere}" >> "$JOURNAL"
fi
add_mount '${rulesWhere}'
printf '{"healthy":true,"boot-id":"ok","checked-at":"now","findings":[]}' > "$HEALTH"
exit 0
`, 0o755);
}

function legacyDesk(withRules = true): void {
  fs.rmSync(T, { recursive: true, force: true });
  fs.mkdirSync(join(STORE, "slugA"), { recursive: true });
  fs.appendFileSync(join(STORE, "slugA", "trail.jsonl"), `{"v":1,"ts":"2026-01-01T00:00:00.000Z","actor":"captain","pane":null,"task":null,"subject":"a1b2c3d4e5f60718","cls":"G","decision":"proceed","scope":"once"}\n`);
  if (withRules) {
    fs.mkdirSync(dirname(LEGACY_RULES), { recursive: true });
    fs.writeFileSync(LEGACY_RULES, "bashToolPatterns:\n  - pattern: 'x\\d*'\n    reason: fixture\nzeroAccessPaths: []\nreadOnlyPaths: []\n");
  }
  stubs();
}

// cleanup F1: spawnSync's typing keeps stdout/stderr Buffer-typed unless the
// encoding literal is carried through every call site — a typed accessor keeps
// the string concatenations annotation-clean
function so(x: string | Buffer | null): string {
  return (x ?? "").toString();
}

function runInstall(args: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [INSTALL, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, MINIDC_INSTALL_TEST_ROOT: T, MINIDC_TARGET_USER: "tester" },
  });
}

function readMarker(): string {
  try { return fs.readFileSync(MARKER, "utf8").trim(); } catch { return "absent"; }
}
function ledgerPhases(): Record<string, string> {
  try {
    const doc = JSON.parse(fs.readFileSync(LEDGER, "utf8")) as { phases?: Record<string, string> };
    return doc.phases ?? {};
  } catch { return {}; }
}
function modeOf(p: string): number | null {
  try { return fs.statSync(p).mode & 0o7777; } catch { return null; }
}
function findAside(): string | null {
  try {
    for (const e of fs.readdirSync(join(HOME, ".pi", "agent"))) {
      if (e.startsWith(".mini-dc.migrated-")) return join(HOME, ".pi", "agent", e);
    }
  } catch { /* none */ }
  return null;
}
// D3 (soak defect 3): the session client's §4.6.5a closed-world tuple, mirrored
// root-side (exactly install.sh's observe_tuple/tuple_verdict pair). Every
// mode-selection invocation must EXIT in a state this classifies BROKER or
// LEGACY — never CONFLICT ("run sudo install.sh --repair-mode") and never a
// shape the client would call UNAVAILABLE.
function tupleOf(): { marker: string; att: string; obs: string; verdict: string } {
  const marker = readMarker();
  let att = "absent";
  try {
    const d = JSON.parse(fs.readFileSync(join(STATE, "install-attestation.json"), "utf8")) as { "install-mode"?: string };
    if (d["install-mode"] === "broker" || d["install-mode"] === "legacy") att = d["install-mode"];
  } catch { /* structurally absent (the attestation's only home is the backing tree) */ }
  const obs = fs.existsSync(BACKING) || fs.existsSync(join(T, "run", "minidc-broker", "socket")) ? "present" : "absent";
  let verdict = "CONFLICT";
  if (att === "broker" && obs === "present" && (marker === "broker" || marker === "absent")) verdict = "BROKER";
  else if (marker !== "broker" && att !== "broker" && obs === "absent") verdict = "LEGACY";
  return { marker, att, obs, verdict };
}

function main(): void {
  // ═══ full fresh install ═══
  {
    section("fresh install: P0→P7 (ledger, P4 modes, journal, units, stubs, marker)");
    legacyDesk();
    const r = runInstall();
    if (r.status !== 0) console.log("    install output:", so(r.stdout) + so(r.stderr));
    check("install exits 0", r.status === 0);
    const phases = ledgerPhases();
    check("all phases complete in the ledger", ["P0", "P3", "P4", "P5", "P6", "P7"].every((p) => phases[p] === "complete"));
    check("marker reads broker", readMarker() === "broker");
    check("the P4 journal exists, 0600, with ONLY helper-APPENDED rows (finding 1 of #10: P4 creates it empty — code-shape-pinned below; the activation's created-stub rows are appends)",
      modeOf(JOURNAL) === 0o600 && fs.readFileSync(JOURNAL, "utf8").split("\n").every((l) => l === "" || l.startsWith("created-stub:")));
    check("backing store moved in (slug present)", fs.existsSync(join(BACKING, "store", "slugA", "trail.jsonl")));
    check("P4 mode pass: slug dir 02770", modeOf(join(BACKING, "store", "slugA")) === 0o2770);
    check("P4 mode pass: trail file 0660", modeOf(join(BACKING, "store", "slugA", "trail.jsonl")) === 0o660);
    // D4 (soak defect 4): the rules tree carries the READABLE-view modes — the rules
    // are the safety floor sessions LOAD through the attached view (same inode as the
    // backing), so 02770/0660 there was the EACCES that denied bash for every new
    // broker-mode session. Dirs 0775 / files 0664: other-class reads for the target
    // user, minidc-broker group keeps rwx/rw for the daemon's write-rules op. The
    // setgid bit is TOLERATED (the kernel preserves it for in-group chmod callers) —
    // assertions are on the low 9 bits. The STORE keeps the hard 02770/0660 boundary.
    check("P4 mode pass: rules dir 0775-class (D4: readable view; setgid tolerated)", (modeOf(join(BACKING, "rules"))! & 0o777) === 0o775);
    check("P4 mode pass: rules file 0664 (D4: readable view)", modeOf(join(BACKING, "rules", "rules.yaml")) === 0o664);
    check("state direct entries 0640", modeOf(join(STATE, "mount-health.json")) === 0o640 && modeOf(join(STATE, "install-attestation.json")) === 0o640);
    // R2 v2 P4 state entries: certification store v2-empty, desk-local installation
    // ID, and the repo-approved digest list's installed root-owned copy (R1/R3)
    check("certified-backends.json seeded v2-empty 0640",
      modeOf(join(STATE, "certified-backends.json")) === 0o640
      && JSON.parse(fs.readFileSync(join(STATE, "certified-backends.json"), "utf8"))
        .version === 2
      && (JSON.parse(fs.readFileSync(join(STATE, "certified-backends.json"), "utf8")) as { backends: unknown[] }).backends.length === 0);
    check("installation-id seeded: 128-bit (32 hex), 0640, fresh per install",
      modeOf(join(STATE, "installation-id")) === 0o640 && /^[0-9a-f]{32}$/.test(fs.readFileSync(join(STATE, "installation-id"), "utf8").trim()));
    check("approved-backends.json installed copy 0640, mirrors the repo-tracked source",
      modeOf(join(STATE, "approved-backends.json")) === 0o640
      && JSON.parse(fs.readFileSync(join(STATE, "approved-backends.json"), "utf8"))
        .version === 1
      && fs.readFileSync(join(STATE, "approved-backends.json"), "utf8")
        === fs.readFileSync(join(REPO, "broker", "approved-backends.json"), "utf8"));
    check("broker unit wires the compiled peercred helper path",
      fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes("--peercred-helper " + T + "/usr/lib/minidc/minidc-peercred-helper"));
    check("ledger 0600 root-only class", modeOf(LEDGER) === 0o600);
    check("units written with substituted paths", fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes(T + "/var/lib/minidc-broker") && !fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes("@BACKING_ROOT@"));
    check("mounts unit carries ExecStop --stop + TimeoutStopSec=90", fs.readFileSync(join(UNIT_DIR, "minidc-mounts.service"), "utf8").includes("ExecStop=") && fs.readFileSync(join(UNIT_DIR, "minidc-mounts.service"), "utf8").includes("TimeoutStopSec=90"));
    check("broker unit: Type=simple + TimeoutStartSec=60 + TimeoutStopSec=30 + no Requires", fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes("Type=simple") && !fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes("Requires="));
    // ptrace-fix (R2 soak defect 1): the daemon must ptrace-read a CROSS-USER
    // /proc/<pid>/exe to fingerprint the presenter's running artifact (R4) — the
    // unit template carries ambient + bounding CAP_SYS_PTRACE in [Service]; the
    // live cross-user proof is the pre/post-cert canary, this pins the template.
    const brokerUnitBody = fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8");
    const svcSection = brokerUnitBody.slice(brokerUnitBody.indexOf("[Service]"), brokerUnitBody.indexOf("[Install]"));
    check("broker unit: AmbientCapabilities=CAP_SYS_PTRACE in [Service] (R4 running-artifact read)",
      svcSection.includes("AmbientCapabilities=CAP_SYS_PTRACE"));
    check("broker unit: CapabilityBoundingSet=CAP_SYS_PTRACE in [Service] (scoped to exactly that)",
      svcSection.includes("CapabilityBoundingSet=CAP_SYS_PTRACE"));
    const ledgerDoc = JSON.parse(fs.readFileSync(LEDGER, "utf8")) as { "created-stubs"?: string[]; "marker-pre"?: { present?: boolean } }; // cleanup F1: the marker-pre index
    // P7 (commit) DELETES the aside copies per the design — post-commit rollback is
    // "reinstall from the manifest copies inside the backing tree itself"
    check("P7 deleted the aside rollback copies (post-commit law)", findAside() === null);
    const healthRaw = fs.existsSync(join(STATE, "mount-health.json")) ? fs.readFileSync(join(STATE, "mount-health.json"), "utf8") : "(missing)";
    if (!healthRaw.includes('"healthy":true')) console.log("    [debug] health:", healthRaw, "| journal:", JSON.stringify(fs.readFileSync(JOURNAL, "utf8")));
    check("mount-health healthy after awaited activation", healthRaw.includes('"healthy":true'));
    // D4 (soak defect 4), post-activation: the RULES view readable by the target user
    // while the STORE view stays hard-locked. TEST MODE realizes MODES only (chown is
    // root-only); with production ownership root:minidc-broker the other-bits are
    // exactly what grants the target user access through the attached view.
    check("D4: rules.yaml world-readable through the view (other-read set)", (modeOf(join(BACKING, "rules", "rules.yaml"))! & 0o004) === 0o004);
    check("D4: rules view dir traversable by any user (other r-x)", (modeOf(join(BACKING, "rules"))! & 0o005) === 0o005);
    check("D4: rules view dir keeps daemon write-rules capability (group rwx)", (modeOf(join(BACKING, "rules"))! & 0o070) === 0o070);
    check("D4: store view dir stays hard-locked (zero other-bits)", (modeOf(join(BACKING, "store"))! & 0o007) === 0);
    check("D4: store file zero other-bits", (modeOf(join(BACKING, "store", "slugA", "trail.jsonl"))! & 0o007) === 0);
    check("D4: the rules VIEW path exists post-activation (the mounted target)", fs.existsSync(join(HOME, ".pi", "agent", "mini-dc-rules")));
    check("created-stubs mirrored into the ledger AFTER activation (step 4b)", (ledgerDoc["created-stubs"] ?? []).length === 2);
    check("marker-pre recorded as absent (valid pre-install shape)", JSON.stringify(ledgerDoc["marker-pre"] ?? {}).includes('"present":false'));
  }

  // ═══ rollback from the installed state (the ledger-driven path) ═══
  {
    section("rollback (ledger-driven): LEDGER-FIRST discard, restored end state");
    const r = runInstall(["--rollback"]);
    if (r.status !== 0) console.log("    rollback output:", so(r.stdout) + so(r.stderr));
    check("rollback exits 0", r.status === 0);
    check("backing namespace ABSENT (clean end state)", !fs.existsSync(BACKING));
    check("NO ledger file exists anywhere after the completed rollback", !fs.existsSync(LEDGER));
    check("store home restored at its true path", fs.existsSync(join(STORE, "slugA", "trail.jsonl")));
    check("legacy rules file restored", fs.existsSync(LEGACY_RULES));
    check("marker restored to marker-pre (absent)", readMarker() === "absent");
    check("no aside lingers", findAside() === null);
    check("helper-created stubs disposed (validated-empty)", !fs.existsSync(join(HOME, ".pi", "agent", "mini-dc-rules")));
  }

  // ═══ crash pins: the ordered-discard boundary ═══
  {
    section("ordered-discard crash pins (finding 1 of #11)");
    // (i) immediately BEFORE the ledger unlink: ledger+tree+journal ALL present —
    // re-run takes the LEDGER-DRIVEN path (the full-install state IS this shape)
    legacyDesk();
    runInstall();
    check("pin (i) precondition: ledger+tree+journal present", fs.existsSync(LEDGER) && fs.existsSync(JOURNAL) && fs.existsSync(BACKING));
    const rb = runInstall(["--rollback"]);
    check("pin (i): ledger-driven rollback completes from the boundary state (step-0 journal read green)", rb.status === 0 && !fs.existsSync(BACKING) && fs.existsSync(join(STORE, "slugA")));
    // (ii) immediately AFTER the ledger unlink: ledger gone, tree+journal present —
    // re-run takes the NO-LEDGER FINALIZATION
    legacyDesk();
    runInstall();
    // emulate a rollback crashed immediately AFTER the ledger unlink: the rollback had
    // already stopped the units, unmounted, and restored the store (step 7 precedes the
    // unlink) — then the ledger died mid-discard; backing residue remains
    fs.rmSync(join(STORE), { recursive: true, force: true });
    fs.cpSync(join(BACKING, "store"), STORE, { recursive: true });
    for (const u of ["minidc-broker.service", "minidc-mounts.service"]) {
      w(join(T, "unitstate", u), "inactive\n");
    }
    w(MOUNTS, "/\n/tmp\n"); // real semantics: only root-fs entries — both targets unmounted
    fs.rmSync(LEDGER);
    const fin = runInstall(["--rollback"]);
    check("pin (ii): no-ledger finalization runs (guards → sweep → assertions)", fin.status === 0);
    check("pin (ii): residue swept incl. journal remains", !fs.existsSync(BACKING) && !fs.existsSync(JOURNAL));
    check("pin (ii): store home STILL restored (asides were restored before the unlink by ordering law)", fs.existsSync(join(STORE, "slugA")));
    // (iii) mid-convergence: partial residue with no ledger
    legacyDesk();
    runInstall();
    fs.rmSync(LEDGER);
    for (const u of ["minidc-broker.service", "minidc-mounts.service"]) {
      w(join(T, "unitstate", u), "inactive\n");
    }
    w(MOUNTS, "/\n/tmp\n");
    fs.rmSync(join(BACKING, "store"), { recursive: true, force: true }); // partial discard shape
    const fin2 = runInstall(["--repair-mode"]);
    check("pin (iii): mid-convergence residue swept by the finalization", fin2.status === 0 && !fs.existsSync(BACKING));
    // (iv) post-discard/pre-assertion: clean absence — idempotent green
    const fin3 = runInstall(["--rollback"]);
    check("pin (iv): finalization idempotence — re-run re-asserts green", fin3.status === 0 && !fs.existsSync(BACKING));
  }

  // ═══ the no-ledger finalization marker leg ═══
  {
    section("no-ledger finalization: orphan-marker removal");
    legacyDesk();
    // a broker-valued marker with NO ledger and no broker reality = orphan residue
    fs.writeFileSync(MARKER, "broker");
    const fin = runInstall(["--repair-mode"]);
    check("orphan broker marker REMOVED by the finalization (surfaced)", fin.status === 0 && readMarker() === "absent");
    check("desk observes tuple 18 afterwards (LEGACY, zero conflict)", !fs.existsSync(BACKING));
  }

  // ═══ P0 refusals ═══
  {
    section("P0 entry-point refusals");
    legacyDesk();
    fs.writeFileSync(MARKER, "broker");
    const r = runInstall();
    check("broker-valued marker at P0 ⇒ REFUSED (exit 3, nothing minted)", r.status === 3 && !fs.existsSync(LEDGER));
    check("refusal names both resolvers", (so(r.stderr) + so(r.stdout)).includes("--repair-mode"));
    legacyDesk();
    w(join(T, "etc", "sudoers.d", "plant"), "vladi ALL=(ALL) NOPASSWD: /usr/lib/minidc/minidc-brokerctl\n");
    const r2 = runInstall();
    check("planted NOPASSWD sudoers rule ⇒ install fails the assertion", r2.status !== 0);
    check("NOPASSWD refusal names the law", (so(r2.stderr) + so(r2.stdout)).includes("NOPASSWD"));
  }

  // ═══ resume after a mid-install crash (P3 complete, P4 not) ═══
  {
    section("crash resume (P0′ ground-truth re-entry)");
    legacyDesk();
    // emulate: run install with P5 forced to fail (mounts unit fails) → abort at P5 →
    // fix the failure → re-run resumes and completes
    fs.mkdirSync(join(T, "unitfail"), { recursive: true });
    w(join(T, "unitfail", "minidc-mounts.service"), "1");
    const r1 = runInstall();
    check("P5 aborts when the mounts service fails (P6 never runs)", r1.status !== 0 && ledgerPhases()["P6"] !== "complete");
    fs.rmSync(join(T, "unitfail", "minidc-mounts.service"));
    const r2 = runInstall();
    check("re-run resumes from the ledger and completes", r2.status === 0 && ledgerPhases()["P6"] === "complete");
    const rb = runInstall(["--rollback"]);
    check("rollback from the recovered install reaches the restored state", rb.status === 0 && fs.existsSync(join(STORE, "slugA")));
  }

  // ═══ rules:null variant + legacy mode + repair-mode reconcile ═══
  {
    section("rules:null · legacy mode · repair-mode");
    legacyDesk(false); // a desk that never had a legacy rules file — VALID
    const r = runInstall();
    check("rules:null install completes (legitimately absent)", r.status === 0 && !fs.existsSync(join(BACKING, "rules", "rules.yaml")));
    runInstall(["--rollback"]);
    legacyDesk(false);
    const leg = runInstall(["--mode", "legacy"]);
    check("--mode legacy (fresh desk): marker written, no broker surfaces minted", leg.status === 0 && readMarker() === "legacy" && !fs.existsSync(BACKING) && !fs.existsSync(LEDGER));
    check("D2: fresh-desk legacy flip materializes the TRACKED rules at the legacy path",
      fs.existsSync(LEGACY_RULES) && fs.readFileSync(LEGACY_RULES, "utf8") === fs.readFileSync(join(REPO, "mini-dc-rules.yaml"), "utf8"));
    check("D3: tuple after the fresh-desk legacy flip is LEGACY (client-consistent exit)", tupleOf().verdict === "LEGACY");
    const leg2 = runInstall(["--mode", "legacy"]);
    check("D2: legacy flip IDEMPOTENT — re-run exits 0 keeping the valid rules file", leg2.status === 0 && fs.existsSync(LEGACY_RULES) && fs.statSync(LEGACY_RULES).size > 0);
    legacyDesk();
    runInstall();
    // live ledger ⇒ repair-mode reconciles to the ledger's truth (marker broker kept)
    fs.writeFileSync(MARKER, "legacy"); // a drifted marker over a live install
    const rep = runInstall(["--repair-mode"]);
    check("--repair-mode with a live ledger reconciles the marker to ledger truth (broker)", rep.status === 0 && readMarker() === "broker");
    check("D3: tuple after --repair-mode agrees (BROKER)", tupleOf().verdict === "BROKER");
    check("repair never weakens a healthy broker install (tuple 1 intact)", fs.existsSync(join(BACKING, "store", "slugA")));
    runInstall(["--rollback"]);
  }

  // ═══ D2+D3: the 2026-11-24 production shape — broker install → --mode legacy ═══
  {
    section("D2+D3: broker install → --mode legacy (the soak's mode-transition defects)");
    legacyDesk(); // the desk WITH its own rules file (the migrated-away shape)
    runInstall(); // broker-mode install: migrates store + rules into the backing tree
    check("precondition: the install flipped the desk to a client-consistent BROKER", tupleOf().verdict === "BROKER");
    check("precondition: the legacy path was migrated away (the D2 hole)", !fs.existsSync(LEGACY_RULES));
    const flip = runInstall(["--mode", "legacy"]);
    if (flip.status !== 0) console.log("    mode-legacy output:", so(flip.stdout) + so(flip.stderr));
    check("D3: --mode legacy over a live install exits 0 (one transaction, no residue)", flip.status === 0);
    check("D3: tuple after the flip is LEGACY — no conflict/unavailable classification", tupleOf().verdict === "LEGACY");
    check("D3: marker=legacy, attestation structurally absent, observables absent", tupleOf().marker === "legacy" && tupleOf().att === "absent" && tupleOf().obs === "absent");
    check("D3: no ledger or backing namespace lingers (ledger-first discard ran)", !fs.existsSync(LEDGER) && !fs.existsSync(BACKING));
    check("D2: the legacy path carries a rules file after the flip", fs.existsSync(LEGACY_RULES) && fs.statSync(LEGACY_RULES).size > 0);
    // a fresh-session-shaped read: the legacy client loads + parses the rules file
    let sessionRead = false;
    try {
      const doc = yamlParse(fs.readFileSync(LEGACY_RULES, "utf8")) as { bashToolPatterns?: unknown };
      sessionRead = Array.isArray(doc.bashToolPatterns);
    } catch { sessionRead = false; }
    check("D2: fresh-session-shaped read succeeds (yaml parses, bashToolPatterns present)", sessionRead);
    check("D2: restored rules are the desk's OWN bytes (rollback restore wins over repo bytes)",
      fs.existsSync(LEGACY_RULES) && fs.readFileSync(LEGACY_RULES, "utf8") === "bashToolPatterns:\n  - pattern: 'x\\d*'\n    reason: fixture\nzeroAccessPaths: []\nreadOnlyPaths: []\n");
    check("store home restored at its true path", fs.existsSync(join(STORE, "slugA", "trail.jsonl")));
    check("no rules-view stub lingers at the legacy desk (never shadowed)", !fs.existsSync(join(HOME, ".pi", "agent", "mini-dc-rules")));
    check("no aside lingers", findAside() === null);
  }

  // ═══ D2: the rules-absent install variant — materialization from the checkout ═══
  {
    section("D2: rules:null install → --mode legacy materializes tracked rules");
    legacyDesk(false); // a desk that never had a legacy rules file
    runInstall();
    runInstall(["--mode", "legacy"]);
    check("D2: rules-absent desk gets the TRACKED rules bytes at the legacy path on flip",
      fs.existsSync(LEGACY_RULES) && fs.readFileSync(LEGACY_RULES, "utf8") === fs.readFileSync(join(REPO, "mini-dc-rules.yaml"), "utf8"));
    check("D3: tuple after the flip is LEGACY", tupleOf().verdict === "LEGACY");
  }

  // ═══ D3: the drifted-marker heal — --mode broker exits consistent ═══
  {
    section("D3: drifted legacy marker over a live install (the production conflict)");
    legacyDesk();
    runInstall();
    fs.writeFileSync(MARKER, "legacy"); // the exact production drift shape
    check("precondition: drifted marker over a live install classifies CONFLICT", tupleOf().verdict === "CONFLICT");
    const heal = runInstall(["--mode", "broker"]);
    if (heal.status !== 0) console.log("    heal output:", so(heal.stdout) + so(heal.stderr));
    check("D3: --mode broker reconciles the marker to ledger truth and exits BROKER", heal.status === 0 && tupleOf().verdict === "BROKER");
    check("D3: marker converged to broker", readMarker() === "broker");
    runInstall(["--rollback"]);
  }

  // ═══ D4: repair-mounts re-converges the readable rules-view modes ═══
  {
    section("D4: --repair-mounts re-converges rules-view modes (old-install heal)");
    legacyDesk();
    runInstall();
    // The OLD-INSTALL shape as an explicit fixture: the base revision (f8ef9c4)
    // planted the rules tree 02770/0660 via its recursive_pass — the exact EACCES
    // shape of the soak. Reproducing history at runtime (git archive of the base
    // commit) proved environment-fragile: CI checks out shallow merge refs without
    // the parent objects, the spawn threw, and this fully-synchronous file's
    // buffered stdout vanished with it (PR-50 CI: exit 1, zero output). The modes
    // are planted directly on the fresh install's tree instead; the machinery
    // under test — --repair-mounts' rules_pass convergence — runs for real either way.
    fs.chmodSync(join(BACKING, "rules"), 0o2770);
    fs.chmodSync(join(BACKING, "rules", "rules.yaml"), 0o660);
    const rep = runInstall(["--repair-mounts"]);
    if (rep.status !== 0) console.log("    repair-mounts output:", so(rep.stdout) + so(rep.stderr));
    check("D4: --repair-mounts converges rules modes before the re-attach",
      rep.status === 0 && modeOf(join(BACKING, "rules", "rules.yaml")) === 0o664 && (modeOf(join(BACKING, "rules"))! & 0o777) === 0o775);
    runInstall(["--rollback"]);
  }

  // ═══ finding 9: real findmnt-semantics rows (exact identity vs containing fs) ═══
  {
    section("exact-mountpoint identity (finding 5/9: --target semantics)");
    legacyDesk();
    // ordinary paths sit on the ROOT filesystem — deepest-at-or-above is "/", never
    // the target: P2 must PASS (unmounted) despite findmnt answering nonzero-exit-0 rows
    const ordinary = runInstall();
    check("ordinary paths (root-fs only) pass P2 — exact identity, not containment", ordinary.status === 0);
    runInstall(["--rollback"]);
    // exact bind at the store target: P2 must REFUSE
    legacyDesk();
    fs.appendFileSync(MOUNTS, STORE + "\n");
    const bind = runInstall();
    check("an exact bind at the store target refuses P2 (findmnt answers the target itself)", bind.status !== 0);
    // containing-filesystem control: a mount on the PARENT (.pi/agent) must NOT trip
    // the store check — deepest-at-or-above STORE is the parent, not STORE
    legacyDesk();
    fs.appendFileSync(MOUNTS, join(HOME, ".pi", "agent") + "\n");
    const parentFs = runInstall();
    check("parent-filesystem mount does NOT count as a store mount (deepest ≠ target)", parentFs.status === 0);
    runInstall(["--rollback"]);
    // finalization guard: an exact bind with no ledger must ABORT (residue named)
    legacyDesk();
    fs.rmSync(LEDGER, { force: true });
    try { fs.rmSync(BACKING, { recursive: true, force: true }); } catch { /* absent */ }
    fs.appendFileSync(MOUNTS, STORE + "\n");
    const guard = runInstall(["--repair-mode"]);
    check("finalization guard refuses an exact-bind mount (never force, residue named)", guard.status !== 0);
  }

  // ═══ code-shape pins (the design's ordering laws, asserted on the source) ═══
  {
    section("code-shape pins");
    const unlinkIdx = INSTALL_SRC.indexOf('rm -f -- "$LEDGER"');
    const discardIdx = INSTALL_SRC.indexOf('convergent_discard "$BACKING_ROOT"');
    const asideRestoreIdx = INSTALL_SRC.indexOf("rollback step 7: aside restore failed");
    check("the discard phase's FIRST mutation is the ledger unlink (before convergent_discard)", unlinkIdx > 0 && discardIdx > unlinkIdx);
    check("aside restore precedes the ledger unlink (ordering law)", asideRestoreIdx > 0 && asideRestoreIdx < unlinkIdx);
    const rbBody = INSTALL_SRC.slice(INSTALL_SRC.indexOf("do_rollback() {"), INSTALL_SRC.indexOf("convergent_discard() {"));
    const afterUnlink = rbBody.slice(rbBody.indexOf('rm -f -- "$LEDGER"'));
    check("NO write to install-state.json after the unlink (no post-deletion marking)", !afterUnlink.includes('json_set "$LEDGER"'));
    const rbStart = INSTALL_SRC.indexOf("do_rollback() {");
    const rbEnd = INSTALL_SRC.indexOf("convergent_discard() {");
    const rollbackBody = INSTALL_SRC.slice(rbStart, rbEnd);
    const rbNoComments = rollbackBody.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    check("NO --now compound anywhere in the rollback (commands only, not the law's own comment)", !rbNoComments.includes("--now"));
    check("rollback stops are --no-block invocations", rollbackBody.includes("stop --no-block"));
    check("stub mirroring runs only AFTER awaited activation (step 4b, not step 3)", INSTALL_SRC.indexOf("NO stub mirroring happens here") > 0 && INSTALL_SRC.indexOf("mirror_created_stubs\n") > INSTALL_SRC.indexOf("minidc-mounts.service active 90"));
    check("journal APPENDS only: no helper-side creation path (C helper pins it; installer creates it at P4)", INSTALL_SRC.includes("the helper APPENDS, never creates"));

    // ═══ D6 pins (2026-11-24 activation soak: the certify rewrite must not ⋅
    // drop the daemon-readable group — production evidence: root:root store,
    // daemon read fail-closed to empty, all claims denied) ═══
    const CERTIFY_SRC = fs.readFileSync(
      new URL("../../broker/minidc-certify.ts", import.meta.url), "utf8");
    const chownIdx = CERTIFY_SRC.indexOf("fs.chownSync(tmp, ref.uid, ref.gid)");
    const renameIdx = CERTIFY_SRC.indexOf("fs.renameSync(tmp, path)");
    check("D6: the store replace chowns the temp from the installation-id sibling BEFORE the rename (no unowned-file window)", chownIdx > 0 && renameIdx > chownIdx);
    check("D6: the ownership reference is sibling-derived (lstat of installation-id)", CERTIFY_SRC.includes('fs.lstatSync(sibling)'));
    check("D6: a missing/unreadable sibling REFUSES the write (loud, never silently unowned)", CERTIFY_SRC.includes("refusing to write without the ownership reference"));
  }

  fs.rmSync(T, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  // CI-visibility hardening (PR-50 lesson): this file is fully synchronous, so its
  // stdout stays userspace-buffered until the process yields — a hard process.exit()
  // discards every ✓/✗ line on failure. exitCode lets node flush before the natural
  // exit; same nonzero contract for the runner.
  process.exitCode = fail > 0 ? 1 : 0;
}

// Crash-context guard, registered BEFORE main(): an uncaught error in a synchronous
// script exits node before buffered stdout drains — the runner then sees a silent
// nonzero exit. stderr writes are synchronous even to pipes, so this always lands.
process.on("uncaughtException", (e) => {
  process.stderr.write(`minidc-install.test.ts UNCAUGHT: ${(e as Error).stack ?? String(e)}\n`);
  process.exitCode = 1;
});

main();
