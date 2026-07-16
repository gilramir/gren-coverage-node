#!/usr/bin/env bash
# Build the standalone gren-coverage CLI into ./app (run with `node app <cmd>`).
set -e
cd "$(dirname "$0")"
devbox run build
