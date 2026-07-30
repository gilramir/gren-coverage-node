#!/bin/bash
#
# End-to-end coverage for the initial target: the gren-format-lib test harness.
#   entry point : tests/Main   (NOT the CLI — different DCE)
#   denominator : src/**
#
# Drives the `gren-coverage-node` command as an installed user would (see
# DEPLOY.md — `npm install -g gren-coverage-node`), not the in-repo ./app build.
# Run from the root of the project being measured (e.g. gren-format-lib/) —
# this assumes the CWD is already there. Builds a sourcemapped test app, runs
# it under V8 coverage, and joins the V8 data against a fresh index of the
# project's sources into coverage.json (`join` indexes the --src project
# itself). Writes intermediates under out/.
#
# Usage:  (cd /path/to/gren-format-lib && /path/to/gren-coverage-node/run-coverage.sh)

set -e

if ! command -v gren-coverage-node >/dev/null; then
  echo "!! gren-coverage-node not found on PATH — see DEPLOY.md to build + install it" >&2
  exit 1
fi

ROOT=$(pwd)   # clean absolute path (no ..) for report SF/file
OUT="${ROOT}/out"
COVDIR="${OUT}/v8cov"

mkdir -p "${OUT}"

echo "==> building the test harness with sourcemaps (output NOT *.js)"
# Build Main from inside tests/ (its own gren app); never name the output *.js
# or it will define the program without starting it (see PLAN.md).
devbox run -- bash -c "cd tests && gren make Main --sourcemaps --output=cov-app" >/dev/null 2>&1

echo "==> running the harness under V8 coverage"
rm -rf "${COVDIR}" && mkdir -p "${COVDIR}"
# Show the test results (this is still a test run) but don't abort on failure —
# coverage of a partial run is worth reporting, just flag that it happened.
test_rc=0
( cd tests && NODE_V8_COVERAGE="${COVDIR}" node cov-app ) || test_rc=$?
if [ "${test_rc}" -ne 0 ]; then
  echo "!! tests exited ${test_rc} — coverage below reflects a failing/partial run"
fi

echo "==> joining"
# `join` indexes ${ROOT} (the denominator) itself, then shells out to
# gren-coverage.js (the one irreducibly-JS step) for the sourcemap/V8 decode.
# Absolute --src keeps the report's file paths clean (no ..). Its stdout summary
# is suppressed here; the "wrote ..." note goes to stderr.
gren-coverage-node join \
  --app "${ROOT}/tests/cov-app" \
  --cov "${COVDIR}" \
  --src "${ROOT}" \
  --out "${OUT}/coverage.json" >/dev/null

echo "==> rendering lcov -> ${OUT}/coverage.lcov"
gren-coverage-node render lcov "${OUT}/coverage.json" > "${OUT}/coverage.lcov"

if command -v genhtml >/dev/null; then
  echo "==> genhtml -> ${OUT}/html/index.html"
  genhtml "${OUT}/coverage.lcov" -o "${OUT}/html" --branch-coverage >/dev/null
else
  echo "==> genhtml not found on PATH — skipping HTML report (install the lcov package for one)"
fi

# Terminal report (the four-state view).
gren-coverage-node render text "${OUT}/coverage.json"

# Propagate the test result so CI still fails on a failing suite.
exit "${test_rc}"
