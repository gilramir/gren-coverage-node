#!/usr/bin/env node
// gren-coverage: join V8 coverage of a compiled Gren node app against the AST
// index to classify every function and `when` branch into one of four states.
//
//   node gren-coverage.js --app <cov-app> --cov <v8-dir> --index <ast-index.json>
//                         [--out coverage.json]
//
// The AST index (from ast-index/) is the denominator: it lists every function
// and branch region that exists in the *source*. The source map + V8 coverage
// are the numerator: they say which of those regions actually emitted JS and
// how often it ran. Joining the two is what makes DCE'd code visible as
// "eliminated" instead of silently vanishing from the denominator.
//
// Four states per region (see PLAN.md):
//   hit          some mapped position in the region ran (count > 0)
//   never-called region has mapped positions, all count 0 (reachable, untested)
//   eliminated   module is in the source map but the region has no mapped
//                positions — dead-code-eliminated from this entry point
//   absent       module never appears in the source map at all
const fs = require("fs");
const path = require("path");

// --- source map / V8 decoding -------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeVLQ(str) {
  const out = []; let i = 0;
  while (i < str.length) {
    let result = 0, shift = 0, cont, digit;
    do {
      digit = B64.indexOf(str[i++]);
      cont = digit & 32; digit &= 31;
      result += digit << shift; shift += 5;
    } while (cont);
    const neg = result & 1; result >>= 1;
    out.push(neg ? -result : result);
  }
  return out;
}

function readMap(appPath) {
  const js = fs.readFileSync(appPath, "utf8");
  const m = js.match(/sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error("no inline sourcemap in " + appPath + " (compile with --sourcemaps)");
  return { js, map: JSON.parse(Buffer.from(m[1], "base64").toString()) };
}

// generated line -> absolute (UTF-16) offset of that line's first char
function lineStarts(js) {
  const starts = [0];
  for (let i = 0; i < js.length; i++) if (js[i] === "\n") starts.push(i + 1);
  return starts;
}

// Decode every mapping segment, carrying source (module, row, col) in Gren's
// 1-based coordinates plus the absolute generated offset for count lookup.
function parseSegments(map, starts) {
  const segs = [];
  let srcIdx = 0, srcLine = 0, srcCol = 0, nameIdx = 0;
  const lines = map.mappings.split(";");
  for (let genLine = 0; genLine < lines.length; genLine++) {
    let genCol = 0;
    if (!lines[genLine].length) continue;
    for (const s of lines[genLine].split(",")) {
      if (!s.length) continue;
      const f = decodeVLQ(s);
      genCol += f[0];
      if (f.length >= 4) {
        srcIdx += f[1]; srcLine += f[2]; srcCol += f[3];
        if (f.length >= 5) nameIdx += f[4];
        segs.push({
          srcIdx,
          row: srcLine + 1,   // Gren rows are 1-based
          col: srcCol + 1,    // Gren cols are 1-based
          genOffset: starts[genLine] + genCol,
        });
      }
    }
  }
  return segs;
}

// Merge every V8 coverage JSON in dir for the given script url substring.
function loadRanges(covDir, appBase) {
  const all = [];
  for (const f of fs.readdirSync(covDir)) {
    if (!f.endsWith(".json")) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(covDir, f), "utf8")); } catch { continue; }
    for (const script of (j.result || [])) {
      if (!script.url.includes(appBase)) continue;
      for (const fn of script.functions)
        for (const r of fn.ranges) all.push(r);
    }
  }
  return all;
}

// innermost-range lookup: narrowest enclosing range wins, so an uncalled inner
// closure (count 0) is not masked by its covered parent's range.
function buildCountLookup(ranges) {
  const sorted = ranges.slice().sort(
    (a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
  return function countAt(off) {
    let best = null, bestWidth = Infinity;
    for (const r of sorted) {
      if (off >= r.startOffset && off < r.endOffset) {
        const w = r.endOffset - r.startOffset;
        if (w <= bestWidth) { bestWidth = w; best = r; }
      }
    }
    return best === null ? null : best.count;
  };
}

// --- the join ------------------------------------------------------------

function cmpPos(a, b) { return a.row - b.row || a.col - b.col; }

// A region owns a segment when start <= seg < end, comparing (row, col) as
// exclusive positions (never rounded to lines — see compiler-common#13).
function inRegion(seg, start, end) {
  return cmpPos(seg, start) >= 0 && cmpPos(seg, end) < 0;
}

// Group segments by their source module name, each sorted by position so a
// region's segments form a contiguous slice we can binary-search.
function segmentsByModule(segs, sources) {
  const byModule = new Map();
  for (const s of segs) {
    const mod = sources[s.srcIdx];
    let arr = byModule.get(mod);
    if (!arr) { arr = []; byModule.set(mod, arr); }
    arr.push(s);
  }
  for (const arr of byModule.values()) arr.sort(cmpPos);
  return byModule;
}

// First index into a position-sorted array whose element is >= start.
function lowerBound(arr, start) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmpPos(arr[mid], start) < 0) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Classify one region against its module's segments and the V8 counts.
//   inSourceMap false -> "absent"
//   no segments in region -> "eliminated"
//   else max count over the region: >0 -> "hit", 0 -> "never-called"
function classifyRegion(region, modSegs, countAt) {
  if (modSegs === undefined) return { state: "absent", count: null, mapped: 0 };

  let maxCount = null, mapped = 0;
  for (let i = lowerBound(modSegs, region.start); i < modSegs.length; i++) {
    const seg = modSegs[i];
    if (cmpPos(seg, region.end) >= 0) break; // sorted: past the region
    mapped++;
    const c = countAt(seg.genOffset);
    if (c !== null) maxCount = maxCount === null ? c : Math.max(maxCount, c);
  }

  if (mapped === 0) return { state: "eliminated", count: null, mapped: 0 };
  const count = maxCount === null ? 0 : maxCount;
  return { state: count > 0 ? "hit" : "never-called", count, mapped };
}

function emptyTally() {
  return { hit: 0, "never-called": 0, eliminated: 0, absent: 0, total: 0 };
}
function tally(t, state) { t[state]++; t.total++; }

// Per-line hit counts for one module: the max innermost count over every
// segment on that source line. These are the executable lines (a line with no
// mapped segment emitted no code) and feed the annotated view + lcov DA records.
function lineCounts(modSegs, countAt) {
  const m = new Map();
  for (const seg of modSegs) {
    const c = countAt(seg.genOffset);
    if (c === null) continue;
    const prev = m.get(seg.row);
    m.set(seg.row, prev === undefined ? c : Math.max(prev, c));
  }
  return [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, count]) => ({ line, count }));
}

