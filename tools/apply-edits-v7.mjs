/**
 * Third edit pass: v6 → v7. Delete the twelve unlinked competitions (scrape
 * artefacts) and every fixture referencing them. Derived from the graph at
 * run time — a competition is doomed if no Link touches it.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v6.xlsx";
const OUT = "data/LA28_Qualification_Database_v7.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);

const cp = wb.getWorksheet("Competitions");
const lk = wb.getWorksheet("Links");
const fx = wb.getWorksheet("Fixtures");

// derive the unlinked set from the graph
const linked = new Set();
{
  const iF = colIdx(lk, "from_id"), iT = colIdx(lk, "to_id");
  lk.eachRow((r, n) => { if (n > 1) { linked.add(r.getCell(iF).value); linked.add(r.getCell(iT).value); } });
}
const doomedComps = [];
{
  const iId = colIdx(cp, "competition_id");
  cp.eachRow((r, n) => { if (n > 1 && !linked.has(r.getCell(iId).value)) doomedComps.push({ n, id: r.getCell(iId).value }); });
}
if (doomedComps.length !== 12)
  throw new Error(`expected exactly 12 unlinked competitions, found ${doomedComps.length}: ${doomedComps.map(d => d.id).join(", ")}`);

const doomedIds = new Set(doomedComps.map(d => d.id));
const doomedFx = [];
{
  const iC = colIdx(fx, "competition_id"), iF = colIdx(fx, "fixture_id");
  fx.eachRow((r, n) => { if (n > 1 && doomedIds.has(r.getCell(iC).value)) doomedFx.push({ n, fid: r.getCell(iF).value, comp: r.getCell(iC).value }); });
}

for (const d of doomedFx.sort((a, b) => b.n - a.n)) {
  fx.spliceRows(d.n, 1);
  expected.push({ sheet: "Fixtures", key: d.fid, col: null, kind: "row-del" });
}
for (const d of doomedComps.sort((a, b) => b.n - a.n)) {
  cp.spliceRows(d.n, 1);
  expected.push({ sheet: "Competitions", key: d.id, col: null, kind: "row-del" });
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v7.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT}`);
console.log(`deleted ${doomedComps.length} competitions:`);
doomedComps.sort((a, b) => a.id.localeCompare(b.id)).forEach(d => console.log("  " + d.id));
console.log(`deleted ${doomedFx.length} fixtures across them`);
const perComp = {};
doomedFx.forEach(d => perComp[d.comp] = (perComp[d.comp] || 0) + 1);
Object.entries(perComp).sort().forEach(([c, n]) => console.log(`  ${n} fx · ${c}`));
