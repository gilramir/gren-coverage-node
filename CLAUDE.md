# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`gren-coverage-node` — a standalone CLI that reports code coverage (line,
function, and `when`/`if` branch) for Gren `node` applications. It joins
Node's V8 coverage output against a Gren `--sourcemaps` build and the parsed
Gren source, classifying every function/branch as **hit** / **never-called** /
**eliminated** / **absent**. See `README.md` for the full pipeline explanation
and worked example.

## Build & run

```bash
./build.sh                # devbox run build; produces ./app
node app --help
```

`app` is a `platform: node` Gren application (`gren.json`); build/test only via
devbox from inside this directory.

## Layout

- `src/Main.gren` — CLI wiring/dispatch
- `src/Coverage/Schema.gren` — `coverage.json` decoders
- `src/Coverage/Index.gren` — walks parsed source to build the denominator
  (every function/branch that exists)
- `src/Command/Join.gren` — `join`: builds the index, shells out to
  `gren-coverage.js` for the sourcemap/V8-coverage decode
- `src/Command/RenderText.gren`, `src/Command/RenderLcov.gren` — the two
  `render` subcommands
- `gren-coverage.js` — the one step kept in JavaScript (base64 VLQ sourcemap
  decode + V8's UTF-16-offset coverage format); **must sit next to the built
  `app`**, `join` looks for it alongside the running program

## Gotchas

- Never build the sourcemapped target app with `--output=*.js` — a `.js`
  output defines the program without starting it, so nothing runs and
  coverage is silently empty. Use any other output name (`run-coverage.sh`
  uses `cov-app`).
- Coverage regions are tracked by exact `(row, column)`, not rounded to whole
  lines — don't assume a hit region covers its entire source line.
