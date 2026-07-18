# gren-coverage-node

Code coverage for **Gren applications that run on Node**. It reports coverage at
three levels of detail — per line, per function, and per `when` / `if` branch.

Instead of a single percentage, the goal is to answer a more useful question:
**"where are my tests missing?"** — which functions and branches your code can
reach but no test actually runs. Those are the tests you still need to write.

This tool works with **any** Gren `node` project. The examples below use the
`gren-format-lib` test suite because that is what it was first built against, but
nothing here is specific to it — point it at your own sources and your own app.

## What it measures: four states

Every function and every `when` / `if` branch in your source is put into one of
four states. Telling them apart is the whole point of the tool:

| state | meaning |
|-------|---------|
| **hit** | ran at least once |
| **never-called** | present in the compiled JavaScript, but ran 0 times — *these are the tests to write* |
| **eliminated** | dropped by dead-code elimination (never compiled into JavaScript at all) |
| **absent** | the module never showed up in the source map |

A tool that only looked at the source map would quietly leave **eliminated**
code out of the totals, hiding it. This tool also reads your parsed source, so
eliminated code stays visible in the report.

## How coverage works, in short

Gren compiles to JavaScript. When you build with `gren make --sourcemaps`, it
also writes a **source map** that says which JavaScript came from which line of
your Gren source. Node has coverage built in: set `NODE_V8_COVERAGE=<dir>` and
it records how many times each piece of the JavaScript ran.

This tool combines the two: it takes the run counts from Node, follows the
source map back to your Gren code, and compares that against every function and
branch in your source (which it finds by reading your project). The result is the
four-state report above.

```
  gren make --sourcemaps ──► app + source map
     NODE_V8_COVERAGE=dir node app ──► run counts   (what actually ran)
                                             │
       your gren.json ───────────► [ join ] ◄┘
             read every function/branch (the total), follow the
             source map, match run counts to your source, and
             label each region → coverage.json
                                  │
                    ┌─────────────┴─────────────┐
              [ render text ]             [ render lcov ]
```

## Install

You need [devbox](https://www.jetify.com/devbox) (it pins Node and the Gren
compiler for you). Build the tool once:

```bash
./build.sh          # produces ./app, run with: node app <command>
node app --help
```

`app` is a normal Node program. From here on, `node app` is the coverage tool.

## Using it in your project

There are four steps. You can run them by hand once to understand them, then wrap
them in a script (see the full example at the end).

Assume your project has an entry-point module called `Main` (for a test suite,
that is usually your test runner's `Main`).

### 1. Build your app with a source map

Compile the app you want to measure, asking for a source map. **Do not name the
output `*.js`** — a `.js` output builds a module that defines your program but
never starts it, so nothing runs. Use any other name (here, `cov-app`):

```bash
gren make Main --sourcemaps --output=cov-app
```

For a test suite, `Main` is your test harness's entry point. The source map is
embedded in `cov-app`, so there is nothing extra to keep track of.

### 2. Run it under Node's coverage

Run the app you just built with `NODE_V8_COVERAGE` pointing at an empty
directory. Node writes raw coverage data there:

```bash
rm -rf v8cov && mkdir v8cov
NODE_V8_COVERAGE=v8cov node cov-app
```

This is a normal run of your app or test suite — let it do whatever it normally
does. When it finishes, `v8cov/` holds the run counts.

### 3. Join it into a coverage report

Combine the run counts and the source map with your project's sources:

```bash
node /path/to/app join \
  --app cov-app \
  --cov v8cov \
  --out coverage.json
```

`join` finds your `gren.json` (in the current directory, or walking up from it),
reads its `source-directories`, and indexes every function and branch itself —
so you don't have to list your sources. If you run `join` from outside your
project, point it at the project root with `--src <dir>`.

`coverage.json` is the source of truth — the four-state label for every region.

### 4. Render the report

Print a human-readable report to the terminal:

```bash
node /path/to/app render text coverage.json
```

Or produce a standard **LCOV** file, which editors and `genhtml` understand:

```bash
node /path/to/app render lcov coverage.json > coverage.lcov
genhtml coverage.lcov -o html --branch-coverage    # browsable HTML report
```

## Commands

`node app <command>`:

| command | what it does |
|---------|--------------|
| `join --app <app> --cov <v8dir> [--src <dir>] [--out <file>]` | index your sources, then combine them with the run counts + source map into `coverage.json` |
| `render text <coverage.json> [--top N] [--all] [--module <Name>]` | terminal report; `--module` prints one module's full source annotated with run counts |
| `render lcov <coverage.json>` | print a standard LCOV file (for `genhtml` or editor gutters) |

`render text` adds color on a terminal and respects
[`NO_COLOR`](https://no-color.org).

One detail worth knowing: regions are tracked by exact `(row, column)`, never
rounded to whole lines. So a declaration whose last line spills over onto the
next line doesn't wrongly mark that next line as covered.

## A complete example

`gren-format-lib` wraps all the steps in one script,
[`run-coverage.sh`](./run-coverage.sh). It is a good template to copy. The core
of it is:

```bash
# 1. build the test harness with a source map (output is NOT *.js)
( cd "$LIB/tests" && gren make Main --sourcemaps --output=cov-app )

# 2. run the tests under Node coverage
rm -rf v8cov && mkdir v8cov
( cd "$LIB/tests" && NODE_V8_COVERAGE=v8cov node cov-app )

# 3. join — index the library (--src) and combine with the run counts
node app join --app "$LIB/tests/cov-app" --cov v8cov \
  --src "$LIB" --out out/coverage.json

# 4. render both a terminal report and an lcov file
node app render lcov out/coverage.json > out/coverage.lcov
node app render text out/coverage.json
```

That project also lets you trigger the whole thing from its own test runner —
`run-tests.sh --coverage` simply execs `run-coverage.sh`. That is a convenience
of *that* project's setup, not a requirement; your project can wire it in
however you like.

## Layout

```
build.sh                 builds the CLI into ./app
run-coverage.sh          the full worked example (build → run → join → render)
gren.json / devbox.json  the Gren app (platform: node)
src/
  Main.gren              command-line wiring + dispatch
  Coverage/Schema.gren   the coverage.json data format (decoders)
  Coverage/Index.gren    discovers + walks your parsed source (the denominator)
  Command/Join.gren      `join` — builds the index, then wraps gren-coverage.js
  Command/RenderText.gren `render text`
  Command/RenderLcov.gren `render lcov`
gren-coverage.js         the join engine (stays JavaScript — see below)
```

## Why the join step is JavaScript

Part of the `join` step decodes the source map (base64 VLQ) and Node's coverage
data, which reports positions as **UTF-16 code-unit offsets** into the generated
JavaScript. Redoing that in Gren would mean re-matching Node's exact offset rules
— easy to get wrong on any non-ASCII character, for no benefit to you. So that
decode stays in `gren-coverage.js`. The Gren `join` command (`Command/Join.gren`)
does the rest natively: it indexes your sources, then runs `gren-coverage.js`
(kept next to `app`) for the decode and passes its output along. Everything else
is native Gren too.

## Dependencies

- `gilramir/gren-argparse` — the command-line parser (currently a `local:`
  dependency until the `requiredFlag` release is published)
- `gren-lang/compiler-common` — the parser and syntax tree used to index your sources
- `gren-lang/compiler-node` — locating `gren.json` and enumerating a project's
  source files, so `join` can discover and index them itself
