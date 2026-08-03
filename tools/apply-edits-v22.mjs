/**
 * Eighteenth edit pass: v21 → v22. Delete the three formula self-check
 * columns entirely — Fixtures.check (col J), Links.check (col T),
 * Olympic_Events.berth_check (col I): 461 formula cells whose Sheets
 * upload recalculated with silently drifted row references (288 drifted;
 * 238 evaluated "OK" against the WRONG row). Every check's intent is a
 * tested validator rule already (referential/fixtures-competition_id,
 * referential/links-from_id/-to_id, arithmetic/berth-sum); the columns
 * were read by nothing, published as junk data, and sat on two gated tabs
 * where a recalc flip would be ack noise. hygiene/formula-cells (ERROR)
 * ships in the same change and keeps the workbook formula-free forever.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v21.xlsx";
const OUT = "data/LA28_Qualification_Database_v22.xlsx";

const TARGETS = [
  { sheet: "Olympic_Events", col: "berth_check", key: "olympic_event_id" },
  { sheet: "Competitions", col: null },              // guard: must have no formula cols
  { sheet: "Links", col: "check", key: "link_id" },
  { sheet: "Fixtures", col: "check", key: "fixture_id" },
];

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
let cellsRemoved = 0;

for (const t of TARGETS) {
  if (!t.col) continue;
  const ws = wb.getWorksheet(t.sheet);
  const head = ws.getRow(1).values;
  const iCol = head.findIndex(v => v === t.col);
  const iKey = head.findIndex(v => v === t.key);
  if (iCol < 0) throw new Error(`${t.sheet}: no "${t.col}" column — aborting`);
  if (iKey < 0) throw new Error(`${t.sheet}: no "${t.key}" column — aborting`);
  expected.push({ sheet: t.sheet, key: "(header)", col: t.col, kind: "col-del" });
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const v = r.getCell(iCol).value;
    if (v === null || v === undefined || String(v).trim() === "") return;
    expected.push({ sheet: t.sheet, key: String(r.getCell(iKey).value), col: t.col, kind: "cell" });
    cellsRemoved++;
  });
  ws.spliceColumns(iCol, 1);
  if (ws.getRow(1).values.includes(t.col)) throw new Error(`${t.sheet}: "${t.col}" survived the splice — aborting`);
}

if (cellsRemoved !== 461) throw new Error(`expected 461 formula-cell removals, found ${cellsRemoved} — aborting`);

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v22.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes (3 col-del + ${cellsRemoved} cell removals)`);
