# gren-coverage-node

A line-, function-, and branch-level code coverage tool for Gren applications
targeting the `node` platform.

The end goal is a report that answers "where are my test fixtures missing
coverage?" — not a percentage badge.

## How it works

Gren compiles to JavaScript, and `gren make --sourcemaps` emits a standard v3
source map alongside it. Node's built-in V8 coverage (`NODE_V8_COVERAGE=dir`)
records hit counts against byte ranges of that JavaScript. Composing the two
maps execution counts back onto Gren source positions.

Source maps alone can only describe code that survived to the JavaScript. So we
additionally parse the Gren source to an AST and use *that* as the denominator.
The join of the two is what makes the report meaningful.

### Verified before committing to this design

All four checks were run against the `gren-format` app (Gren 0.6.6):

1. `gren make --sourcemaps` emits a v3 inline base64 source map with
   `sourcesContent` embedded.
2. **The mappings are expression-level, not line-level** — 37,984 segments over
   89 modules, each carrying line *and* column on both sides. Spot-checked:
   `Array.popLast segBoxes` at `BinopLayout.gren:308:17` maps precisely to
   `$gren_lang$core$Array$popLast(segBoxes)` in the generated JS.
3. `NODE_V8_COVERAGE=dir node app.js` produces per-function byte ranges with
   counts, and merges cleanly across multiple runs (one JSON file per run).
4. **V8 reports never-called nested closures with `count: 0`** rather than
   omitting them. This one is load-bearing: Gren compiles every function to a
   nested closure, so had V8 stayed silent about uncalled ones, they would sit
   inside their covered parent's range and be scored as covered. It doesn't.

One wrinkle worth recording: the `sources` array holds **module names**
(`Formatter.Render.BinopLayout`), not file paths. This is why we do not use
`c8`/`v8-to-istanbul` off the shelf — they resolve `sources` as paths and would
look for a file literally named `Formatter.Render.BinopLayout`.

## Architecture

**Two components, one documented schema between them.** Each half is written in
the language that owns its problem:

- **`ast-index/`** — a Gren application (`platform: node`). Imports
  `compiler-common`, parses each source file to a typed `Src.Module`, walks it,
  and emits the index. This is the denominator.
- **`gren-coverage.js`** — Node. Decodes the source map, merges V8 coverage runs,
  resolves counts, joins against the index, renders. This is the numerator.

```
gren make Main --sourcemaps --output=app-cov.js
        │
        ├── app-cov.js + inline source map ──┐
        │                                     │
NODE_V8_COVERAGE=cov node app-cov.js <args>   │
        │                                     │
        └── cov/*.json (V8 ranges) ───────────┤
                                              ├──► join ──► coverage.json
ast-index src/**/*.gren                       │              │
        └── ast-index.json ───────────────────┘              ├──► terminal report
                                                             └──► lcov
```

### Why Gren for the index

The alternative was to call `gren-format --pre-ast` per file and walk its JSON
from Node. Rejected: that is stringly-typed poking at another tool's debug dump
(`v.value.value.name.value` for a declaration name, `imp.value.module_.value` for
an import), it breaks at runtime rather than at compile time when the AST shifts,
and it couples this repo to a debug flag across a repo boundary. Parsing directly
means the Gren compiler reports an AST change as a build error.

Note that a Gren program *reading `--pre-ast` JSON* would not have helped —
decoders fail at runtime too. Parsing directly is what buys the type safety.

Conversely, do not rewrite the coverage half in Gren: it would mean
reimplementing VLQ decoding and V8 JSON decoding for no gain.

### The schema

`ast-index.json` — an array of modules. This is **ours**, small and stable, and
the only contract between the two components:

```json
[
  {
    "module": "Formatter.Render.BinopLayout",
    "file": "src/Formatter/Render/BinopLayout.gren",
    "functions": [
      { "name": "inlineBinopBox",
        "kind": "toplevel",
        "start": { "row": 302, "col": 1 },
        "end":   { "row": 340, "col": 24 } }
    ],
    "branches": [
      { "owner": "inlineBinopBox",
        "kind": "when",
        "pattern": "Nothing",
        "start": { "row": 305, "col": 12 },
        "end":   { "row": 305, "col": 19 } }
    ]
  }
]
```

