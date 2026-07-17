# gren-coverage-node

Line-, function-, and branch-level **code coverage for Gren applications** that
target the `node` platform.

The goal is a report that answers *"where are my tests missing coverage?"* — the
functions and branches that are reachable but no fixture exercises — rather than
a single percentage badge.

## What it measures: four states

Every function and every `when` / `if` branch in your source is classified into
one of four states. The distinction is the whole point of the tool:

| state | meaning |
|-------|---------|
| **hit** | executed at least once |
| **never-called** | present in the compiled JS, but ran 0 times — *these are the fixtures to write* |
| **eliminated** | removed by dead-code elimination (never emitted to JS at all) |
| **absent** | the module never reached the source map |

A sourcemap-only tool would silently drop `eliminated` code from the
denominator, hiding it. Joining against the parsed AST keeps it visible.

## Quick start

The end-to-end pipeline is wired for one target: the `gren-format-lib` test
harness (entry point `gren-format-lib/tests/Main`, denominator
`gren-format-lib/src/**`).

```bash
./run-coverage.sh
```

This builds everything, runs the test harness under coverage, and prints the
terminal report. Intermediates land in `out/`:

- `out/ast-index.json` — every function/branch region in the source (the denominator)
- `out/coverage.json` — the four-state classification (the source of truth)
- `out/coverage.lcov` — an LCOV tracefile

For a browsable HTML report:

```bash
genhtml out/coverage.lcov -o out/html --branch-coverage
```

You can also run it through the formatter's test runner, which just execs the
script above:

```bash
cd ../gren-format-lib/tests && ./run-tests.sh --coverage
```

## The CLI

The tool is a single Gren app. Build it once, then invoke subcommands with
`node app` (in its own `--help` output it calls itself `gren-coverage`):

```bash
./build.sh                 # produces ./app
node app --help
```

| subcommand | what it does |
|------------|--------------|
| `node app index <files…>` | parse sources, emit `ast-index.json` (the denominator) to stdout |
| `node app join --app <cov-app> --cov <v8dir> --index <ast-index.json> [--out <file>]` | decode the sourcemap + V8 counts and classify every region into `coverage.json` |
| `node app render text <coverage.json> [--top N] [--all] [--module <Name>]` | human-readable report; `--module` prints one module's full annotated `count \| source` |
| `node app render lcov <coverage.json>` | standard LCOV tracefile to stdout (for `genhtml` / editor gutters) |

`render text` colorizes on a TTY and honours [`NO_COLOR`](https://no-color.org).

## How it works

Gren compiles to JavaScript, and `gren make --sourcemaps` emits a v3 source map
alongside it. Node's built-in V8 coverage (`NODE_V8_COVERAGE=dir`) records hit
counts against byte ranges of that JavaScript. The pipeline composes them:

```
        source .gren ──[index]──► ast-index.json      (denominator: all regions)

  gren make --sourcemaps ──► cov-app + inline sourcemap
        NODE_V8_COVERAGE=dir node cov-app ──► V8 hit counts   (numerator)
                                                │
                          [join] ◄─────────────┴── ast-index.json
                    decode sourcemap, map V8 counts onto source
                    positions, classify each region → coverage.json
                                     │
                       ┌─────────────┴─────────────┐
                 [render text]                [render lcov]
```

Regions are kept as exclusive `(row, col)` positions and never rounded to whole
lines, so a `let`-bodied declaration whose end bleeds into the next line
contributes nothing where it shouldn't.

## Layout

```
run-coverage.sh          the wired end-to-end pipeline (build → index → join → render)
build.sh                 builds the CLI into ./app
gren.json / devbox.json  the Gren app (platform: node)
src/
  Main.gren              argparse wiring + subcommand dispatch
  Coverage/Schema.gren   the typed coverage.json contract (decoders)
  Coverage/Index.gren    `index` — the AST walk (via compiler-common)
  Command/Join.gren      `join` — thin wrapper that shells out to gren-coverage.js
  Command/RenderText.gren `render text`
  Command/RenderLcov.gren `render lcov`
gren-coverage.js         the join engine (stays JavaScript — see below)
```

## Why `gren-coverage.js` is still JavaScript

The `join` step decodes the inline v3 source map (base64 VLQ) and V8's coverage
model, which reports byte ranges as **UTF-16 code-unit offsets** into the
generated JS. Reimplementing that in Gren would mean matching V8's exact offset
semantics — a correctness hazard on any non-ASCII byte — for no user-visible
gain. So the `join` subcommand is a thin Gren wrapper (`Command/Join.gren`) that
runs `gren-coverage.js` (found next to `app`) and forwards its output. Every
other step is native Gren.

## Dependencies

- `gilramir/gren-argparse` — the CLI parser (currently a `local:` dependency
  until the `requiredFlag` release is published)
- `gren-lang/compiler-common` — the parser and AST the `index` step walks
