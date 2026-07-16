#!/usr/bin/env node
// render-lcov: emit a standard lcov tracefile from coverage.json.
//
//   node render-lcov.js coverage.json > coverage.lcov
//   genhtml coverage.lcov -o html --branch-coverage
//   lcov --summary coverage.lcov --rc branch_coverage=1
//
// lcov's DA / FN / FNDA / BRDA records are the per-line, per-function and
// per-branch hit data the join already computes, so this buys VS Code gutter
// highlighting and `genhtml` for free. It cannot express the four states —
// eliminated and never-called both read as "0 executions" here; the terminal
// report keeps that distinction. coverage.json remains the source of truth.
//
// Two lcov quirks handled below:
//   * lcov counts a branch block only when >= 2 alternatives share ONE line, so
//     all branches of a `when` are anchored at their shared `branchPoint` line
//     (the `when` keyword) rather than at each branch body's own line.
//   * lcov keys functions by name within a file, so duplicate `let` names (many
//     `inner`/`go`/`loop` helpers) would collapse; we disambiguate with @row.
const fs = require("fs");

// lcov testnames may only contain word characters.
const sanitizeTN = (s) => s.replace(/[^\w]/g, "_");

// Give every function a name unique within its module (append @row to any name
// that repeats), so FN/FNDA correlate and the totals don't undercount.
function uniqueNames(functions) {
  const seen = new Map();
  for (const f of functions) seen.set(f.name, (seen.get(f.name) || 0) + 1);
  const dup = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  return functions.map((f) => (dup.has(f.name) ? `${f.name}@${f.start.row}` : f.name));
}

function main() {
  const file = process.argv[2] || "coverage.json";
  const cov = JSON.parse(fs.readFileSync(file, "utf8"));
  const tn = sanitizeTN(cov.app);
  const out = [];

  for (const m of cov.modules) {
    out.push("TN:" + tn);
    out.push("SF:" + m.file);

    // Functions.
    const names = uniqueNames(m.functions);
    let fnHit = 0;
    m.functions.forEach((f, i) => out.push(`FN:${f.start.row},${names[i]}`));
    m.functions.forEach((f, i) => {
      const c = f.count || 0;
      if (c > 0) fnHit++;
      out.push(`FNDA:${c},${names[i]}`);
    });
    out.push("FNF:" + m.functions.length);
    out.push("FNH:" + fnHit);

    // Branches, grouped into blocks by shared branch point (one block per
    // `when`). All of a block's alternatives sit on the branch-point line so
    // lcov counts them. A `when` whose code was eliminated has every branch
    // count null; that block emits no records (there is no coverage to show).
    const blocks = new Map(); // "row:col" -> { row, items: [count] }
    for (const b of m.branches) {
      const key = b.branchPoint.row + ":" + b.branchPoint.col;
      let blk = blocks.get(key);
      if (!blk) { blk = { row: b.branchPoint.row, items: [] }; blocks.set(key, blk); }
      blk.items.push(b.count);
    }

    // A synthetic line count for each reached branch point: the `when` was
    // evaluated once per branch taken, so its line ran sum(branch counts) times.
    // Only used where the branch-point line has no mapped segment of its own.
    const daLines = new Map(m.lines.map((l) => [l.line, l.count]));
    let brf = 0, brHit = 0, block = 0;
    for (const blk of blocks.values()) {
      const reached = blk.items.some((c) => typeof c === "number");
      if (!reached) continue; // whole `when` eliminated/absent
      blk.items.forEach((c, idx) => {
        const count = c || 0;
        brf++;
        if (count > 0) brHit++;
        out.push(`BRDA:${blk.row},${block},${idx},${count}`);
      });
      if (!daLines.has(blk.row))
        daLines.set(blk.row, blk.items.reduce((s, c) => s + (c || 0), 0));
      block++;
    }
    out.push("BRF:" + brf);
    out.push("BRH:" + brHit);

    // Lines (mapped lines plus the synthetic branch-point lines added above).
    let lHit = 0;
    const sortedLines = [...daLines.entries()].sort((a, b) => a[0] - b[0]);
    for (const [line, count] of sortedLines) {
      if (count > 0) lHit++;
      out.push(`DA:${line},${count}`);
    }
    out.push("LF:" + sortedLines.length);
    out.push("LH:" + lHit);

    out.push("end_of_record");
  }

  process.stdout.write(out.join("\n") + "\n");
}

main();
