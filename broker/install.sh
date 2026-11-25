#!/usr/bin/env bash
# broker/install.sh — the R2 transactional install/rollback (design-of-record
# data/gate-r2-amend11/report.md §4.6). Fresh install only (no R2 code exists on any
# desk). Ledgered, crash-resumable, LEDGER-FIRST discard, no-ledger finalization.
#
# NEVER RUN BY THE BUILD ROUND — no root word has been given. This script is
# unit-tested only in its TEST MODE (all paths + commands redirected into a scratch
# tree); the live phases (real systemd, real mounts, real chown) are install-stage
# validation, run later under the per-desk captain word.
#
# Test mode:  MINIDC_INSTALL_TEST_ROOT=<scratch>  (must NOT be root; all production
# paths are re-rooted inside the scratch, and systemctl/findmnt/fuser/mount helper are
# resolved from $MINIDC_INSTALL_TEST_ROOT/bin — the test harness plants stubs there).
#
# Usage (production, root):  ./install.sh [--mode broker|legacy] [--rollback]
#                            [--repair-mode] [--repair-mounts]
#   --mode legacy   choose legacy mode: the full TRANSACTIONAL flip (D2+D3, the
#                   2026-11-24 soak defects) — a standing broker install is torn
#                   down to the legacy end state and the legacy rules path is
#                   guaranteed to carry a valid rules file (§4.7 as amended)
#   --rollback      run the deadline-bound rollback (or the no-ledger finalization)
#   --repair-mode   reconcile install-mode records from the authoritative ledger
#   --repair-mounts re-run the mount-helper activation protocol

set -u
set -o pipefail

# ─── mode + path resolution ───────────────────────────────────────────────────
TEST_ROOT="${MINIDC_INSTALL_TEST_ROOT:-}"
if [[ -n "$TEST_ROOT" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    echo "install.sh: TEST MODE must not run as root" >&2; exit 2
  fi
  BACKING_ROOT="$TEST_ROOT/var/lib/minidc-broker"
  RUN_DIR="$TEST_ROOT/run/minidc-broker"
  TARGET_USER="${MINIDC_TARGET_USER:-tester}"
  HOME_OF="$TEST_ROOT/home/$TARGET_USER"
  UNIT_DIR="$TEST_ROOT/etc/systemd/system"
  SUDOERS_SCAN="$TEST_ROOT/etc/sudoers.d"
  LIB_DIR="$TEST_ROOT/usr/lib/minidc"
  STUB_BIN="$TEST_ROOT/bin"
  SYSTEMCTL="$STUB_BIN/systemctl"
  FINDMNT="$STUB_BIN/findmnt"
  FUSER="$STUB_BIN/fuser"
  # test mode mirrors production: the helper installs at LIB_DIR — never inside bin/
  # (bin/ holds the harness's own stub binaries; the payload copy would clobber them)
  MOUNT_HELPER="$LIB_DIR/minidc-mount-helper"
  PEERCRED_HELPER="$LIB_DIR/minidc-peercred-helper"
  NODE_BIN="$(command -v node)"
else
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "install.sh: must run as root (per-desk install word)" >&2; exit 2
  fi
  BACKING_ROOT="/var/lib/minidc-broker"
  RUN_DIR="/run/minidc-broker"
  TARGET_USER="${MINIDC_TARGET_USER:-${SUDO_USER:-vladi}}"
  HOME_OF="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
  UNIT_DIR="/etc/systemd/system"
  SUDOERS_SCAN="/etc/sudoers.d"
  LIB_DIR="/usr/lib/minidc"
  SYSTEMCTL="systemctl"
  FINDMNT="findmnt"
  FUSER="fuser"
  MOUNT_HELPER="$LIB_DIR/minidc-mount-helper"
  PEERCRED_HELPER="$LIB_DIR/minidc-peercred-helper"
  NODE_BIN="$(readlink -f "$(command -v node)")"
fi
if [[ -z "${HOME_OF}" || ! -d "${HOME_OF}" ]]; then
  echo "install.sh: target user home not found: ${HOME_OF}" >&2; exit 2
fi

STORE_HOME="$HOME_OF/.pi/agent/mini-dc"
LEGACY_RULES="$HOME_OF/.pi/agent/mini-dc-rules.yaml"
MARKER="$HOME_OF/.pi/agent/mini-dc-install-mode"
LEDGER="$BACKING_ROOT/install-state.json"
JOURNAL="$BACKING_ROOT/repair-journal.jsonl"
STATE_DIR="$BACKING_ROOT/state"
MOUNT_HEALTH="$STATE_DIR/mount-health.json"
ATTESTATION="$STATE_DIR/install-attestation.json"
RULES_DIR_MOUNT="$HOME_OF/.pi/agent/mini-dc-rules"   # broker-mode directory mount (held pick 7)

TXID=""
LOG() { echo "install.sh: $*"; }
DIE() { echo "install.sh: FATAL: $*" >&2; exit 1; }

# ─── small helpers ────────────────────────────────────────────────────────────
now_iso() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
sha256_of() { sha256sum "$1" | cut -d' ' -f1; }

json_set() { # file key value — key may be dotted (nested path); jq-free via node
  node -e '
    const fs = require("fs");
    const [file, key, value] = process.argv.slice(1);
    let doc = {};
    try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const parts = key.split(".");
    let cur = doc;
    while (parts.length > 1) {
      const p = parts.shift();
      if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[0]] = JSON.parse(value);
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  ' "$1" "$2" "$3"
}
json_get() { # file key → prints value or nothing (dotted path)
  node -e '
    const fs = require("fs");
    try {
      const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let cur = doc;
      for (const p of process.argv[2].split(".")) {
        if (typeof cur !== "object" || cur === null || !(p in cur)) { process.exit(0); }
        cur = cur[p];
      }
      if (cur !== undefined && cur !== null) process.stdout.write(typeof cur === "string" ? JSON.stringify(cur) : JSON.stringify(cur));
    } catch {}
  ' "$1" "$2"
}

# bounded poll: poll_unit <unit> <want-state> <deadline-seconds>
# finding 6 fix: ELAPSED-TIME deadlines (the prior loop counted 0.25 s sleeps as whole
# seconds — every wait ran 4x short). Accept any terminal state in WANT via "|".
poll_unit() {
  local unit="$1" want="$2" deadline="$3" state start
  start="$(date +%s)"
  while :; do
    state="$("$SYSTEMCTL" show -p ActiveState --value "$unit" 2>/dev/null || echo unreadable)"
    if [[ "|$want|" == *"|$state|"* ]]; then return 0; fi
    if (( $(date +%s) - start >= deadline )); then return 1; fi
    sleep 0.25
  done
}

# finding 5 fix: EXACT mountpoint identity. "findmnt --target P" reports the
# CONTAINING filesystem for any ordinary path — unusable for mount checks. P is
# mounted iff the deepest mount at-or-above P is P itself.
mounted_exactly() {
  local target
  target="$("$FINDMNT" -n -o TARGET --target "$1" 2>/dev/null)"
  [[ -n "$target" && "$target" == "$1" ]]
}

# ─── ledger phases ────────────────────────────────────────────────────────────
ledger_init() {
  TXID="$(node -e 'const c=require("crypto");const b=c.randomBytes(16);const h=b.toString("hex");console.log(`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`)')"
  mkdir -p "$BACKING_ROOT"
  printf '{\n  "transaction-id": "%s",\n  "created-at": "%s",\n  "phases": {},\n  "manifest": null,\n  "asides": [],\n  "marker-pre": null,\n  "created-stubs": [],\n  "install-mode": "broker"\n}\n' "$TXID" "$(now_iso)" > "$LEDGER"
}
phase_intent()   { json_set "$LEDGER" "phases.$1" '"intent"' ; }
phase_complete() { json_set "$LEDGER" "phases.$1" '"complete"'; }
phase_state()    { json_get "$LEDGER" "phases.$1" | tr -d '"'; }

# ─── advisory marker ──────────────────────────────────────────────────────────
read_marker() { # echoes value ∈ broker|legacy|absent  (unreadable ⇒ absent, advisory)
  if [[ -f "$MARKER" ]]; then
    local v; v="$(cat "$MARKER" 2>/dev/null | tr -d '[:space:]')"
    case "$v" in
      broker|legacy) echo "$v" ;;
      *) echo absent ;;
    esac
  else
    echo absent
  fi
}

