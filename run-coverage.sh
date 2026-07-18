#!/bin/bash
#
# End-to-end coverage for the initial target: the gren-format-lib test harness.
#   entry point : gren-format-lib/tests/Main   (NOT the CLI — different DCE)
#   denominator : gren-format-lib/src/**
#
# Builds a sourcemapped test app, runs it under V8 coverage, and joins the V8
# data against a fresh index of gren-format-lib's sources into coverage.json
# (`join` indexes the --src project itself). Writes intermediates under out/.
#
# Usage:  ./run-coverage.sh

set -e

THIS_DIR=$(dirname "$(realpath "$0")")
LIB=$(realpath "${THIS_DIR}/../gren-format-lib")   # clean absolute path (no ..) for report SF/file
OUT="${THIS_DIR}/out"
COVDIR="${OUT}/v8cov"

mkdir -p "${OUT}"

echo "==> building the gren-coverage app"
(cd "${THIS_DIR}" && ./build.sh >/dev/null)

echo "==> building the test harness with sourcemaps (output NOT *.js)"
# Build Main from inside tests/ (its own gren app); never name the output *.js
# or it will define the program without starting it (see PLAN.md).
(cd "${LIB}" && devbox run -- bash -c "cd tests && gren make Main --sourcemaps --output=cov-app" >/dev/null 2>&1)

echo "==> running the harness under V8 coverage"
rm -rf "${COVDIR}" && mkdir -p "${COVDIR}"
# Show the test results (this is still a test run) but don't abort on failure —
# coverage of a partial run is worth reporting, just flag that it happened.
test_rc=0
( cd "${LIB}/tests" && NODE_V8_COVERAGE="${COVDIR}" node cov-app ) || test_rc=$?
if [ "${test_rc}" -ne 0 ]; then
  echo "!! tests exited ${test_rc} — coverage below reflects a failing/partial run"
fi

echo "==> joining"
# `join` indexes ${LIB} (the denominator) itself, then shells out to
# gren-coverage.js (the one irreducibly-JS step) for the sourcemap/V8 decode.
# Absolute --src keeps the report's file paths clean (no ..). Its stdout summary
# is suppressed here; the "wrote ..." note goes to stderr.
node "${THIS_DIR}/app" join \
  --app "${LIB}/tests/cov-app" \
  --cov "${COVDIR}" \
  --src "${LIB}" \
  --out "${OUT}/coverage.json" >/dev/null

echo "==> rendering lcov -> ${OUT}/coverage.lcov"
node "${THIS_DIR}/app" render lcov "${OUT}/coverage.json" > "${OUT}/coverage.lcov"

# Terminal report (the four-state view). genhtml the lcov for a browsable one:
#   genhtml out/coverage.lcov -o out/html --branch-coverage
node "${THIS_DIR}/app" render text "${OUT}/coverage.json"

# Propagate the test result so CI still fails on a failing suite.
exit "${test_rc}"
