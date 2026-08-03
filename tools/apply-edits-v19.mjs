/**
 * Fifteenth edit pass: v18 → v19. teams_count for the five competitions the
 * pool-preview touches — and ONLY those five. The preview's field sizes now
 * come from this declared column instead of a /^(\d+)\s+teams/ regex over
 * format strings (which silently dropped Europe: "16 European teams · two
 * tournaments of 8" doesn't lead with "16 teams"). Values are deliberate
 * declarations from the sources already cited on each row (IOC qualification
 * document for the FOPQT fields; FIBA's statement for Europe's 16; the WC's
 * 32 is on its own row), not runtime parses. The general teams_count fill
 * and arithmetic/qualifiers-vs-field wait for after 23 Aug, per decision.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v18.xlsx";
const OUT = "data/LA28_Qualification_Database_v19.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);

const cp = wb.getWorksheet("Competitions");
const FILLS = {
  "fiba-olympic-pre-qualifying-tournament-2027-for-africa": 6,
  "fiba-olympic-pre-qualifying-tournament-2027-for-americas": 6,
  "fiba-olympic-pre-qualifying-tournament-2027-for-asia": 6,
  "two-fiba-olympic-pre-qualifying-tournaments-2027-for-europe": 16,
  "2027-fiba-basketball-world-cup": 32,
};
{
  const iC = colIdx(cp, "competition_id"), iT = colIdx(cp, "teams_count");
  let done = 0;
  cp.eachRow((r, n) => {
    if (n === 1) return;
    const id = String(r.getCell(iC).value ?? "");
    if (!(id in FILLS)) return;
    if (r.getCell(iT).value != null && String(r.getCell(iT).value) !== "")
      throw new Error(`${id}: teams_count is not blank — aborting`);
    r.getCell(iT).value = FILLS[id];
    expected.push({ sheet: "Competitions", key: id, col: "teams_count", kind: "cell" });
    done++;
  });
  if (done !== 5) throw new Error(`expected 5 teams_count fills, made ${done}`);
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v19.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes (5 cell, 0 row-adds, 0 col-add)`);