# ─── tuple observation (root-side mirror of the client's §4.6.5a inputs) ──────
observe_tuple() { # prints "<marker>|<attestation>|<observables>"
  local marker att obs
  marker="$(read_marker)"
  if [[ -e "$ATTESTATION" ]]; then
    att="$(json_get "$ATTESTATION" "install-mode" | tr -d '"')"
    [[ "$att" == "broker" || "$att" == "legacy" ]] || att="absent"
  else att="absent"; fi
  if [[ -d "$BACKING_ROOT" ]] || [[ -S "$RUN_DIR/socket" ]]; then obs="present"; else obs="absent"; fi
  echo "$marker|$att|$obs"
}

tuple_verdict() { # 18-tuple closed world (§4.6.5) from "<marker>|<attestation>|<observables>"
  local m a o; IFS='|' read -r m a o <<< "$1"
  if [[ "$a" == "broker" && "$o" == "present" && ( "$m" == "broker" || "$m" == "absent" ) ]]; then echo BROKER; return; fi
  if [[ "$m" != "broker" && "$a" != "broker" && "$o" == "absent" ]]; then echo LEGACY; return; fi
  echo CONFLICT
}

# ─── no-NOPASSWD assertion (§4.6.2 P5 step 3) ─────────────────────────────────
assert_no_nopasswd() {
  local d
  for d in "$SUDOERS_SCAN" /etc/sudoers; do
    [[ -d "$d" || -f "$d" ]] || continue
    if grep -rE 'NOPASSWD[^\n]*(minidc|brokerctl)' "$d" >/dev/null 2>&1; then
      DIE "NO-NOPASSWD assertion failed: a sudoers rule grants NOPASSWD to minidc surfaces — the password event is the design's elevation anchor (§4.4). Remove the rule and re-run."
    fi
  done
}

# ─── units ────────────────────────────────────────────────────────────────────
write_units() {
  # single source: broker/units/*.service templates, @VAR@ substituted at install.
  # Never installed un-substituted (a stray @VAR@ fails systemd loudly — fail-closed).
  mkdir -p "$UNIT_DIR" "$LIB_DIR/broker"
  local SCRIPT_DIR_ONCE
  SCRIPT_DIR_ONCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  for u in minidc-mounts.service minidc-broker.service; do
    sed -e "s|@BACKING_ROOT@|$BACKING_ROOT|g" \
        -e "s|@RUN_DIR@|$RUN_DIR|g" \
        -e "s|@NODE_BIN@|$NODE_BIN|g" \
        -e "s|@LIB_DIR@|$LIB_DIR|g" \
        -e "s|@MOUNT_HELPER@|$MOUNT_HELPER|g" \
        -e "s|@PEERCRED_HELPER@|$PEERCRED_HELPER|g" \
        "$SCRIPT_DIR_ONCE/units/$u" > "$UNIT_DIR/$u"
    if grep -q '@[A-Z_]*@' "$UNIT_DIR/$u"; then
      DIE "unit template substitution failed: $u still carries placeholders"
    fi
  done
}

# ─── the phases ───────────────────────────────────────────────────────────────
phase_p0_preconditions() {
  # P0 fresh-install preconditions (§4.6.1): broker-marker residue REFUSED, marker-pre
  # recorded ∈ {absent, legacy} ALWAYS, no ACTIVE units, residual disabled units cleared.
  local marker
  marker="$(read_marker)"
  if [[ "$marker" == "broker" ]]; then
    cat >&2 <<EOF
install.sh: REFUSED — pre-existing install-mode marker reads 'broker'.
This is not a valid install starting state (finding 3 of #9). Resolvers:
  (a) ledger-driven resume: re-run install.sh when $LEDGER exists
      (a crashed transaction resumes and completes from the ledger), or
  (b) install.sh --repair-mode  (no ledger: the no-ledger finalization removes the
      orphan marker and converges the desk).
EOF
    exit 3
  fi
  local unitstate
  for unit in minidc-broker.service minidc-mounts.service; do
    unitstate="$("$SYSTEMCTL" show -p ActiveState --value "$unit" 2>/dev/null || echo inactive)"
    if [[ "$unitstate" == "active" || "$unitstate" == "activating" ]]; then
      DIE "P0: unit $unit is ACTIVE — a live install exists; refusing"
    fi
  done
  # assert-and-clear residual DISABLED unit files unconditionally (finding 4 of #9)
  for unit in minidc-broker.service minidc-mounts.service; do
    if [[ -e "$UNIT_DIR/$unit" ]]; then
      rm -f "$UNIT_DIR/$unit"
      "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
      LOG "P0: residual disabled unit cleared: $unit"
    fi
  done
  [[ -d "$STORE_HOME" ]] || DIE "P0: store home absent: $STORE_HOME (fresh install requires the legacy store)"
  ledger_init
  if [[ "$marker" == "legacy" ]]; then
    json_set "$LEDGER" "marker-pre" '{"present":true,"value":"legacy"}'
  else
    json_set "$LEDGER" "marker-pre" '{"present":false}'
  fi
  # manifest: slugs + per-file sha256 + rules sha (or null — legitimately absent)
  local manifest
  manifest="$(node -e '
    const fs = require("fs"), path = require("path"), c = require("crypto");
    const store = process.argv[1], rules = process.argv[2];
    const slugs = {};
    for (const e of fs.readdirSync(store, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const files = {};
      const dir = path.join(store, e.name);
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isFile()) files[f] = c.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      }
      slugs[e.name] = files;
    }
    let rulesSha = null;
    try { rulesSha = c.createHash("sha256").update(fs.readFileSync(rules)).digest("hex"); } catch {}
    process.stdout.write(JSON.stringify({ slugs, "rules-sha": rulesSha }));
  ' "$STORE_HOME" "$LEGACY_RULES")"
  json_set "$LEDGER" "manifest" "$manifest"
  # finding 7: snapshot originals (uid/gid/mode per entry) BEFORE any move
  json_set "$LEDGER" "original-snapshot" "$(snapshot_originals)"
  phase_complete P0
  LOG "P0 complete (txid $TXID, marker-pre=$marker)"
}

