#!/usr/bin/env node
// render-terminal: human-readable coverage report from coverage.json.
//
//   node render-terminal.js coverage.json            # summary + worst modules
//   node render-terminal.js coverage.json --top 5    # more modules
//   node render-terminal.js coverage.json --module Formatter.Render.BinopLayout
//                                                     # full annotated source
//
// The headline number is not a percentage — it's "which functions and `when`
// branches are reachable but never exercised". Those are the fixtures to write.
const fs = require("fs");

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = (s) => paint("31", s);
const grn = (s) => paint("32", s);
const yel = (s) => paint("33", s);
const dim = (s) => paint("2", s);
const gray = (s) => paint("90", s);
const bold = (s) => paint("1", s);

function parseArgs(argv) {
  const opt = { top: 3 };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") opt.top = parseInt(argv[++i], 10);
    else if (a === "--module") opt.module = argv[++i];
    else if (a === "--all") opt.all = true;
    else pos.push(a);
  }
  opt.file = pos[0] || "coverage.json";
  return opt;
}

// Read a module's source, tolerating a path that no longer resolves.
function readSource(file) {
  try { return fs.readFileSync(file, "utf8").split("\n"); }
  catch { return null; }
}

const stateColor = {
  hit: grn,
  "never-called": red,
  eliminated: gray,
  absent: dim,
};

function gapCount(m) {
  return (
    m.functions.filter((f) => f.state === "never-called").length +
    m.branches.filter((b) => b.state === "never-called").length
  );
}

function pct(t) {
  const denom = t.total - t.absent - t.eliminated;
  return denom ? (100 * t.hit) / denom : 100;
}

function printSummary(cov) {
  const { functions: f, branches: b } = cov.summary;
  const line = (label, t) =>
    `${bold(label.padEnd(10))}` +
    `${grn(String(t.hit).padStart(5) + " hit")}  ` +
    `${red(String(t["never-called"]).padStart(4) + " never")}  ` +
    `${gray(String(t.eliminated).padStart(4) + " elim")}  ` +
    `${dim(String(t.absent).padStart(4) + " absent")}  ` +
    `${String(t.total).padStart(5)} total   ` +
    `${bold(pct(t).toFixed(1).padStart(5) + "%")} of reachable`;
  console.log("\n" + bold("gren-coverage") + " — " + cov.app + "\n");
  console.log(line("functions", f));
  console.log(line("branches", b));
}

// The gap list for one module: every function that is never-called or
// eliminated, and every never-called branch, each with a source snippet.
function printModuleGaps(m, src) {
  const neverFns = m.functions.filter((f) => f.state === "never-called");
  const elimFns = m.functions.filter((f) => f.state === "eliminated");
  const neverBrs = m.branches.filter((b) => b.state === "never-called");

  console.log("\n" + bold(m.module) + dim("  " + m.file));
  console.log(
    dim("  functions ") +
      `${grn(m.functions.filter((f) => f.state === "hit").length + " hit")} ` +
      `${red(neverFns.length + " never")} ${gray(elimFns.length + " elim")}` +
      dim("   branches ") +
      `${grn(m.branches.filter((b) => b.state === "hit").length + " hit")} ` +
      `${red(neverBrs.length + " never")}`
  );

  const snippet = (row) =>
    src && src[row - 1] !== undefined ? src[row - 1].trim().slice(0, 76) : "";

  // Cap each list so a big dispatch module (hundreds of branches) stays readable;
  // the full detail is one `--module <Name>` away.
  const CAP = 12;
  const capped = (arr, render) => {
    for (const x of arr.slice(0, CAP)) render(x);
    if (arr.length > CAP) console.log(dim(`         … ${arr.length - CAP} more (see --module ${m.module})`));
  };

  capped(neverFns, (f) =>
    console.log(
      "  " + red("never  ") + bold((f.kind + " " + f.name).padEnd(34)) +
        dim(`:${f.start.row}`) +
        (src ? "  " + dim(snippet(f.start.row)) : "")
    ));
  capped(elimFns, (f) =>
    console.log("  " + gray("elim   ") + gray((f.kind + " " + f.name).padEnd(34)) + dim("(removed by DCE)")));
  capped(neverBrs, (b) =>
    console.log(
      "  " + red("never  ") + `when ${bold(b.pattern)} ` + dim(`in ${b.owner}`) + dim(`  :${b.start.row}`)
    ));
}

// Full annotated source for one module: count | source, uncovered lines red.
function printAnnotated(m, src) {
  console.log("\n" + bold(m.module) + dim("  " + m.file) + "\n");
  if (!src) { console.log(dim("  (source unavailable at " + m.file + ")")); return; }

  const count = new Map(m.lines.map((l) => [l.line, l.count]));
  // Lines inside an eliminated function region: dead code, mark 'x'.
  const dead = new Set();
  for (const f of m.functions)
    if (f.state === "eliminated")
      for (let r = f.start.row; r <= f.end.row; r++) dead.add(r);

  const w = Math.max(3, ...m.lines.map((l) => String(l.count).length));
  for (let i = 0; i < src.length; i++) {
    const row = i + 1;
    let gutter;
    if (count.has(row)) {
      const c = count.get(row);
      gutter = c > 0 ? grn(String(c).padStart(w)) : red("0".padStart(w));
    } else if (dead.has(row)) {
      gutter = gray("x".padStart(w));
    } else {
      gutter = " ".repeat(w);
    }
    const text = count.get(row) === 0 ? red(src[i]) : dead.has(row) ? gray(src[i]) : src[i];
    console.log(`${dim(String(row).padStart(5))} ${gutter} ${dim("|")} ${text}`);
  }
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cov = JSON.parse(fs.readFileSync(opt.file, "utf8"));

  printSummary(cov);

  if (opt.module) {
    const m = cov.modules.find((x) => x.module === opt.module);
    if (!m) { console.error("no such module: " + opt.module); process.exit(1); }
    printAnnotated(m, readSource(m.file));
    return;
  }

  const ranked = cov.modules
    .filter((m) => gapCount(m) > 0)
    .sort((a, b) => gapCount(b) - gapCount(a));

  if (!ranked.length) { console.log("\n" + grn("No never-called functions or branches. 🎉")); return; }

  console.log(
    "\n" + bold("Untested code — reachable but no fixture exercises it:") +
      dim(`  (${ranked.length} modules with gaps)`)
  );
  const show = opt.all ? ranked : ranked.slice(0, opt.top);
  for (const m of show) printModuleGaps(m, readSource(m.file));
  if (!opt.all && ranked.length > show.length)
    console.log(dim(`\n  … ${ranked.length - show.length} more modules with gaps (use --all or --top N)`));
  console.log(dim(`\n  annotate one module fully:  node render-terminal.js ${opt.file} --module <Name>`));
}

main();
