/**
 * Fourth edit pass: v7 → v8.
 *  - Notes essay triage: the 3,626-char research prose (found in THREE rows,
 *    not one) is removed; database-worthy facts become rows.
 *  - New competitions + RANKING_POINTS links: Emerging Nations Trophy,
 *    associate series umbrella. Asian Games women + SA-in-Zimbabwe rows
 *    updated with extracted facts, UNCONFIRMED, conflicts flagged.
 *  - Results: fx-0063 = 0-4. fx-0062 left blank (not found).
 *  - U-20 QF rows filled from the known bracket; numbering derived (see notes
 *    in the run report), stage_source = DERIVED.
 *  - CAF R1 + AFC Asian Cup knockout scaffolding rows: blank teams/dates so a
 *    future session drops values in without re-deriving structure.
 *  - Cut_Lines gains `continents`; cricket's four declared on icc-m-continental-4.
 *  - README conventions: result format, continents column.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v7.xlsx";
const OUT = "data/LA28_Qualification_Database_v8.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);
const rowOf = (ws, col, value) => {
  const i = colIdx(ws, col);
  let hit = null;
  ws.eachRow((r, n) => { if (n > 1 && r.getCell(i).value === value) hit = r; });
  if (!hit) throw new Error(`no row in ${ws.name} where ${col} = ${value}`);
  return hit;
};
const set = (ws, keyCol, keyVal, col, value, diffKey) => {
  rowOf(ws, keyCol, keyVal).getCell(colIdx(ws, col)).value = value;
  expected.push({ sheet: ws.name, key: diffKey ?? keyVal, col, kind: "cell" });
};

const cp = wb.getWorksheet("Competitions");
const lk = wb.getWorksheet("Links");
const fx = wb.getWorksheet("Fixtures");
const cl = wb.getWorksheet("Cut_Lines");
const rm = wb.getWorksheet("README");

// ---- essay triage: clear all three copies, then write proper per-row notes ----
set(cp, "competition_id", "pakistan-women-s-cricket-team-in-sri-lanka-in-2026", "notes", null);
set(cp, "competition_id", "2026-concacaf-u-20-championship", "notes", null);

set(cp, "competition_id", "cricket-at-the-2026-asian-games-women-s-tournament", "start_date", "2026-09-17");
set(cp, "competition_id", "cricket-at-the-2026-asian-games-women-s-tournament", "end_date", "2026-09-22");
set(cp, "competition_id", "cricket-at-the-2026-asian-games-women-s-tournament", "location", "Kōrogi Sports Park, Aichi");
set(cp, "competition_id", "cricket-at-the-2026-asian-games-women-s-tournament", "format", "8 teams · straight knockout");
set(cp, "competition_id", "cricket-at-the-2026-asian-games-women-s-tournament", "date_confidence", "APPROXIMATE");
set(cp, "competition_id", "cricket-at-the-2026-asian-games-women-s-tournament", "confidence", "UNCONFIRMED");
set(cp, "competition_id", "cricket-at-the-2026-asian-games-women-s-tournament", "notes",
  "Field: India, Pakistan, Bangladesh, Nepal, UAE, Thailand, Malaysia, Japan. Seeded on the ICC Women's T20I rankings of 23 July 2026. " +
  "UNCONFIRMED — extracted from prior-session research prose, not a primary source. Verify against official announcements: " +
  "dates (this row previously said 16-18 Sep; prose says 17-22 Sep), venue, format (previously 'groups, single round-robin'; prose says straight knockout), and the field.");

set(cp, "competition_id", "south-africa-women-s-cricket-team-in-zimbabwe-in-2026", "confidence", "UNCONFIRMED");
set(cp, "competition_id", "south-africa-women-s-cricket-team-in-zimbabwe-in-2026", "notes",
  "3 T20Is per prior-session research prose; this row's format says 5 matches — verify match count and the 11-19 Sep 2026 dates against the official series announcement. " +
  "High leverage for Zimbabwe: rating points against a top-five side, inside the women's ranking window.");

// ---- new competitions + links ----
const newComps = [
  ["icc-womens-emerging-nations-trophy-2026", "ICC Women's Emerging Nations Trophy 2026",
    "November 2026 per prior-session research prose (UNCONFIRMED — not a primary source). Verify dates, venue and field against the ICC announcement. Matches feed the women's T20I ranking inside the qualification window."],
  ["2026-27-womens-associate-t20i-series", "2026-27 women's associate T20I series (umbrella)",
    "Tri- and quadrangular series expected from ~Oct 2026 — the main route for USA-, Nepal-, Thailand- and Scotland-tier sides to earn rating points and meet the eight-match ranking minimum. UNCONFIRMED umbrella row from prior-session research prose; split into individual series as schedules are announced."],
];
{
  const head = cp.getRow(1).values;
  for (const [id, name, notes] of newComps) {
    const row = new Array(head.length - 1).fill(null);
    const put = (col, v) => row[head.indexOf(col) - 1] = v;
    put("competition_id", id); put("name", name); put("sport", "Cricket"); put("gender", "W");
    put("status", "UNANNOUNCED"); put("date_confidence", "TBD"); put("confidence", "UNCONFIRMED");
    put("notes", notes);
    cp.addRow(row);
    expected.push({ sheet: "Competitions", key: id, col: null, kind: "row-add" });
  }
  const lh = lk.getRow(1).values;
  const links = [["cri-022", "icc-womens-emerging-nations-trophy-2026"], ["cri-023", "2026-27-womens-associate-t20i-series"]];
  for (const [lid, from] of links) {
    const row = new Array(lh.length - 1).fill(null);
    const put = (col, v) => row[lh.indexOf(col) - 1] = v;
    put("link_id", lid); put("from_id", from); put("from_type", "COMPETITION");
    put("to_id", "icc-womens-t20i-team-ranking"); put("to_type", "RANKING");
    put("relationship", "RANKING_POINTS");
    put("criterion", "T20I matches award rating points toward the women's ranking");
    put("confidence", "UNCONFIRMED");
    lk.addRow(row);
    expected.push({ sheet: "Links", key: lid, col: null, kind: "row-add" });
  }
}

// ---- results ----
set(fx, "fixture_id", "fx-0063", "result", "0-4");

// ---- U-20 quarter-finals: teams + dates from the known bracket ----
// QF1 = "1st v 8th" and the USA are the stated top seed → USA v Guatemala.
// The other three assignments are inferred from dates (only one game on
// 4 Aug); stage_source = DERIVED records that the numbering is inferred.
const qfs = [
  ["fx-0072", "USA U-20", "Guatemala U-20", "2026-08-05"],
  ["fx-0071", "Costa Rica U-20", "Haiti U-20", "2026-08-04"],
  ["fx-0078", "Canada U-20", "Jamaica U-20", "2026-08-05"],
  ["fx-0077", "Mexico U-20", "Panama U-20", "2026-08-06"],
];
const dayStr = v => v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10);
for (const [fid, t1, t2, date] of qfs) {
  const r = rowOf(fx, "fixture_id", fid);
  const cur = dayStr(r.getCell(colIdx(fx, "date")).value);
  set(fx, "fixture_id", fid, "team1", t1);
  set(fx, "fixture_id", fid, "team2", t2);
  if (cur !== date) set(fx, "fixture_id", fid, "date", date);
  set(fx, "fixture_id", fid, "stage_source", "DERIVED");
}

// ---- scaffolding rows: CAF R1 (6) + AFC Asian Cup knockout (7) ----
{
  const fh = fx.getRow(1).values;
  const addFx = (fid, comp, t1, t2, stage) => {
    const row = new Array(fh.length - 1).fill(null);
    const put = (col, v) => row[fh.indexOf(col) - 1] = v;
    put("fixture_id", fid); put("competition_id", comp);
    put("team1", t1); put("team2", t2); put("stage", stage);
    fx.addRow(row);
    expected.push({ sheet: "Fixtures", key: fid, col: null, kind: "row-add" });
  };
  let n = 391;
  for (let tie = 1; tie <= 3; tie++)
    for (let leg = 1; leg <= 2; leg++)
      addFx(`fx-${String(n++).padStart(4, "0")}`, "caf-w-oqt-2028-r1", null, null, `Tie ${tie} · Leg ${leg}`);
  for (let i = 1; i <= 4; i++)
    addFx(`fx-${String(n++).padStart(4, "0")}`, "afc-womens-asian-cup-2026", null, null, `Quarter-final ${i}`);
  addFx(`fx-${String(n++).padStart(4, "0")}`, "afc-womens-asian-cup-2026", null, null, "Semi-final 1");
  addFx(`fx-${String(n++).padStart(4, "0")}`, "afc-womens-asian-cup-2026", null, null, "Semi-final 2");
  addFx(`fx-${String(n++).padStart(4, "0")}`, "afc-womens-asian-cup-2026", "Japan Women", "Australia Women", "Final");
}

// ---- Cut_Lines: continents column, cricket's four declared ----
{
  const c = cl.columnCount + 1;
  cl.getRow(1).getCell(c).value = "continents";
  cl.getRow(1).getCell(c).style = { ...cl.getRow(1).getCell(1).style };
  cl.getColumn(c).width = 28;
  expected.push({ sheet: "Cut_Lines", key: "(header)", col: "continents", kind: "col-add" });
  set(cl, "cut_line_id", "icc-m-continental-4", "continents", "Africa, Asia, Europe, Oceania");
}

// ---- README ----
const lines = [
  "",
  "Fixtures.result — football scores as \"2-1\" with team1's score first; cricket as plain outcome",
  "text (\"Sri Lanka Women won by 5 wickets\"). Nothing computes from result today; if something ever",
  "needs to, the answer is a winner column, not a parseable string.",
  "",
  "Cut_Lines.continents — TOP_PER_NAMED_CONTINENT declares its continent list on the row,",
  "comma-separated. The list is part of the rule: cricket's four exclude the Americas because the",
  "host holds that berth; FIBA files Australia and NZ under Asia. Blank falls back to the legacy",
  "cricket list and the validator warns.",
];
lines.forEach(line => {
  const n = rm.rowCount + 1;
  rm.getRow(n).getCell(1).value = line === "" ? null : line;
  if (line !== "") expected.push({ sheet: "README", key: `(line ${n})`, col: null, kind: "row-add" });
});

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v8.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT}`);
console.log(`intended changes: ${expected.length} (${expected.filter(e => e.kind === "cell").length} cell edits, ` +
  `${expected.filter(e => e.kind === "row-add").length} row additions, ${expected.filter(e => e.kind === "col-add").length} column additions)`);
