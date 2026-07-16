#!/bin/bash

# Emit ast-index.json (the coverage denominator) for the given Gren source files.
#   ast-index.sh src/Foo.gren src/Bar.gren > ast-index.json

THIS_DIR=$(dirname $(realpath $0))

node "${THIS_DIR}"/ast-index-app "$@"
