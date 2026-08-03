/**
 * Eighth edit pass: v11 → v12.
 *  1. fbl-005 completed: full CONCACAF rule in criterion (host pass-down),
 *     ONE row — see the argument in the run report.
 *  2. fx-0077 QF back to 5 Aug (the 6 Aug was a UTC rendering).
 *  3. The two undated COMPLETEs get their sourced dates + structure.
 *  4. eurobasket-2029 pre-quals 2R: IN_PROGRESS → SCHEDULED (start date was
 *     always right); structure recorded.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v11.xlsx";
const OUT = "data/LA28_Qualification_Database_v12.xlsx";

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
  if ((cell.value == null ? null : String(cell.value)) === (value == null ? null : String(value))) return;
  cell.value = value;
  expected.push({ sheet: ws.name, key: keyVal, col, kind: "cell" });
};

const cp = wb.getWorksheet("Competitions");
const lk = wb.getWorksheet("Links");
const fx = wb.getWorksheet("Fixtures");
const rm = wb.getWorksheet("README");

// ---- 1. fbl-005: the full rule, one row ----
set(lk, "link_id", "fbl-005", "criterion",
  "The tournament winner qualifies for the 2028 Olympics. Should the United States — already qualified as Olympic host — win, the berth is awarded to the runner-up. (Separately, the four semi-finalists qualify for the FIFA U-20 World Cup 2027.)");
set(lk, "link_id", "fbl-005", "berth_math",
  "1 berth from 12 teams, whoever it lands on: winner, or runner-up if the USA win. The recipient is conditional; the count and source are not — which is why this is one link row, not two. The same matches also decide the four U-20 World Cup places.");
set(lk, "link_id", "fbl-005", "confidence", "CONFIRMED");
set(lk, "link_id", "fbl-005", "source_ref", "CONCACAF schedule announcement (Qualification rule stated in full); en.wikipedia.org/wiki/Football_at_the_2028_Summer_Olympics_–_Men's_qualification");

// ---- 2. QF date ----
set(fx, "fixture_id", "fx-0077", "date", "2026-08-05");
set(fx, "fixture_id", "fx-0077", "notes", "6 Aug in an earlier source was a UTC rendering of a 5 Aug evening kickoff. Official: QFs 4-5 Aug, SFs 7 Aug, final 9 Aug.");

// ---- 3. the two undated COMPLETEs ----
set(cp, "competition_id", "concacaf-u20-2026-qualification", "start_date", "2026-02-23");
set(cp, "competition_id", "concacaf-u20-2026-qualification", "end_date", "2026-03-04");
set(cp, "competition_id", "concacaf-u20-2026-qualification", "date_confidence", "CONFIRMED");
set(cp, "competition_id", "concacaf-u20-2026-qualification", "format", "32 teams · 6 groups (two of six, four of five), single round-robin");
set(cp, "competition_id", "concacaf-u20-2026-qualification", "notes",
  "Hosts: Costa Rica, Curaçao, Nicaragua. 67 matches; the six group winners advanced to the 2026 CONCACAF U-20 Championship. Individual fixtures not captured.");
set(cp, "competition_id", "fwbwc-qualifying-tournaments-2026", "start_date", "2026-03-11");
set(cp, "competition_id", "fwbwc-qualifying-tournaments-2026", "end_date", "2026-03-17");
set(cp, "competition_id", "fwbwc-qualifying-tournaments-2026", "date_confidence", "CONFIRMED");
set(cp, "competition_id", "fwbwc-qualifying-tournaments-2026", "format", "24 teams · four tournaments of six, single round-robin");
set(cp, "competition_id", "fwbwc-qualifying-tournaments-2026", "notes",
  "Hosts: Wuhan (China), Lyon-Villeurbanne (France), San Juan (Puerto Rico), Istanbul (Türkiye). 60 games, 11 World Cup places. " +
  "Split point of the whole women's pathway: qualifiers went to the FWBWC 2026, the eight that did not went to the FWOPQT. Individual fixtures not captured.");

// ---- 4. eurobasket-2029 pre-quals 2R ----
set(cp, "competition_id", "fiba-eurobasket-2029-pre-qualifiers-second-round", "status", "SCHEDULED");
set(cp, "competition_id", "fiba-eurobasket-2029-pre-qualifiers-second-round", "notes",
  "12 teams in four groups of three: the eight eliminated from the First Round of the WC 2027 European Qualifiers plus four from the Pre-Qualifiers First Round. " +
  "Best-ranked team in each group advances to the EuroBasket 2029 Qualifiers. Windows: Aug 2026 (week 1: 27-30 Aug), Nov 2026, Feb 2027. " +
  "NOT an Olympic tournament, but played by exactly the pool from which the 7 ranking-based FOPQT places are drawn — results here move the March 2027 FIBA ranking.");

// ---- README: PART 7 resolution ----
const lines = [
  "",
  "RESOLVED (was open in handoff PART 7): CONCACAF U-20 → Olympics exact placing rule. CONCACAF's",
  "schedule announcement states it in full: the winner takes the Olympic berth, but should the",
  "United States — already qualified as host — win the tournament, the berth passes to the",
  "runner-up. The four semi-finalists separately qualify for the FIFA U-20 World Cup 2027.",
  "Modelled on link fbl-005 as one row (recipient conditional, count and source fixed).",
];
lines.forEach(line => {
  const n = rm.rowCount + 1;
  rm.getRow(n).getCell(1).value = line === "" ? null : line;
  if (line !== "") expected.push({ sheet: "README", key: `(line ${n})`, col: null, kind: "row-add" });
});

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v12.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes`);
