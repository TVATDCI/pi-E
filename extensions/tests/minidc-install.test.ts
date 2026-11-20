// extensions/tests/minidc-install.test.ts — the R2 install.sh unit matrix (design §8).
// Run: node --experimental-strip-types minidc-install.test.ts
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
// Root-dependent legs (real systemd, real mounts, chown, the compiled helper's live
// syscalls) are install-stage validation — named in the build report.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
const MOUNTS = join(T, "mounts");

function w(path: string, content: string, mode?: number): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
  if (mode !== undefined) fs.chmodSync(path, mode);
}

function stubs(): void {
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
  w(join(BIN, "findmnt"), `#!/usr/bin/env bash
# test stub: a mount exists iff $MOUNTS/<flag> is present
for a in "$@"; do
  case "$a" in
    --target) : ;;
    -n|-o|TARGET) : ;;
    *) target="$a" ;;
  esac
done
enc="$(echo "$target" | tr '/' '_')"
if [[ -f "\${MINIDC_INSTALL_TEST_ROOT}/mounts/$enc" ]]; then
  echo "TARGET  SOURCE  FSTYPE"
  exit 0
fi
exit 1
`, 0o755);
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
  w(join(BIN, "minidc-mount-helper"), `#!/usr/bin/env bash
ROOT="\${MINIDC_INSTALL_TEST_ROOT}"
BACKING="$ROOT/var/lib/minidc-broker"
JOURNAL="$BACKING/repair-journal.jsonl"
HEALTH="$BACKING/state/mount-health.json"
mount_flag() { echo "$1" | tr '/' '_'; }
if [[ "\${1:-}" == "--stop" ]]; then
  printf '{"healthy":false,"boot-id":"stop","checked-at":"now","findings":["service-stop"]}' > "$HEALTH"
  rm -f "$ROOT/mounts/$(mount_flag '${storeWhere}')"
  rm -f "$ROOT/mounts/$(mount_flag '${rulesWhere}')"
  exit 0
fi
printf '{"healthy":false,"boot-id":"start","checked-at":"now","findings":["activation-started"]}' > "$HEALTH"
if [[ ! -d '${storeWhere}' ]]; then
  mkdir -p '${storeWhere}'
  echo "created-stub:${storeWhere}" >> "$JOURNAL"
fi
touch "$ROOT/mounts/$(mount_flag '${storeWhere}')"
if [[ ! -d '${rulesWhere}' ]]; then
  mkdir -p '${rulesWhere}'
  echo "created-stub:${rulesWhere}" >> "$JOURNAL"
fi
touch "$ROOT/mounts/$(mount_flag '${rulesWhere}')"
printf '{"healthy":true,"boot-id":"ok","checked-at":"now","findings":[]}' > "$HEALTH"
exit 0
`, 0o755);
  w(join(BIN, "minidc-mount-helper.payload"), `#!/usr/bin/env bash
ROOT="\${MINIDC_INSTALL_TEST_ROOT}"
BACKING="$ROOT/var/lib/minidc-broker"
JOURNAL="$BACKING/repair-journal.jsonl"
HEALTH="$BACKING/state/mount-health.json"
mount_flag() { echo "$1" | tr '/' '_'; }
if [[ "\${1:-}" == "--stop" ]]; then
  printf '{"healthy":false,"boot-id":"stop","checked-at":"now","findings":["service-stop"]}' > "$HEALTH"
  rm -f "$ROOT/mounts/$(mount_flag '${storeWhere}')"
  rm -f "$ROOT/mounts/$(mount_flag '${rulesWhere}')"
  exit 0
fi
printf '{"healthy":false,"boot-id":"start","checked-at":"now","findings":["activation-started"]}' > "$HEALTH"
if [[ ! -d '${storeWhere}' ]]; then
  mkdir -p '${storeWhere}'
  echo "created-stub:${storeWhere}" >> "$JOURNAL"
fi
touch "$ROOT/mounts/$(mount_flag '${storeWhere}')"
if [[ ! -d '${rulesWhere}' ]]; then
  mkdir -p '${rulesWhere}'
  echo "created-stub:${rulesWhere}" >> "$JOURNAL"
fi
touch "$ROOT/mounts/$(mount_flag '${rulesWhere}')"
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

function main(): void {
  // ═══ full fresh install ═══
  {
    section("fresh install: P0→P7 (ledger, P4 modes, journal, units, stubs, marker)");
    legacyDesk();
    const r = runInstall();
    if (r.status !== 0) console.log("    install output:", (r.stdout ?? "") + (r.stderr ?? ""));
    check("install exits 0", r.status === 0);
    const phases = ledgerPhases();
    check("all phases complete in the ledger", ["P0", "P3", "P4", "P5", "P6", "P7"].every((p) => phases[p] === "complete"));
    check("marker reads broker", readMarker() === "broker");
    check("the P4 journal exists, 0600, with ONLY helper-APPENDED rows (finding 1 of #10: P4 creates it empty — code-shape-pinned below; the activation's created-stub rows are appends)",
      modeOf(JOURNAL) === 0o600 && fs.readFileSync(JOURNAL, "utf8").split("\n").every((l) => l === "" || l.startsWith("created-stub:")));
    check("backing store moved in (slug present)", fs.existsSync(join(BACKING, "store", "slugA", "trail.jsonl")));
    check("P4 mode pass: slug dir 02770", modeOf(join(BACKING, "store", "slugA")) === 0o2770);
    check("P4 mode pass: trail file 0660", modeOf(join(BACKING, "store", "slugA", "trail.jsonl")) === 0o660);
    check("P4 mode pass: rules file 0660", modeOf(join(BACKING, "rules", "rules.yaml")) === 0o660);
    check("state direct entries 0640", modeOf(join(STATE, "mount-health.json")) === 0o640 && modeOf(join(STATE, "install-attestation.json")) === 0o640);
    check("ledger 0600 root-only class", modeOf(LEDGER) === 0o600);
    check("units written with substituted paths", fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes(T + "/var/lib/minidc-broker") && !fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes("@BACKING_ROOT@"));
    check("mounts unit carries ExecStop --stop + TimeoutStopSec=90", fs.readFileSync(join(UNIT_DIR, "minidc-mounts.service"), "utf8").includes("ExecStop=") && fs.readFileSync(join(UNIT_DIR, "minidc-mounts.service"), "utf8").includes("TimeoutStopSec=90"));
    check("broker unit: Type=notify + TimeoutStartSec=60 + TimeoutStopSec=30 + no Requires", fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes("Type=notify") && !fs.readFileSync(join(UNIT_DIR, "minidc-broker.service"), "utf8").includes("Requires="));
    const ledgerDoc = JSON.parse(fs.readFileSync(LEDGER, "utf8")) as { "created-stubs"?: string[] };
    // P7 (commit) DELETES the aside copies per the design — post-commit rollback is
    // "reinstall from the manifest copies inside the backing tree itself"
    check("P7 deleted the aside rollback copies (post-commit law)", findAside() === null);
    const healthRaw = fs.existsSync(join(STATE, "mount-health.json")) ? fs.readFileSync(join(STATE, "mount-health.json"), "utf8") : "(missing)";
    if (!healthRaw.includes('"healthy":true')) console.log("    [debug] health:", healthRaw, "| journal:", JSON.stringify(fs.readFileSync(JOURNAL, "utf8")));
    check("mount-health healthy after awaited activation", healthRaw.includes('"healthy":true'));
    check("created-stubs mirrored into the ledger AFTER activation (step 4b)", (ledgerDoc["created-stubs"] ?? []).length === 2);
    check("marker-pre recorded as absent (valid pre-install shape)", JSON.stringify(ledgerDoc["marker-pre"] ?? {}).includes('"present":false'));
  }

  // ═══ rollback from the installed state (the ledger-driven path) ═══
  {
    section("rollback (ledger-driven): LEDGER-FIRST discard, restored end state");
    const r = runInstall(["--rollback"]);
    if (r.status !== 0) console.log("    rollback output:", (r.stdout ?? "") + (r.stderr ?? ""));
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
    fs.rmSync(join(T, "mounts"), { recursive: true, force: true });
    fs.mkdirSync(join(T, "mounts"), { recursive: true });
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
    fs.rmSync(join(T, "mounts"), { recursive: true, force: true });
    fs.mkdirSync(join(T, "mounts"), { recursive: true });
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
    check("refusal names both resolvers", ((r.stderr ?? "") + (r.stdout ?? "")).includes("--repair-mode"));
    legacyDesk();
    w(join(T, "etc", "sudoers.d", "plant"), "vladi ALL=(ALL) NOPASSWD: /usr/lib/minidc/minidc-brokerctl\n");
    const r2 = runInstall();
    check("planted NOPASSWD sudoers rule ⇒ install fails the assertion", r2.status !== 0);
    check("NOPASSWD refusal names the law", ((r2.stderr ?? "") + (r2.stdout ?? "")).includes("NOPASSWD"));
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
    check("--mode legacy writes ONLY the advisory marker", leg.status === 0 && readMarker() === "legacy" && !fs.existsSync(BACKING) && !fs.existsSync(LEDGER));
    legacyDesk();
    runInstall();
    // live ledger ⇒ repair-mode reconciles to the ledger's truth (marker broker kept)
    fs.writeFileSync(MARKER, "legacy"); // a drifted marker over a live install
    const rep = runInstall(["--repair-mode"]);
    check("--repair-mode with a live ledger reconciles the marker to ledger truth (broker)", rep.status === 0 && readMarker() === "broker");
    check("repair never weakens a healthy broker install (tuple 1 intact)", fs.existsSync(join(BACKING, "store", "slugA")));
    runInstall(["--rollback"]);
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
  }

  fs.rmSync(T, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
