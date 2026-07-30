#!/usr/bin/env bash
# Build the standalone gren-coverage CLI into ./app (run with `node app <cmd>`
# or, since it's executable, `./app <cmd>`). Marked +x so it also works
# unmodified as an npm `bin` target (see package.json).
set -e
cd "$(dirname "$0")"
devbox run build
chmod +x app
