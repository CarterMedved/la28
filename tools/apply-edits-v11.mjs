/**
 * Seventh edit pass: v10 → v11. Fill the scaffolded AFC + CAF rows from
 * sourced research. UNKNOWNs stay blank — nothing inferred.
 * Schema: Fixtures gains notes + date_confidence columns (the AET note and
 * the 3-vs-4 June conflict have nowhere else to live).
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v10.xlsx";
const OUT = "data/LA28_Qualification_Database_v11.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);
const rowBy = (ws, keyCol, keyVal) => {
  const i = colIdx(ws, keyCol);
  let hit = null;
  ws.eachRow((r, n) => { if (n > 1 && r.getCell(i).value === keyVal) hit = r; });
  if (!hit) throw new Error(`no row ${keyVal} in ${ws.name}`);
  return hit;
};
const set = (ws, keyCol, keyVal, col, value) => {
  const cell = rowBy(ws, keyCol, keyVal).getCell(colIdx(ws, col));
  const cur = cell.value == null ? null : String(cell.value);
  if (cur === (value == null ? null : String(value))) return;
  cell.value = value;
  expected.push({ sheet: ws.name, key: keyVal, col, kind: "cell" });
};

const cp = wb.getWorksheet("Competitions");
const fx = wb.getWorksheet("Fixtures");

// ---- Fixtures schema: notes + date_confidence ----
for (const name of ["notes", "date_confidence"]) {
  const c = fx.columnCount + 1;
  fx.getRow(1).getCell(c).value = name;
  fx.getRow(1).getCell(c).style = { ...fx.getRow(1).getCell(1).style };
  fx.getColumn(c).width = name === "notes" ? 60 : 15;
  expected.push({ sheet: "Fixtures", key: "(header)", col: name, kind: "col-add" });
}

// ---- AFC Women's Asian Cup 2026 ----
set(cp, "competition_id", "afc-womens-asian-cup-2026", "location", "Perth / Gold Coast / Sydney");

// QFs 13-15 Mar; exact day per match unsourced → dates blank, noted.
// QF-number assignment follows the source's listing order → stage_source DERIVED.
const QF_NOTE = "Played 13-15 Mar 2026; exact day unsourced. All eight quarter-finalists qualified for the 2028 AFC Women's Olympic Qualifying Tournament.";
const qfs = [
  ["fx-0397", "Australia Women", "North Korea Women", "2-1", QF_NOTE],
  ["fx-0398", "China Women", "Chinese Taipei Women", "2-0", "After extra time. " + QF_NOTE],
  ["fx-0399", "South Korea Women", "Uzbekistan Women", "6-0", QF_NOTE],
  ["fx-0400", "Japan Women", "Philippines Women", "7-0", QF_NOTE],
];
for (const [fid, t1, t2, res, note] of qfs) {
  set(fx, "fixture_id", fid, "team1", t1);
  set(fx, "fixture_id", fid, "team2", t2);
  set(fx, "fixture_id", fid, "result", res);
  set(fx, "fixture_id", fid, "stage_source", "DERIVED");
  set(fx, "fixture_id", fid, "notes", note);
}
// Semis: winners known, pairings NOT — teams stay blank.
const SF_NOTE = "Japan and Australia advanced; China and South Korea were the losing semi-finalists. UNKNOWN which of China/South Korea each beat — teams left blank until sourced.";
set(fx, "fixture_id", "fx-0401", "notes", SF_NOTE);
set(fx, "fixture_id", "fx-0402", "notes", SF_NOTE);
// Final
set(fx, "fixture_id", "fx-0403", "date", "2026-03-21");
set(fx, "fixture_id", "fx-0403", "result", "1-0");
set(fx, "fixture_id", "fx-0403", "notes", "Stadium Australia, Sydney.");

// ---- afc-w-oqt-2028: field known, structure known, draw NOT made ----
set(cp, "competition_id", "afc-w-oqt-2028", "date_confidence", "CONFIRMED");
set(cp, "competition_id", "afc-w-oqt-2028", "format", "8 teams · two groups of four, league format");
set(cp, "competition_id", "afc-w-oqt-2028", "notes",
  "Field fully known (the eight 2026 Asian Cup quarter-finalists): Australia, North Korea, China, Chinese Taipei, South Korea, Uzbekistan, Japan, Philippines. " +
  "Group winners qualify for the Olympics; runners-up go to a play-off. 19 Apr 2027 - 4 Mar 2028. " +
  "Group draw NOT yet made — the field being known is not the draw being made; do not fixture until drawn.");

// ---- CAF W OQT R1 ----
// Comoros tie — fully documented. Leg-1 date conflict (3 or 4 June): 4 June
// used, both legs APPROXIMATE, conflict recorded.
set(fx, "fixture_id", "fx-0391", "date", "2026-06-04");
set(fx, "fixture_id", "fx-0391", "team1", "Comoros Women");
set(fx, "fixture_id", "fx-0391", "team2", "Sudan Women");
set(fx, "fixture_id", "fx-0391", "result", "17-0");
set(fx, "fixture_id", "fx-0391", "date_confidence", "APPROXIMATE");
set(fx, "fixture_id", "fx-0391", "notes", "Larbi Zaouli Stadium, Morocco. Sources give leg 1 as either 3 or 4 June 2026; 4 June used.");
set(fx, "fixture_id", "fx-0392", "date", "2026-06-08");
set(fx, "fixture_id", "fx-0392", "team1", "Comoros Women");
set(fx, "fixture_id", "fx-0392", "team2", "Sudan Women");
set(fx, "fixture_id", "fx-0392", "result", "13-0");
set(fx, "fixture_id", "fx-0392", "date_confidence", "APPROXIMATE");
set(fx, "fixture_id", "fx-0392", "notes", "Larbi Zaouli Stadium, Morocco. Aggregate 30-0.");
// Madagascar & Mauritius — winners and aggregates only. Opponents were South
// Sudan and Djibouti in some order (Sudan played Comoros) — UNSOURCED which;
// opponents, leg scores and dates stay blank.
const T2_NOTE = "Madagascar won the tie 2-1 on aggregate. Opponent is South Sudan or Djibouti — which is unsourced (Sudan played Comoros). Leg scores and dates unknown; blanks are honest gaps, not omissions.";
const T3_NOTE = "Mauritius won the tie 3-1 on aggregate. Opponent is South Sudan or Djibouti — which is unsourced (Sudan played Comoros). Leg scores and dates unknown; blanks are honest gaps, not omissions.";
set(fx, "fixture_id", "fx-0393", "team1", "Madagascar Women");
set(fx, "fixture_id", "fx-0393", "notes", T2_NOTE);
set(fx, "fixture_id", "fx-0394", "team1", "Madagascar Women");
set(fx, "fixture_id", "fx-0394", "notes", T2_NOTE);
set(fx, "fixture_id", "fx-0395", "team1", "Mauritius Women");
set(fx, "fixture_id", "fx-0395", "notes", T3_NOTE);
set(fx, "fixture_id", "fx-0396", "team1", "Mauritius Women");
set(fx, "fixture_id", "fx-0396", "notes", T3_NOTE);

// ---- R1/R2 competition notes ----
set(cp, "competition_id", "caf-w-oqt-2028-r1", "notes",
  "6 lowest-ranked teams by FIFA ranking in 3 two-legged ties: Comoros v Sudan (30-0 agg), Madagascar and Mauritius v South Sudan and Djibouti in an unsourced order (2-1 and 3-1 agg). " +
  "Winners: Comoros, Madagascar, Mauritius — all advance to Round 2. 35 nations entered; all ties home-and-away. Round 1 of 5.");
{
  const r = rowBy(cp, "competition_id", "caf-w-oqt-2028-r2");
  const i = colIdx(cp, "notes");
  r.getCell(i).value = String(r.getCell(i).value).replace(/\s+$/, "") +
    " R2 pairings confirmed so far: Comoros v Nigeria. Madagascar and Mauritius face South Africa and Ghana in an unsourced order — full draw not resolved, so R2 stays unfixtured.";
  expected.push({ sheet: "Competitions", key: "caf-w-oqt-2028-r2", col: "notes", kind: "cell" });
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v11.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes ` +
  `(${expected.filter(e => e.kind === "cell").length} cell, ${expected.filter(e => e.kind === "col-add").length} col-adds)`);
