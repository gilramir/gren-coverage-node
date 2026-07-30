# Deploying `gren-coverage` to npm

The built `app` is a self-contained `#!/usr/bin/env node` script. `package.json`
exposes it as the `gren-coverage` command via `"bin"`, and restricts the
published contents to `app` + `gren-coverage.js` via `"files"`. No JS wrapper
is needed — `join`'s lookup of `gren-coverage.js` (as a sibling of the running
binary) survives npm's `node_modules/.bin` symlinking, because Node resolves
`module.filename` to the symlink's real path.

## Build

```bash
./build.sh   # devbox run build; produces ./app, chmod +x'd
```

## Test the packaged tarball locally

Always test from the actual tarball, not `npm link` — `npm link` symlinks your
working directory straight into the global `node_modules`, which won't catch
packaging bugs like a wrong `"files"` entry silently dropping
`gren-coverage.js`.

```bash
npm pack                                     # packs exactly what `npm publish` would ship
                                              # -> gren-coverage-<version>.tgz
npm install -g ./gren-coverage-<version>.tgz # install the tarball globally
gren-coverage --help                         # now on PATH
```

Exercise a real `join` (the command that shells out to `gren-coverage.js`)
against another project's sourcemapped build + V8 coverage dir, same as
`run-coverage.sh` does, e.g.:

```bash
gren-coverage join --app <sourcemapped-app> --cov <v8-coverage-dir> --src <project-root> --out coverage.json
gren-coverage render text coverage.json
```

When done testing:

```bash
npm uninstall -g gren-coverage
```

## Publish

```bash
npm version <patch|minor|major>   # bumps package.json, creates a git tag
npm publish
git push --follow-tags
```
