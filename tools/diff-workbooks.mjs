/**
 * Cell-level diff between two workbooks, keyed by row identity (primary key,
 * never row number, so the 16 deletions don't cascade into false diffs).
 * Asserts: observed changes == tools/expected-changes.json exactly, both ways.
 */
import { readFileSync } from "node:fs";
import { snapshot, tzCouplingViolations } from "./wbdiff.mjs";   // shared with tools/pull-gate.mjs — one diff engine, not two

const A_PATH = process.argv[2] ?? "data/LA28_Qualification_Database.xlsx";
const B_PATH = process.argv[3] ?? "data/LA28_Qualification_Database_v5.xlsx";
const EXPECTED_PATH = process.argv[4] ?? "tools/expected-changes.json";
const { expected } = JSON.parse(readFileSync(EXPECTED_PATH, "utf8"));

const A = await snapshot(A_PATH);
const B = await snapshot(B_PATH);

const observed = [];   // {sheet, key, col, kind}
// tabs
for (const t of Object.keys(B)) if (!A[t]) observed.push({ sheet: t, key: "(tab)", col: null, kind: "tab-add" });
for (const t of Object.keys(A)) if (!B[t]) observed.push({ sheet: t, key: "(tab)", col: null, kind: "tab-del" });

for (const t of Object.keys(A)) {
  if (!B[t]) continue;
  // columns
  for (const c of B[t].head) if (!A[t].head.includes(c)) observed.push({ sheet: t, key: "(header)", col: c, kind: "col-add" });
  for (const c of A[t].head) if (!B[t].head.includes(c)) observed.push({ sheet: t, key: "(header)", col: c, kind: "col-del" });
  // rows
  const aKeys = new Set(Object.keys(A[t].rows)), bKeys = new Set(Object.keys(B[t].rows));
  for (const k of aKeys) if (!bKeys.has(k)) observed.push({ sheet: t, key: k, col: null, kind: "row-del" });
  for (const k of bKeys) if (!aKeys.has(k)) observed.push({ sheet: t, key: k, col: null, kind: "row-add" });
  // cells on shared rows, shared columns (added columns count once as col-add;
  // values in an added column on existing rows are cell edits)
  for (const k of aKeys) {
    if (!bKeys.has(k)) continue;
    const ra = A[t].rows[k], rb = B[t].rows[k];
    const cols = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    for (const c of cols) {
      const va = ra[c] ?? null, vb = rb[c] ?? null;
      if (va !== vb) observed.push({ sheet: t, key: k, col: c === "_raw" ? null : c, kind: "cell" });
    }
  }
}

// rows added in the Qualified tab are also "row-add" under the tab-add; expected models them individually
const sig = e => `${e.sheet}::${e.key}::${e.col ?? ""}::${e.kind}`;
const expSet = new Map(expected.map(e => [sig(e), e]));
const obsSet = new Map(observed.map(e => [sig(e), e]));

// A brand-new tab implies its rows: expected lists tab-add AND each row-add; snapshot of A has no tab so
// observed lists tab-add only. Reconcile by expanding observed with B's rows for added tabs.
for (const o of [...obsSet.values()].filter(o => o.kind === "tab-add")) {
  for (const k of Object.keys(B[o.sheet].rows)) {
    const e = { sheet: o.sheet, key: k, col: null, kind: "row-add" };
    obsSet.set(sig(e), e);
  }
}

const unexpected = [...obsSet.values()].filter(o => !expSet.has(sig(o)));
const missing = [...expSet.values()].filter(e => !obsSet.has(sig(e)));

console.log(`observed changes: ${obsSet.size} · intended: ${expSet.size}`);
if (unexpected.length) { console.log("\nUNEXPECTED (changed but not on the list):"); unexpected.forEach(u => console.log(" ", sig(u))); }
if (missing.length) { console.log("\nMISSING (intended but not observed):"); missing.forEach(m => console.log(" ", sig(m))); }

// Survival count. DEFINITION (reproducible from the OLD book alone): a cell
// is one (shared row key) × (OLD book's header column) coordinate, BLANKS
// INCLUDED — null==null counts as identical, so the denominator is the old
// book's full grid over rows present in both, not its populated cells.
// README counts 1 pseudo-column per line. Values in columns ADDED by the
// new book appear as `cell` entries in the observed-change list above and
// are never part of this denominator (which is why a pure col-add pass can
// show "0 changed cells" while listing its fills as changes).
let same = 0, total = 0;
const perTab = [];
for (const t of Object.keys(A)) {
  if (!B[t]) continue;
  let rows = 0, cells = 0;
  for (const k of Object.keys(A[t].rows)) {
    if (!B[t].rows[k]) continue;
    rows++;
    for (const c of Object.keys(A[t].rows[k])) {
      total++; cells++;
      if ((A[t].rows[k][c] ?? null) === (B[t].rows[k][c] ?? null)) same++;
    }
  }
  perTab.push(`${t} ${rows}×${rows ? cells / rows : 0}`);
}
console.log(`\ncell survival on shared rows: ${same}/${total} identical; ${total - same} changed cells`);
console.log(`  denominator = old book's grid over shared rows, blanks included, new columns excluded:`);
console.log(`  ${perTab.join(" · ")}`);
// tz↔tz_source coupling (see wbdiff.mjs): fails the pass even when the
// change set matches the intent — an intended incoherence is still incoherent.
const coupling = tzCouplingViolations([...obsSet.values()]);
if (coupling.length) {
  console.log("\nTZ COUPLING VIOLATION (tz changed, tz_source untouched on the same row):");
  coupling.forEach(v => console.log("  " + v));
}

console.log(unexpected.length || missing.length ? "\nDIFF MISMATCH — do not ship."
  : coupling.length ? "\nCOUPLING VIOLATION — do not ship." : "\nEXACT MATCH: changed set == intended set.");
process.exit(unexpected.length || missing.length || coupling.length ? 1 : 0);