`kind` is `toplevel` or `let` for functions. Positions are **exclusive
`(row, col)` ends** — never rounded to whole lines (see #13 below).

### Dependencies for `ast-index/`

`gren-lang/compiler-common` (parser + AST types), `gren-lang/core`,
`gren-lang/node` (file IO). Deliberately **not** `gren-format-lib` — we emit our
own schema rather than reusing its AST JSON encoder — and **not**
`gren-lang/compiler-node`, since taking file paths as arguments avoids needing
project discovery.

The parse recipe, mirroring `gren-format/src/Format.gren:88`:

```gren
import Compiler.Ast.Source as Src
import Compiler.Parse.Context as Context
import Compiler.Parse.Module as PM
import String.Parser.Advanced as Parser

parser =
    Parser.succeed (\ast payload -> { ast = ast, payload = payload })
        |> Parser.keep PM.parser
        |> Parser.keep Parser.getPayload

Parser.run parser Context.empty source
```

The AST walk itself has precedent to copy: `gren-format-lib`'s
`Formatter/Logical/MakeLogical.gren` already walks `Src.Module` declaration by
declaration.

## The four-state classification

The join produces a state per function, which is the point of the exercise. A
percentage cannot distinguish these; only the AST-vs-sourcemap join can.

| state | condition | meaning |
|---|---|---|
| **hit** | some mapped position in the region has count > 0 | exercised |
| **never called** | region has mapped positions, all count 0 | reachable, but no fixture exercises it — *write a test* |
| **eliminated** | module is in the source map, region has no mapped positions | dead-code-eliminated; nothing statically reaches it from this entry point |
| **absent** | module never appears in source map `sources` | module never linked at all |

"Never called" and "eliminated" are different messages. Plain line coverage
conflates them, because eliminated code silently vanishes from the denominator
and thereby flatters the score.

Note that "eliminated" is relative to the entry point: DCE keeps whatever `main`
statically references, so a function only reachable from the CLI will read as
eliminated when measuring the test harness. That is information, not noise, but
the report must label it per-entry-point.

## Branch coverage is a headline feature, not an afterthought

The AST also carries `when`-branch regions. `gren-format` is one enormous
constructor dispatch — `makePBox` over every `LPBox`, `insertExpression` over
every `Src.Expr`. "Which `when` branches never fired" is a far more actionable
answer to "where are my fixture gaps" than "which lines never ran", and it falls
out of the same join with no extra machinery.

## Outputs

The join writes a `coverage.json` intermediate; renderers sit on top of it.

- **Terminal** — annotated source (`count | source-line`), worst modules first,
  plus function and branch summaries.
- **lcov** — because lcov's `FN`/`FNDA` records are exactly the per-function hit
  data we already compute, this gets VS Code gutter highlighting and `genhtml`
  for free. An output format, not a design constraint.

## Configuration for the initial target

- Entry point: `gren-format-lib/tests/Main` — *not* the CLI. Different entry
  point, different DCE result, different question.
- Denominator: `gren-format-lib/src/**`.
- Filter out `core` / `argparse` / other dependency modules.
- Build **without** `--optimize`.

## Known upstream caveats

**`compiler-common#13` — let-in end position includes trailing whitespace.**
A `let` expression's end position is the start of the next token after its body,
absorbing trailing whitespace (and any comments in it). The bad end propagates to
the enclosing declaration, so a `let`-bodied declaration's region can overlap the
following declaration.

*Impact: none, if handled correctly.* The absorbed span is whitespace and the end
lands at **column 1** of the next declaration's row. Treating regions as
exclusive `(row, col)` positions makes the bleed contribute zero. It is only
dangerous if regions are rounded to whole lines — a `let`-bodied function would
then swallow the next declaration's first line, which emits code whenever that
declaration has no type signature. **Never round regions to line granularity.**

**`compiler-common#25` — wrong start row for keyword-led declarations.**
`import`, `type`, `type alias`, and `port` report the row of the *name* rather
than the keyword, when a newline separates them. Affects region starts for
unions/aliases/ports. Low impact (the keyword line emits no code) but worth
knowing before trusting a union's region.

## Sequencing

- [ ] **0. Verify per-value DCE.** Build a module with an unreferenced function,
      check whether it appears in the source map. The **eliminated** state only
      exists if Elm-style per-value dead code elimination carried into Gren.
      This is assumed, not proven, and the classification depends on it.
- [x] **1. Coverage mapper** — VLQ decode, merge V8 runs, innermost-range count
      lookup, map to Gren positions. Prototyped and working end-to-end
      (`gren-coverage.js`).
- [ ] **2. AST index** — the `ast-index/` Gren app: parse each file via
      `compiler-common`, walk `Src.Module` for functions (top-level and
      `let`-bound) and `when` branches, emit `ast-index.json`. Regions must stay
      exclusive `(row, col)` — see #13 below.
- [ ] **3. The join + four-state classification.**
- [ ] **4. Renderers** — terminal, then lcov.
- [ ] **5. Wire into `run-tests.sh`** behind a flag.

## Implementation notes

### Tooling conventions

Gren work here goes through **devbox**, like the sibling packages. Each package
is its own devbox project: a `devbox.json` pinning `nodejs@22` and `gren@0.6`,
with the real commands under `shell.scripts` (`build`, `build_test`, `test`).
Never invoke a sibling-relative compiler wrapper — there is no top-level
`gren.sh`, and `compiler/` is frozen. The pinned `nodejs` is also what runs the
coverage tool itself, which keeps the V8 coverage format stable across machines.

Entry points are **small bash wrappers over `devbox run`**, matching the style
already used in `gren-format/` and `gren-format-lib/`. They stay thin — the
logic lives in `devbox.json`, not the script:

```bash
#!/bin/bash

set -e

devbox run build
```

For a script that invokes a built artifact, follow `gren-format/gren-format.sh`:
resolve the script's own directory and pass arguments straight through, so it
works from any working directory.

```bash
#!/bin/bash

THIS_DIR=$(dirname $(realpath $0))

node "${THIS_DIR}"/gren-coverage.js "$@"
```

### Details

- **Innermost-range lookup is required.** V8 reports a parent function's range as
  covering its nested closures textually. A naive "is this offset inside any
  count > 0 range" marks uncalled inner closures as covered. Resolve each offset
  to the *narrowest* enclosing range and use that range's count.
- V8 offsets index the source as a JS string (UTF-16 code units). Fine while the
  generated JS is ASCII; revisit if that stops being true.
- Coverage JSON accumulates one file per run in `NODE_V8_COVERAGE`, so merging
  is just "read every file in the directory".