// --- CLI -----------------------------------------------------------------

function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--app") opt.app = argv[++i];
    else if (a === "--cov") opt.cov = argv[++i];
    else if (a === "--index") opt.index = argv[++i];
    else if (a === "--out") opt.out = argv[++i];
    else throw new Error("unknown argument: " + a);
  }
  for (const k of ["app", "cov", "index"])
    if (!opt[k]) throw new Error("missing required --" + k);
  return opt;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));

  const index = JSON.parse(fs.readFileSync(opt.index, "utf8"));
  const { js, map } = readMap(opt.app);
  const starts = lineStarts(js);
  const segs = parseSegments(map, starts);
  const ranges = loadRanges(opt.cov, path.basename(opt.app));
  if (!ranges.length) {
    console.error("no V8 coverage ranges found for " + path.basename(opt.app) + " in " + opt.cov);
    process.exit(1);
  }
  const countAt = buildCountLookup(ranges);
  const byModule = segmentsByModule(segs, map.sources);
  const inSourceMap = new Set(map.sources);

  const fnTally = emptyTally();
  const brTally = emptyTally();

  const modules = index.map((mod) => {
    const modSegs = byModule.get(mod.module);
    const present = inSourceMap.has(mod.module);

    const functions = mod.functions.map((fn) => {
      const r = classifyRegion(fn, present ? (modSegs || []) : undefined, countAt);
      tally(fnTally, r.state);
      return { ...fn, state: r.state, count: r.count, mapped: r.mapped };
    });
    const branches = mod.branches.map((br) => {
      const r = classifyRegion(br, present ? (modSegs || []) : undefined, countAt);
      tally(brTally, r.state);
      return { ...br, state: r.state, count: r.count, mapped: r.mapped };
    });

    const lines = present && modSegs ? lineCounts(modSegs, countAt) : [];

    return { module: mod.module, file: mod.file, inSourceMap: present, functions, branches, lines };
  });

  const coverage = {
    app: path.basename(opt.app),
    summary: { functions: fnTally, branches: brTally },
    modules,
  };

  if (opt.out) {
    fs.writeFileSync(opt.out, JSON.stringify(coverage, null, 2) + "\n");
    console.error("wrote " + opt.out);
  }

  printSummary(coverage);
}

function pct(t) {
  const denom = t.total - t.absent - t.eliminated;
  return denom ? (100 * t.hit / denom) : 100;
}

function printSummary(coverage) {
  const { functions: f, branches: b } = coverage.summary;
  const line = (label, t) =>
    `${label.padEnd(11)}` +
    `${String(t.hit).padStart(6)} hit ` +
    `${String(t["never-called"]).padStart(6)} never ` +
    `${String(t.eliminated).padStart(6)} elim ` +
    `${String(t.absent).padStart(6)} absent ` +
    `${String(t.total).padStart(6)} total ` +
    `  ${pct(t).toFixed(1).padStart(5)}% of reachable`;

  console.log("\ngren-coverage — four-state classification (" + coverage.app + ")\n");
  console.log(line("functions", f));
  console.log(line("branches", b));

  // Worst modules first: most never-called functions is the actionable signal.
  const rows = coverage.modules
    .map((m) => ({
      module: m.module,
      never: m.functions.filter((x) => x.state === "never-called").length,
      brNever: m.branches.filter((x) => x.state === "never-called").length,
      elim: m.functions.filter((x) => x.state === "eliminated").length,
    }))
    .filter((r) => r.never || r.brNever)
    .sort((a, b) => (b.never + b.brNever) - (a.never + a.brNever));

  if (rows.length) {
    console.log("\nmodules with untested (never-called) code — write fixtures here:\n");
    console.log("module".padEnd(46) + "fn-never  br-never  fn-elim");
    console.log("-".repeat(72));
    for (const r of rows.slice(0, 25))
      console.log(r.module.padEnd(46) +
        String(r.never).padStart(8) + String(r.brNever).padStart(10) + String(r.elim).padStart(9));
  }
}

main();