phase_p1_quiesce() {
  phase_intent P1
  local out
  out="$("$FUSER" -s "$STORE_HOME"/*/* 2>&1 >/dev/null)" || true
  if "$FUSER" -s "$STORE_HOME"/*/* >/dev/null 2>&1; then
    DIE "P1: processes hold store files — run at a maintenance moment: $out"
  fi
  phase_complete P1
}

phase_p2_mounts_absent() {
  phase_intent P2
  if mounted_exactly "$STORE_HOME" || mounted_exactly "$RULES_DIR_MOUNT"; then
    DIE "P2: fresh install requires unmounted targets (exact mountpoint identity)"
  fi
  phase_complete P2
}

phase_p3_move_aside() {
  phase_intent P3
  local staging="$BACKING_ROOT/.staging-$TXID"
  mkdir -p "$staging"
  rsync -a "$STORE_HOME/" "$staging/store/"
  # manifest verify (sha256 match) — never trust the copy alone
  verify_manifest "$staging/store" || DIE "P3: manifest verification failed (staging copy corrupt)"
  local aside="$HOME_OF/.pi/agent/.mini-dc.migrated-$TXID"
  # fix2 finding7: CHECKED aside move — an unchecked failure would strand the
  # originals between staging and aside with the ledger naming neither
  mv "$STORE_HOME" "$aside" || DIE "P3: aside move failed — originals intact at source; abort"
  json_set "$LEDGER" "asides" "[\"$aside\"]"
  # rules file (skipped entirely when manifest rules-sha null — legitimately absent)
  local rulesSha; rulesSha="$(json_get "$LEDGER" "manifest.rules-sha" | tr -d '"')"
  if [[ "$rulesSha" != "null" && -f "$LEGACY_RULES" ]]; then
    mkdir -p "$staging/rules"
    mv "$LEGACY_RULES" "$staging/rules/rules.yaml"
  fi
  phase_complete P3
  LOG "P3 complete (aside $aside)"
}

verify_manifest() { # <staging-store-dir> — sha256 match against the ledger manifest
  node -e '
    const fs = require("fs"), path = require("path"), c = require("crypto");
    const staging = process.argv[1];
    const ledger = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const manifest = ledger.manifest;
    for (const [slug, files] of Object.entries(manifest.slugs)) {
      for (const [f, want] of Object.entries(files)) {
        const p = path.join(staging, slug, f);
        const got = c.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
        if (got !== want) { process.exit(1); }
      }
    }
    process.exit(fs.existsSync(staging) ? 0 : 1);
  ' "$1" "$LEDGER"
}

phase_p4_backing_tree() {
  phase_intent P4
  if [[ -z "$TEST_ROOT" ]]; then
    getent group minidc-broker >/dev/null 2>&1 || groupadd -r minidc-broker
    id -u minidc-broker >/dev/null 2>&1 || useradd -r -g minidc-broker -s /usr/sbin/nologin -M minidc-broker
  fi
  mkdir -p "$BACKING_ROOT/store" "$BACKING_ROOT/rules" "$STATE_DIR" "$STATE_DIR/runtime"
  local staging="$BACKING_ROOT/.staging-$TXID"
  # finding 7 fix: CHECKED complete-tree migration — no glob skips (dotentries were
  # silently dropped), no ignored move failures. rsync -a carries hidden entries by
  # construction and reports failures; the staging tree must be GONE afterwards.
  if [[ -d "$staging/store" ]]; then
    rsync -a "$staging/store/" "$BACKING_ROOT/store/" || DIE "P4: staging->backing migration failed (store)"
    rm -rf --one-file-system "$staging/store" || DIE "P4: staging store removal failed after migration"
  fi
  if [[ -f "$staging/rules/rules.yaml" ]]; then
    mv "$staging/rules/rules.yaml" "$BACKING_ROOT/rules/rules.yaml" || DIE "P4: rules migration failed"
    rmdir "$staging/rules" 2>/dev/null || true
  fi
  # root-owned 0640 state direct entries (certification empty set; attestation; health;
  # R2 v2: the desk-local installation ID + the repo-approved digest list's installed
  # root-owned copy — the effective approved source, worker-unwritable by ownership)
  printf '{"version":2,"backends":[]}\n' > "$STATE_DIR/certified-backends.json"
  head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$STATE_DIR/installation-id"
  cp -f "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/approved-backends.json" "$STATE_DIR/approved-backends.json" \
    || DIE "P4: approved-backends.json copy failed (repo-tracked source missing?)"
  printf '{"install-mode":"broker","transaction-id":"%s","attested-at":"%s"}\n' "$TXID" "$(now_iso)" > "$ATTESTATION"
  printf '{"healthy":false,"boot-id":null,"checked-at":null,"findings":["pre-activation"]}\n' > "$MOUNT_HEALTH"
  # daemon-writable runtime initial files (root-owned 0660 until first daemon transition)
  printf '{\n  "version": 1,\n  "boot-id": "%s",\n  "entitlements": [],\n  "consumed-tokens": {}\n}\n' \
    "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo none)" > "$STATE_DIR/runtime/registrations.json"
  : > "$STATE_DIR/runtime/audit-ring.jsonl"
  # the P4-CREATED journal: EMPTY, root:root 0600, UNCONDITIONALLY (finding 1 of #10 —
  # the helper APPENDS, never creates)
  : > "$JOURNAL"
  # recursive ownership AND per-type mode pass over the writable namespaces (a chown-only
  # P4 is insufficient — daemon locking/appends need the group bits; §4.1)
  recursive_pass "$BACKING_ROOT/store"
  rules_pass # D4 (soak defect 4): the rules tree takes the READABLE pass — the rules are the floor sessions LOAD through the attached view
  recursive_pass "$BACKING_ROOT/state/runtime"
  if [[ -z "$TEST_ROOT" ]]; then
    chown root:minidc-broker "$STATE_DIR/certified-backends.json" "$STATE_DIR/approved-backends.json" "$STATE_DIR/installation-id" "$ATTESTATION" "$MOUNT_HEALTH"
    chmod 0640 "$STATE_DIR/certified-backends.json" "$STATE_DIR/approved-backends.json" "$STATE_DIR/installation-id" "$ATTESTATION" "$MOUNT_HEALTH"
    chown root:root "$JOURNAL" "$LEDGER"; chmod 0600 "$JOURNAL" "$LEDGER"
    chown root:root "$STATE_DIR"; chmod 0755 "$STATE_DIR"
    chown root:root "$BACKING_ROOT"; chmod 0755 "$BACKING_ROOT"
  else
    # test mode realizes MODES only (chown is root-only — the ownership rows are
    # install-stage validation)
    chmod 0640 "$STATE_DIR/certified-backends.json" "$STATE_DIR/approved-backends.json" "$STATE_DIR/installation-id" "$ATTESTATION" "$MOUNT_HEALTH"
    chmod 0600 "$JOURNAL" "$LEDGER"
    chmod 0755 "$STATE_DIR" "$BACKING_ROOT"
  fi
  phase_complete P4
  LOG "P4 complete (backing tree established, journal created empty)"
}

recursive_pass() { # per-type mode enforcement accompanies the (root) chown — §4.1
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  if [[ -z "$TEST_ROOT" ]]; then
    chown -R root:minidc-broker "$dir"
  fi
  find "$dir" -type d -exec chmod 02770 {} +
  find "$dir" -type f -exec chmod 0660 {} +
}

rules_pass() { # D4 (soak defect 4): the rules tree carries the READABLE-view modes.
  # The rules are the safety floor every session must LOAD through the attached
  # view, and the view IS the backing inode (bind) — 02770/0660 there meant the
  # target user got EACCES ⇒ "no rules loaded" ⇒ bash denied for ALL new sessions.
  # Mode law: dirs 0775 / files 0664 — other-class gets the read+traverse the
  # target user needs (the brief's world-readable blessing), while the minidc-broker
  # GROUP keeps rwx/rw so the daemon's write-rules op (temp+rename into the dir)
  # still works. The setgid bit may survive chmod (the kernel preserves it for
  # in-group callers — verified empirically) and is TOLERATED: it only steers
  # group inheritance on daemon-written files. The STORE/state passes keep 02770/0660.
  local dir="$BACKING_ROOT/rules"
  [[ -d "$dir" ]] || return 0
  if [[ -z "$TEST_ROOT" ]]; then
    chown -R root:minidc-broker "$dir"
  fi
  find "$dir" -type d -exec chmod 0775 {} +
  find "$dir" -type f -exec chmod 0664 {} +
}

# finding 7 fix: original ownership/mode SNAPSHOT at P0 (pre-move), persisted in the
# ledger — the rollback's restoration applies it so restored originals are EXACTLY
# what they were (never broker-owned, never mode-shifted).
snapshot_originals() {
  node -e '
    const fs = require("fs"), path = require("path");
    const store = process.argv[1];
    const out = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        const st = fs.lstatSync(p);
        out[path.relative(store, p)] = { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 };
        if (e.isDirectory()) walk(p);
      }
    };
    walk(store);
    process.stdout.write(JSON.stringify(out));
  ' "$STORE_HOME"
}

# restore ownership+modes from the ledger snapshot (non-destructive: entries are
# already back at their true paths; only uid/gid/mode are applied)
restore_originals() {
  # fix2 finding7: EVERY chown/chmod is CHECKED — a swallowed failure could leave
  # restored entries broker-owned/0660 (unreadable to their owner; the end-state
  # check's root-side ls cannot catch that). ENOENT on the path is tolerated (the
  # entry list is the P0 snapshot; a missing path is surfaced by the end-state
  # check's readability assertion); every other failure aborts the rollback
  # BEFORE further steps, with the ledger and tree intact.
  node -e '
    const fs = require("fs"), path = require("path");
    const store = process.argv[1];
    const ledger = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const snap = ledger["original-snapshot"] || {};
    for (const [rel, meta] of Object.entries(snap)) {
      const p = path.join(store, rel);
      let st;
      try { st = fs.lstatSync(p); } catch (e) {
        if (e.code === "ENOENT") continue; // missing path — end-state check surfaces it
        process.stderr.write("restore-originals: lstat failed " + rel + ": " + e.message + "\n");
        process.exit(1);
      }
      try {
        if (st.uid !== meta.uid || st.gid !== meta.gid) fs.chownSync(p, meta.uid, meta.gid);
        if ((st.mode & 0o7777) !== meta.mode) fs.chmodSync(p, meta.mode);
      } catch (e) {
        process.stderr.write("restore-originals: chown/chmod failed " + rel + ": " + e.message + "\n");
        process.exit(1);
      }
    }
  ' "$STORE_HOME" "$LEDGER" || DIE "rollback step 7: original ownership/mode restore FAILED — abort before discard AND before the ledger unlink (ledger intact)"
}

phase_p5_activate() {
  phase_intent P5
  write_units
  # install the broker + helper payloads
  mkdir -p "$LIB_DIR/broker"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cp -f "$SCRIPT_DIR/minidc-broker.ts" "$LIB_DIR/broker/minidc-broker.ts"
  # the installed daemon imports its certification sibling — they ship together
  cp -f "$SCRIPT_DIR/minidc-certify.ts" "$LIB_DIR/broker/minidc-certify.ts"
  cp -f "$SCRIPT_DIR/minidc-canary.ts" "$LIB_DIR/broker/minidc-canary.ts"
  if [[ -z "$TEST_ROOT" ]]; then
    # compile the fd-bound mount helper (D3 — raw syscalls need C; cc-checked, fail-closed)
    if ! command -v cc >/dev/null 2>&1; then
      DIE "P5: no C compiler for the mount helper — the mounts service cannot be built; fail-closed (attended fallback law, §4.6.4)"
    fi
    cc -O2 -Wall -o "$MOUNT_HELPER" "$SCRIPT_DIR/minidc-mount-helper.c" || DIE "P5: mount helper compile failed"
    chown root:root "$MOUNT_HELPER"; chmod 0755 "$MOUNT_HELPER"
    # compile the peer-credential helper (R2 v2 / R4 — SO_PEERCRED needs C; same law)
    cc -O2 -Wall -o "$PEERCRED_HELPER" "$SCRIPT_DIR/minidc-peercred-helper.c" || DIE "P5: peercred helper compile failed"
    chown root:root "$PEERCRED_HELPER"; chmod 0755 "$PEERCRED_HELPER"
  else
    # test mode: the harness's helper stub lands at LIB_DIR (production compiles the
    # real C helper there — same destination)
    cp -f "$STUB_BIN/minidc-mount-helper.payload" "$LIB_DIR/minidc-mount-helper" 2>/dev/null || true
    chmod +x "$LIB_DIR/minidc-mount-helper" 2>/dev/null || true
    # peercred helper: no stub machinery exists — compile for real when cc exists so
    # the test tree exercises the true binary; absence degrades exactly like
    # production-missing (presenter family fail-closed) and is not fatal here
    if command -v cc >/dev/null 2>&1; then
      cc -O2 -Wall -o "$PEERCRED_HELPER" "$SCRIPT_DIR/minidc-peercred-helper.c" 2>/dev/null || true
      chmod 0755 "$PEERCRED_HELPER" 2>/dev/null || true
    fi
  fi
  "$SYSTEMCTL" daemon-reload
  "$SYSTEMCTL" enable minidc-mounts.service minidc-broker.service >/dev/null 2>&1 || true
  assert_no_nopasswd
  printf 'broker' > "$MARKER"   # advisory mode marker (authoritative record is the ledger)
  # NO stub mirroring happens here (finding 2 of #9) — step 4b below, AFTER awaited activation
  # step 4: start and AWAIT the mounts service (bounded BOTH sides; no blocking systemctl)
  "$SYSTEMCTL" start --no-block minidc-mounts.service
  if ! poll_unit minidc-mounts.service active 90; then
    DIE "P5: mounts service not active within 90 s — aborting at P5 (helper findings: $(cat "$MOUNT_HEALTH" 2>/dev/null || echo none))"
  fi
  # step 4b: mirror created-stubs from the helper journal INTO THE LEDGER (ground truth = journal)
  mirror_created_stubs
  # step 5: start and AWAIT the broker (unit poll + status-frame probe, 30 s deadline)
  "$SYSTEMCTL" start --no-block minidc-broker.service
  # fix2 finding6: ELAPSED-time deadline (the sleep-count loop ran 7.5 s of a 30 s budget)
  local rstart state
  rstart="$(date +%s)"
  while :; do
    state="$("$SYSTEMCTL" show -p ActiveState --value minidc-broker.service 2>/dev/null || echo unreadable)"
    if [[ "$state" == "active" ]] && brokerctl_status_ok; then break; fi
    if (( $(date +%s) - rstart >= 30 )); then
      DIE "P5: broker not ready within 30 s — aborting at P5"
    fi
    sleep 0.25
  done
  phase_complete P5
  LOG "P5 complete (mounts active, stubs mirrored, broker ready)"
}

brokerctl_status_ok() {
  local ctl="$SCRIPT_DIR/minidc-brokerctl.ts"
  if [[ -n "$TEST_ROOT" ]]; then ctl="$STUB_BIN/minidc-brokerctl"; fi
  "$ctl" status --socket "$RUN_DIR/socket" >/dev/null 2>&1
}

mirror_created_stubs() {
  # the helper journal is the GROUND TRUTH; the ledger row is a cache (finding 2 of #9).
  # The journal EXISTS from P4 (finding 1 of #10) and is untouched while the ledger
  # stands (finding 1 of #11) — this read never meets clean ENOENT at any ledger-bearing
  # entry. UNREADABLE journal (corrupt/EIO) ⇒ abort — never guess the stub set.
  if [[ ! -r "$JOURNAL" ]]; then
    DIE "journal unreadable at stub mirror — refusing to guess the stub set"
  fi
  local stubs
  stubs="$(grep -o 'created-stub:[^"]*' "$JOURNAL" 2>/dev/null | sed 's/^created-stub://' | sort -u | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write(JSON.stringify(d.trim().split("\n").filter(Boolean)))})')"
  json_set "$LEDGER" "created-stubs" "$stubs"
}

phase_p6_verify() {
  phase_intent P6
  # root-side hashing — no client rules op exists to call (§4.6.3)
  local want rulesSha
  want="$(node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.manifest["rules-sha"]??"null"))}catch{process.stdout.write("null")}' "$LEDGER")"
  if [[ "$want" == "null" ]]; then
    [[ -f "$BACKING_ROOT/rules/rules.yaml" ]] && DIE "P6: manifest rules:null but backing rules.yaml exists"
  else
    rulesSha="$(sha256_of "$BACKING_ROOT/rules/rules.yaml")"
    [[ "$rulesSha" == "$want" ]] || DIE "P6: rules sha mismatch"
  fi
  local tuple; tuple="$(observe_tuple)"
  [[ "$(tuple_verdict "$tuple")" == "BROKER" ]] || DIE "P6: mode tuple not BROKER: $tuple"
  # defect-8 revision (2026-11-25, review finding 1): the AUTHORIZED node
  # runtime, as resolved by root at install time, lands in a root-owned
  # world-readable trust file — the session-side owner launch reads it as
  # its only trust source (MINIDC_NODE_BIN is honored only byte-identical
  # to this entry). A source no session user can change.
  if [[ -z "$TEST_ROOT" ]]; then
    mkdir -p /etc/minidc
    printf '%s\n' "$NODE_BIN" > /etc/minidc/node-bin.tmp
    chown root:root /etc/minidc/node-bin.tmp
    chmod 0444 /etc/minidc/node-bin.tmp
    mv -f /etc/minidc/node-bin.tmp /etc/minidc/node-bin
    LOG "P6: authorized node runtime recorded (/etc/minidc/node-bin -> $NODE_BIN)"
  else
    mkdir -p "$TEST_ROOT/etc/minidc"
    printf '%s\n' "$NODE_BIN" > "$TEST_ROOT/etc/minidc/node-bin"
  fi
  phase_complete P6
  LOG "P6 complete (root-side hash + tuple verified)"
}

phase_p7_commit() {
  phase_intent P7
  local aside
  while IFS= read -r aside; do
    [[ -d "$aside" ]] && rm -rf -- "$aside"
  done < <(json_get "$LEDGER" "asides" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const a of JSON.parse(d))console.log(a)})')
  phase_complete P7
  json_set "$LEDGER" "installed" "true"
  LOG "INSTALL COMPLETE (txid $TXID)"
}

# ─── rollback (§4.6.2 P5 Rollback — LEDGER-FIRST discard; every call deadline-bound) ──
do_rollback() {
  if [[ ! -f "$LEDGER" ]]; then
    no_ledger_finalization "rollback"
    return $?
  fi
  # step 0 — re-mirror created-stubs from the helper journal at ROLLBACK ENTRY (runs FIRST)
  mirror_created_stubs
  # step 1 — stop the broker (45 s > unit TimeoutStopSec=30)
  "$SYSTEMCTL" stop --no-block minidc-broker.service
  poll_unit minidc-broker.service "inactive|failed" 45 || DIE "rollback step 1: broker still stopping at 45 s deadline — abort (re-run resumes idempotently)"
  # step 2 — stop the mounts unit (runs its ExecStop; 120 s > unit TimeoutStopSec=90).
  # Already-inactive branch (prior crash / manual stop): invoke the helper --stop
  # directly ONCE (30 s timeout) for the same write-and-unmount discipline.
  local prestate
  prestate="$("$SYSTEMCTL" show -p ActiveState --value minidc-mounts.service 2>/dev/null || echo inactive)"
  if [[ "$prestate" == "inactive" || "$prestate" == "failed" ]]; then
    if mounted_exactly "$STORE_HOME" || mounted_exactly "$RULES_DIR_MOUNT"; then
      timeout 30 "$MOUNT_HELPER" --stop || DIE "rollback step 2: direct helper --stop failed — abort"
    fi
  else
    "$SYSTEMCTL" stop --no-block minidc-mounts.service
    if ! poll_unit minidc-mounts.service "inactive|failed" 120; then
      DIE "rollback step 2: mounts still stopping at 120 s deadline — abort"
    fi
  fi
  # step 3 — disable both (separate from stops; NO --now anywhere in the rollback;
  # finding 6 fix: bounded — a symlink operation, 15 s command timeout)
  timeout 15 "$SYSTEMCTL" disable minidc-broker.service minidc-mounts.service >/dev/null 2>&1 || true
  # step 4 — verify both mountpoints unmounted (30 s deadline)
  local waited=0
  local mstart; mstart="$(date +%s)"
  while :; do
    if ! mounted_exactly "$STORE_HOME" && ! mounted_exactly "$RULES_DIR_MOUNT"; then break; fi
    if (( $(date +%s) - mstart >= 30 )); then DIE "rollback step 4: mount still present at 30 s — abort (never force)"; fi
    sleep 0.25
  done
  # step 5 — dispose validated-empty helper-created stubs ONLY
  local stub
  while IFS= read -r stub; do
    [[ -n "$stub" ]] || continue
    if [[ -d "$stub" ]]; then
      if [[ -z "$(ls -A "$stub" 2>/dev/null)" ]]; then rmdir "$stub" || DIE "rollback step 5: rmdir failed on empty stub $stub"
      else DIE "rollback step 5: stub NOT empty — abort, never delete: $stub"; fi
    fi
  done < <(json_get "$LEDGER" "created-stubs" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{for(const s of JSON.parse(d))console.log(s)})')
  # step 6 — restore the advisory marker to marker-pre (absent/legacy ONLY — a broker
  # restore is impossible: no rollback path writes broker here; finding 3 of #9)
  local mp; mp="$(json_get "$LEDGER" "marker-pre")"
  if [[ "$mp" == *'"legacy"'* ]]; then
    printf 'legacy' > "$MARKER" || DIE "rollback step 6: marker write failed — abort before discard (ledger intact)"
  else
    rm -f "$MARKER"
  fi
  # step 7 — aside restore, THEN THE ATOMIC LEDGER UNLINK (the SOLE transition into the
  # no-ledger finalization state — no other entry of the backing namespace is removed
  # before it; code-shape pin), THEN the convergent discard of the remaining tree
  # (journal included — deliberately not atomic; findings 2 of #10 + 1 of #11)
  local aside
  local asideFound=0
  while IFS= read -r aside; do
    [[ -n "$aside" && -d "$aside" ]] || continue
    # the only aside the installer creates is the store aside (P3)
    if [[ -e "$STORE_HOME" ]]; then
      DIE "rollback step 7: destination occupied: $STORE_HOME — abort before discard AND before the ledger unlink"
    fi
    mv "$aside" "$STORE_HOME" || DIE "rollback step 7: aside restore failed — abort before discard AND before the ledger unlink (ledger intact)"
    asideFound=1
  done < <(node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const a of (d.asides||[]))console.log(a)}catch{}' "$LEDGER")
  # post-commit rollback (P7 deleted the asides): the manifest copies inside the
  # backing tree ARE the rollback source — copy them back before the discard
  if [[ "$asideFound" -eq 0 && -d "$BACKING_ROOT/store" ]]; then
    if [[ -e "$STORE_HOME" ]]; then
      DIE "rollback step 7: destination occupied: $STORE_HOME — abort before discard AND before the ledger unlink"
    fi
    cp -a "$BACKING_ROOT/store" "$STORE_HOME" || DIE "rollback step 7: post-commit restore from backing failed — abort before discard AND before the ledger unlink (ledger intact)"
  fi
  # finding 7 fix: rules restore BEFORE any backing removal, CHECKED, and only from
  # a still-present backing copy — the abort-before-discard and ledger-first orderings
  # stay intact (a failed restore aborts with the ledger and tree both present)
  local want2; want2="$(node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.manifest["rules-sha"]??"null"))}catch{process.stdout.write("null")}' "$LEDGER")"
  if [[ "$want2" != "null" && -f "$BACKING_ROOT/rules/rules.yaml" && ! -e "$LEGACY_RULES" ]]; then
    cp -a "$BACKING_ROOT/rules/rules.yaml" "$LEGACY_RULES" || DIE "rollback step 7: rules restore failed — abort before discard AND before the ledger unlink (ledger intact)"
  fi
  # finding 7 fix: restored originals get their ORIGINAL ownership/modes (from the
  # P0 snapshot) — never broker ownership, never mode drift
  if [[ -d "$STORE_HOME" ]]; then
    restore_originals
  fi
  # THE LEDGER UNLINK — first and sole mutating act of the discard phase
  rm -f -- "$LEDGER"
  # convergent discard: depth-first content removal + rmdir (idempotent fixed point)
  convergent_discard "$BACKING_ROOT"
  # step 8 — END-STATE CHECK (acceptance criterion; NOTHING is marked anywhere — no
  # post-deletion ledger write exists, no receipt file is created)
  end_state_check "ledger-driven" "$mp"
  LOG "ROLLBACK COMPLETE — desk restored"
}

convergent_discard() { # depth-first content removal, then rmdir — re-runnable to the same fixed point
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  local entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    if [[ -L "$entry" ]]; then rm -f -- "$entry"
    elif [[ -d "$entry" ]]; then convergent_discard "$entry"
    else rm -f -- "$entry"; fi
  done < <(find "$dir" -mindepth 1 -maxdepth 1 2>/dev/null)
  rmdir "$dir" 2>/dev/null || true
}

end_state_check() { # <mode> <marker-pre-json> — the step-8 assertions
  local mode="$1" mp="$2"
  # (a) backing namespace ABSENT (clean ENOENT)
  [[ -e "$BACKING_ROOT" ]] && DIE "$mode end-state: backing namespace still present"
  # (b) fresh tuple observation: usable-legacy, ZERO conflict rows
  local tuple verdict marker
  tuple="$(observe_tuple)"
  verdict="$(tuple_verdict "$tuple")"
  if [[ "$mode" == "ledger-driven" ]]; then
    if [[ "$mp" == *'"legacy"'* ]]; then
      [[ "$(read_marker)" == "legacy" ]] || DIE "ledger-driven end-state: marker should read legacy"
    else
      [[ "$(read_marker)" == "absent" ]] || DIE "ledger-driven end-state: marker should be absent"
    fi
  fi
  [[ "$verdict" == "LEGACY" ]] || DIE "$mode end-state: tuple not usable-legacy: $tuple ($(tuple_verdict "$tuple"))"
  # (c) restored originals readable at their true paths
  [[ -d "$STORE_HOME" ]] || DIE "$mode end-state: restored store home missing"
  ls "$STORE_HOME" >/dev/null 2>&1 || DIE "$mode end-state: store home unreadable"
}

# ─── the NO-LEDGER FINALIZATION (§4.6.2 step 8a — one law, two entries) ───────
no_ledger_finalization() {
  local entry="$1" unit unitstate
  LOG "no ledger observed ($entry) — running the no-ledger finalization"
  # 1. GUARDS: active unit ⇒ refuse (never tear down blind); mounted mountpoint ⇒ abort
  for unit in minidc-broker.service minidc-mounts.service; do
    unitstate="$("$SYSTEMCTL" show -p ActiveState --value "$unit" 2>/dev/null || echo inactive)"
    if [[ "$unitstate" == "active" || "$unitstate" == "activating" ]]; then
      DIE "finalization guard: unit $unit is ACTIVE ($unitstate) — refuse (this is not this path's shape; resolver: --rollback after stopping)"
    fi
  done
  if mounted_exactly "$STORE_HOME" || mounted_exactly "$RULES_DIR_MOUNT"; then
    DIE "finalization guard: a mountpoint is still mounted — abort with the residue named (captain word; never force)"
  fi
  # 2. RESIDUE CLEANUP — convergent (journal remains included; idempotent fixed point)
  if [[ -e "$BACKING_ROOT" ]]; then
    convergent_discard "$BACKING_ROOT"
    LOG "finalization: backing residue swept"
  fi
  # 3. VERIFY ABSENCE
  [[ -e "$BACKING_ROOT" ]] && DIE "finalization: backing namespace still present after sweep"
  # 4. END-STATE ASSERTIONS (tuple 12-OR-18 — both usable-legacy; the ledger-paired
  #    identity is asserted only by the ledger-driven step 8) + the marker leg
  local marker; marker="$(read_marker)"
  if [[ "$marker" == "broker" ]]; then
    rm -f -- "$MARKER"
    LOG "finalization: orphan broker marker REMOVED (no ledger stands behind it)"
  fi
  end_state_check "finalization" ""
  LOG "FINALIZATION COMPLETE — desk at the verified-clean pre-install state"
}

# ─── repair modes ─────────────────────────────────────────────────────────────
do_repair_mode() {
  if [[ ! -f "$LEDGER" ]]; then
    no_ledger_finalization "repair-mode"
    return $?
  fi
  # live ledger ⇒ reconcile attestation + marker to the LEDGER's truth
  local mode; mode="$(json_get "$LEDGER" "install-mode" | tr -d '"')"
  if [[ "$mode" != "broker" ]]; then mode="broker"; fi
  printf '{"install-mode":"%s","transaction-id":"%s","attested-at":"%s"}\n' "$mode" "$(json_get "$LEDGER" "transaction-id" | tr -d '"')" "$(now_iso)" > "$ATTESTATION"
  printf '%s' "$mode" > "$MARKER"
  LOG "repair-mode: attestation + marker reconciled to ledger truth ($mode)"
}

do_repair_mounts() {
  [[ -x "$MOUNT_HELPER" ]] || DIE "repair-mounts: helper not installed"
  # D4: converge the rules-tree modes BEFORE the re-attach — the attached view
  # carries the backing inode's modes, so an old install's 02770/0660 tree must
  # not survive a repair re-run (the soak's EACCES shape).
  rules_pass
  "$MOUNT_HELPER" || DIE "repair-mounts: helper activation failed (see $MOUNT_HEALTH)"
  LOG "repair-mounts: activation re-run (rules-view modes converged)"
}

# ─── legacy mode selection (D2+D3 — the 2026-11-24 soak defects) ─────────────
# The OLD marker-only flip is GONE. Under the client's closed-world tuple law a
# mode command may exit ONLY in a state the session client classifies LEGACY:
# no broker evidence anywhere (attestation/observables structurally absent),
# marker=legacy, and a valid rules file at the legacy path (D2 — sessions
# fail-close with "no rules loaded" without one).
do_mode_legacy() {
  if [[ -f "$LEDGER" ]]; then
    # D3: record the operator's choice as the LEDGER TRUTH first — a crashed or
    # aborted flip leaves every resolver (--repair-mode, the re-run) converging
    # on legacy, never back to broker against the operator's word.
    json_set "$LEDGER" "install-mode" '"legacy"'
    LOG "mode flip: legacy recorded as ledger truth — tearing the broker install down"
    do_rollback
  elif [[ -e "$BACKING_ROOT" || -S "$RUN_DIR/socket" ]] || [[ "$(read_marker)" == "broker" ]]; then
    # no ledger but broker residue/orphan marker — the finalization sweeps it
    no_ledger_finalization "mode-legacy"
  fi
  mkdir -p "$(dirname "$MARKER")"
  printf 'legacy' > "$MARKER"
  materialize_legacy_rules
  # D3: the exit gate — no mode command leaves a conflict/unavailable desk
  local tuple; tuple="$(observe_tuple)"
  [[ "$(tuple_verdict "$tuple")" == "LEGACY" ]] || DIE "--mode legacy: exit tuple not LEGACY: $tuple (marker/attestation/observables inconsistent — re-run resumes; --repair-mode reconciles)"
  LOG "legacy mode selected (rules guaranteed at the legacy path)"
}

# D2: the legacy rules path must never be empty or shadowed while the marker says
# legacy. Source = the tracked mini-dc-rules.yaml from the checkout the installer
# runs from (the same bytes a supervisor git-restore lands). Idempotent: a valid
# non-empty regular file is KEPT (the rollback's finding-7 restore may have landed
# the desk's own bytes — better truth); an EMPTY regular file is converged; a
# symlink/directory is named and refused (never auto-clobber unverifiable material).
materialize_legacy_rules() {
  local src
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/mini-dc-rules.yaml"
  if [[ -L "$LEGACY_RULES" ]]; then
    DIE "--mode legacy: legacy rules path is a SYMLINK — resolve manually (never auto-clobber): $LEGACY_RULES"
  fi
  if [[ -e "$LEGACY_RULES" ]] && [[ ! -f "$LEGACY_RULES" ]]; then
    DIE "--mode legacy: legacy rules path occupied by a non-regular entry — resolve manually: $LEGACY_RULES"
  fi
  if [[ -f "$LEGACY_RULES" && -s "$LEGACY_RULES" ]]; then
    LOG "legacy rules already present at the legacy path (kept)"
    return 0
  fi
  [[ -f "$src" ]] || DIE "--mode legacy: tracked rules source missing from the checkout: $src"
  mkdir -p "$(dirname "$LEGACY_RULES")"
  cp -f "$src" "$LEGACY_RULES" || DIE "--mode legacy: rules materialization failed (write)"
  if [[ -z "$TEST_ROOT" ]]; then
    chown "$TARGET_USER" "$LEGACY_RULES" || DIE "--mode legacy: rules chown to the target user failed"
  fi
  chmod 0644 "$LEGACY_RULES"
  [[ -f "$LEGACY_RULES" && -s "$LEGACY_RULES" ]] || DIE "--mode legacy: rules materialization verify failed"
  LOG "legacy rules materialized from the tracked checkout: $LEGACY_RULES"
}

# ─── fresh/resume dispatch ────────────────────────────────────────────────────
do_install() {
  if [[ ! -f "$LEDGER" ]]; then
    phase_p0_preconditions
    phase_p1_quiesce
    phase_p2_mounts_absent
  else
    # P0′ resume: ledger parses; ground truth per phase decides re-entry (never trust
    # the ledger alone). Originals may be aside, units may exist, mounts may be partial.
    TXID="$(json_get "$LEDGER" "transaction-id" | tr -d '"')"
    [[ -n "$TXID" ]] || DIE "P0': ledger unreadable — no transaction-id"
    if [[ "$(json_get "$LEDGER" "marker-pre")" == "null" ]]; then
      # marker-pre back-fill (§4.6.1) — {absent, legacy, unreadable} only
      local m; m="$(read_marker)"
      if [[ "$m" == "legacy" ]]; then json_set "$LEDGER" "marker-pre" '{"present":true,"value":"legacy"}';
      else json_set "$LEDGER" "marker-pre" '{"present":false}'; fi
    fi
    LOG "P0' resume (txid $TXID, P4=$(phase_state P4))"
  fi
  if [[ "$(phase_state P3)" != "complete" ]] && [[ ! -d "$HOME_OF/.pi/agent/.mini-dc.migrated-$TXID" ]]; then
    phase_p3_move_aside
  fi
  if [[ "$(phase_state P4)" != "complete" ]]; then
    phase_p4_backing_tree
  fi
  if [[ "$(phase_state P5)" != "complete" ]]; then
    phase_p5_activate
  fi
  if [[ "$(phase_state P6)" != "complete" ]]; then
    phase_p6_verify
  fi
  if [[ "$(phase_state P7)" != "complete" ]]; then
    phase_p7_commit
  fi
  # D3: a mode-selection invocation exits ONLY in a client-consistent state. With
  # the install complete, converge the advisory marker to the ledger's truth — the
  # production drift (a legacy-valued marker over a live broker install) classified
  # CONFLICT at every session start — then gate the exit on the tuple verdict.
  if [[ "$(json_get "$LEDGER" "installed")" == "true" ]] && [[ "$(read_marker)" != "broker" ]]; then
    printf 'broker' > "$MARKER"
    LOG "install exit: advisory marker reconciled to ledger truth (broker)"
  fi
  local tuple; tuple="$(observe_tuple)"
  [[ "$(tuple_verdict "$tuple")" == "BROKER" ]] || DIE "install exit: mode tuple not BROKER: $tuple (--repair-mode reconciles)"
}

main() {
  case "${1:-}" in
    --mode)
      if [[ "${2:-}" == "legacy" ]]; then
        # legacy mode: the full transactional flip (D2+D3 — the marker-only law
        # is gone; every exit is a client-consistent LEGACY desk)
        do_mode_legacy
        exit 0
      fi
      if [[ "${2:-}" != "broker" ]]; then
        DIE "--mode accepts broker|legacy (broker is the default full install)"
      fi
      do_install
      ;;
    --rollback)
      do_rollback
      ;;
    --repair-mode)
      do_repair_mode
      ;;
    --repair-mounts)
      do_repair_mounts
      ;;
    "")
      do_install
      ;;
    *)
      usage
      ;;
  esac
}

usage() {
  cat >&2 <<'EOF'
usage: install.sh [--mode broker|legacy] [--rollback] [--repair-mode] [--repair-mounts]
EOF
  exit 2
}

main "$@"
