#!/usr/bin/env bash
# tests/calm/lib.sh — slim harness for the ported Calm suite (pi-E layout).
# Contracts mirror kunchenguid/dotfiles tests/lib.sh (MIT-0) — only the names
# the suite calls: fail/pass, assert_contains/assert_not_contains,
# dotfiles_test_tmproot/dotfiles_test_cleanup. Ported 2026-09-26 (promote).

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

assert_contains() {
  local haystack=$1 needle=$2 message=$3
  case "$haystack" in
    *"$needle"*) : ;;
    *) fail "$message" ;;
  esac
}

assert_not_contains() {
  local haystack=$1 needle=$2 message=$3
  case "$haystack" in
    *"$needle"*) fail "$message" ;;
    *) : ;;
  esac
}

DOTFILES_TEST_CLEANUP_DIRS=()

dotfiles_test_cleanup() {
  local d
  for d in "${DOTFILES_TEST_CLEANUP_DIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
}

dotfiles_test_tmproot() {
  local prefix=${1:-dotfiles-test} root
  root=$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")
  if [ "${#DOTFILES_TEST_CLEANUP_DIRS[@]}" -eq 0 ]; then
    trap dotfiles_test_cleanup EXIT
  fi
  DOTFILES_TEST_CLEANUP_DIRS+=("$root")
  printf '%s\n' "$root"
}
