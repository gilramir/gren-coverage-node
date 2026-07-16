#!/usr/bin/env node
// gren-coverage: map V8 coverage of a compiled Gren node app back to Gren source lines.
//   node gren-coverage.js <app.js> <v8-coverage-dir> [--filter=Prefix] [--list]
//
// STATUS: validated prototype, step 2 of PLAN.md — not the finished tool.
// It covers the source-map half only: the denominator is the set of lines the
// compiler emitted mapped code for, so functions removed by dead code
// elimination are invisible here rather than reported as uncovered. Recovering
// those needs the AST join (steps 1 and 3). See PLAN.md.
const fs = require("fs");
const path = require("path");

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

function readMap(jsPath) {
  const js = fs.readFileSync(jsPath, "utf8");
  const m = js.match(/sourceMappingURL=data:application\/json;(?:charset=[^;]+;)?base64,([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error("no inline sourcemap in " + jsPath + " (compile with --sourcemaps)");
  return { js, map: JSON.parse(Buffer.from(m[1], "base64").toString()) };
}

// generated line/col -> absolute offset
function lineStarts(js) {
  const starts = [0];
  for (let i = 0; i < js.length; i++) if (js[i] === "\n") starts.push(i + 1);
  return starts;
}

function parseSegments(map) {
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
        segs.push({ genLine, genCol, srcIdx, srcLine: srcLine + 1 });
      }
    }
  }
  return segs;
}

// Merge every V8 coverage JSON in dir for the given script url substring.
function loadRanges(covDir, jsBase) {
  const all = [];
  for (const f of fs.readdirSync(covDir)) {
    if (!f.endsWith(".json")) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(covDir, f), "utf8")); } catch { continue; }
    for (const script of (j.result || [])) {
      if (!script.url.includes(jsBase)) continue;
      for (const fn of script.functions)
        for (const r of fn.ranges) all.push(r);
    }
  }
  return all;
}

// innermost-range lookup: sort by width desc so later (narrower) writes win.
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

function main() {
  const [jsPath, covDir] = process.argv.slice(2).filter(a => !a.startsWith("--"));
  const args = process.argv.filter(a => a.startsWith("--"));
  const filter = (args.find(a => a.startsWith("--filter=")) || "").split("=")[1];
  const list = args.includes("--list");

  const { js, map } = readMap(jsPath);
  const starts = lineStarts(js);
  const segs = parseSegments(map);
  const ranges = loadRanges(covDir, path.basename(jsPath));
  if (!ranges.length) { console.error("no coverage ranges found for " + path.basename(jsPath)); process.exit(1); }
  const countAt = buildCountLookup(ranges);

  // srcIdx -> Map(srcLine -> hits)
  const hits = new Map();
  for (const s of segs) {
    if (filter && !map.sources[s.srcIdx].startsWith(filter)) continue;
    const off = starts[s.genLine] + s.genCol;
    const c = countAt(off);
    if (c === null) continue;
    if (!hits.has(s.srcIdx)) hits.set(s.srcIdx, new Map());
    const m = hits.get(s.srcIdx);
    m.set(s.srcLine, Math.max(m.get(s.srcLine) || 0, c));
  }

  const rows = [];
  for (const [idx, lineMap] of hits) {
    const covered = [...lineMap.values()].filter(c => c > 0).length;
    const total = lineMap.size;
    rows.push({ name: map.sources[idx], covered, total,
                pct: total ? (100 * covered / total) : 100,
                missing: [...lineMap.entries()].filter(([, c]) => c === 0).map(([l]) => l).sort((a, b) => a - b),
                content: map.sourcesContent[idx] });
  }
  rows.sort((a, b) => a.pct - b.pct);

  let tc = 0, tt = 0;
  console.log("Gren line coverage (executable lines only)\n");
  console.log("module".padEnd(42) + "cov/exec".padStart(11) + "     pct");
  console.log("-".repeat(64));
  for (const r of rows) {
    tc += r.covered; tt += r.total;
    console.log(r.name.padEnd(42) + `${r.covered}/${r.total}`.padStart(11) + `  ${r.pct.toFixed(1).padStart(6)}%`);
  }
  console.log("-".repeat(64));
  console.log("TOTAL".padEnd(42) + `${tc}/${tt}`.padStart(11) + `  ${(100 * tc / tt).toFixed(1).padStart(6)}%`);

  if (list) for (const r of rows) {
    if (!r.missing.length) continue;
    console.log(`\n=== ${r.name}: ${r.missing.length} uncovered lines`);
    const src = r.content.split("\n");
    for (const l of r.missing.slice(0, 12))
      console.log(String(l).padStart(5) + " | " + (src[l - 1] || "").trim().slice(0, 78));
    if (r.missing.length > 12) console.log(`      ... ${r.missing.length - 12} more`);
  }
}
main();
