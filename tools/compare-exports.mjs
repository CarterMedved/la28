/**
 * Preflight §B4: double-export comparison at the level that matters —
 * CELL VALUES and NUMBER FORMATS, never zip structure. Google re-serialises
 * the sheet XML between exports (measured 3 Aug 2026: differing CRC-32s and
 * raw XML sizes with zero differing cells/formats), so the two files'
 * sha256s are EXPECTED to differ; they are printed for the record as the
 * trigger for the dual-hash design, never as a diagnosis.
 *
 * Exits 1 with a full enumeration on any value or format difference, or if
 * Fixtures.date is not `yyyy-mm-dd h:mm:ss` in BOTH books (formats ARE
 * content here — the toStamp bug came from a number format).
 */
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const A_PATH = process.argv[2];
const B_PATH = process.argv[3];
if (!A_PATH || !B_PATH) {
  console.error("usage: node tools/compare-exports.mjs <export-1.xlsx> <export-2.xlsx>");
  process.exit(2);
}

const sha256 = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const fmt = f => (f === undefined || f === null || f === "" ? "General" : f);
const render = cell => {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if (v.richText) return v.richText.map(r => r.text).join("");
    if (v.formula !== undefined) return `=${v.formula}→${v.result ?? ""}`;
    if (v.text !== undefined) return String(v.text);
    if (v.error !== undefined) return String(v.error);
    return JSON.stringify(v);
  }
  return String(v);
};

const load = async p => { const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(p); return wb; };
const [wbA, wbB] = await Promise.all([load(A_PATH), load(B_PATH)]);

const diffs = [];
let cellsCompared = 0;

const namesA = wbA.worksheets.map(w => w.name);
const namesB = wbB.worksheets.map(w => w.name);
for (const n of namesA) if (!namesB.includes(n)) diffs.push(`tab "${n}" only in ${A_PATH}`);
for (const n of namesB) if (!namesA.includes(n)) diffs.push(`tab "${n}" only in ${B_PATH}`);

for (const name of namesA.filter(n => namesB.includes(n))) {
  const wsA = wbA.getWorksheet(name), wsB = wbB.getWorksheet(name);
  const rows = Math.max(wsA.rowCount, wsB.rowCount);
  const cols = Math.max(wsA.columnCount, wsB.columnCount);
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      const a = wsA.getRow(r).getCell(c), b = wsB.getRow(r).getCell(c);
      cellsCompared++;
      const va = render(a), vb = render(b);
      if (va !== vb) diffs.push(`${name}!${a.address}: VALUE ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`);
      const fa = fmt(a.numFmt), fb = fmt(b.numFmt);
      if (fa !== fb) diffs.push(`${name}!${a.address}: FORMAT ${JSON.stringify(fa)} vs ${JSON.stringify(fb)}`);
    }
  }
}

// Fixtures.date must read yyyy-mm-dd h:mm:ss in BOTH — identical drift in
// both exports would pass the pairwise comparison, so this is absolute.
// Applies only to DATE-typed cells: three fixtures (fx-0391/0392/0403) store
// their date as a text cell, where a number format is meaningless.
const DATE_FMT = "yyyy-mm-dd h:mm:ss";
for (const [p, wb] of [[A_PATH, wbA], [B_PATH, wbB]]) {
  const ws = wb.getWorksheet("Fixtures");
  if (!ws) { diffs.push(`${p}: no Fixtures tab`); continue; }
  const iDate = ws.getRow(1).values.findIndex(v => v === "date");
  if (iDate < 0) { diffs.push(`${p}: Fixtures has no "date" column`); continue; }
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const cell = row.getCell(iDate);
    if (!(cell.value instanceof Date)) return;
    if (fmt(cell.numFmt) !== DATE_FMT)
      diffs.push(`${p} Fixtures!${cell.address}: date format ${JSON.stringify(fmt(cell.numFmt))}, expected ${JSON.stringify(DATE_FMT)}`);
  });
}

console.log(`file sha256 (record both; differing is BY DESIGN — Google re-serialises XML between exports):`);
console.log(`  ${A_PATH}: ${sha256(A_PATH)}`);
console.log(`  ${B_PATH}: ${sha256(B_PATH)}`);

if (diffs.length) {
  console.error(`\n${diffs.length} DIFFERENCE(S) — full enumeration:`);
  for (const d of diffs) console.error(`  ${d}`);
  process.exit(1);
}
console.log(`\nCELL VALUES + NUMBER FORMATS IDENTICAL — ${cellsCompared} cell positions across ${namesA.length} tabs; Fixtures.date is ${JSON.stringify(DATE_FMT)} in both.`);
