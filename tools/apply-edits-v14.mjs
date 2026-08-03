/**
 * Tenth edit pass: v13 → v14. Sourced corrections from the 2 Aug 2026 FOPQT
 * arithmetic review (sources: olympics.com WC allocation; FIBA statements on
 * the Europe FOPQTs and the Africa qualifier format).
 *
 * 1. Africa WC qualification: Window-5 open question RESOLVED — Africa plays
 *    tournament format (FIBA), so the Aug/Feb blocks are correct as entered.
 * 2. Europe FOPQT: FIBA confirms 16 teams, 8 per tournament, 14-22 Aug 2027
 *    (dates + date_confidence already correct in v13; format tightened,
 *    source recorded).
 * 3. bkb-013/016/019 ARITHMETIC GAP narrowed: 27 (FIBA) vs 28 (fixtures) is
 *    ONE African team, not six seats — the seat reading closes the rest.
 * 4. fiba-m-fopqt-7: AMBIGUOUS — global top-7 cut vs fixed 6/6/6/16 fields
 *    cannot both be strictly true.
 * 5. README tab: the "RESOLVED ... do not re-litigate from the document's 27"
 *    block replaced — 27-vs-28 is precisely the surviving open question.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v13.xlsx";
const OUT = "data/LA28_Qualification_Database_v14.xlsx";

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
const cl = wb.getWorksheet("Cut_Lines");
const rd = wb.getWorksheet("README");

// ---- 1. Africa qualification: Window 5 resolved ----
set(cp, "competition_id", "2027-fiba-basketball-world-cup-qualification-africa", "notes",
  "Feeds the FBWC 2027, and separately supplies FOPQT entrants: teams reaching the second round but missing the World Cup go to the FOPQT. Africa has 6 FOPQT places. " +
  "Only the second round is captured in Fixtures; the first round (windows 1-3: Nov 2025, Feb 2026, Jun-Jul 2026) is not entered. " +
  "RESOLVED (2 Aug 2026): the second-round shape — 18 fixtures in late Aug 2026 and 18 in late Feb 2027, none in the November window — is correct as entered. " +
  "FIBA: qualifiers are played home-and-away across six windows 'EXCEPT AFRICA, who play in tournament format to qualify for the FIBA Basketball World Cup 2027.' " +
  "Africa centralises its second round into two tournament blocks; the Window 4/6 stage labels are the sheet's mapping onto FIBA's window numbering, and no fixtures are misdated.");

// ---- 2. Europe FOPQT: FIBA confirmation ----
// Dates (2027-08-14 → 2027-08-22) and date_confidence CONFIRMED were already
// correct in v13 — the set() calls below no-op if so, by design.
set(cp, "competition_id", "two-fiba-olympic-pre-qualifying-tournaments-2027-for-europe", "start_date", "2027-08-14");
set(cp, "competition_id", "two-fiba-olympic-pre-qualifying-tournaments-2027-for-europe", "end_date", "2027-08-22");
set(cp, "competition_id", "two-fiba-olympic-pre-qualifying-tournaments-2027-for-europe", "date_confidence", "CONFIRMED");
set(cp, "competition_id", "two-fiba-olympic-pre-qualifying-tournaments-2027-for-europe", "format",
  "16 European teams · two tournaments of 8");
set(cp, "competition_id", "two-fiba-olympic-pre-qualifying-tournaments-2027-for-europe", "notes",
  "Europe runs TWO pre-qualifying tournaments and sends 2 teams on to the FOQT 2028 — 16 of the 34 FOPQT seats are European. " +
  "Dates and field confirmed by FIBA: '16 teams in total (8 per tournament) from 14 to 22 August 2027.'");

// ---- 3. Links: ARITHMETIC GAP narrowed on bkb-013/016/019 ----
const NEW_GAP =
  "ARITHMETIC GAP (narrowed 2 Aug 2026): FIBA states 27 route entrants; fixtures derive 28 " +
  "(Africa 7, Americas 5, Asia 4, Europe 12 — WC allocation 5/7/7/12 plus host Qatar confirmed via olympics.com). " +
  "The difference is one African team: 7 route candidates for Africa's 6 seats, while every other region fits its seats " +
  "and leaves exactly the 7 ranking places (Americas 1, Asia 2, Europe 4; 27 + 7 = 34). " +
  "Verify the Africa FOPQT entry rule — all seven 2R non-qualifiers, or a classified subset.";
{
  const iNote = colIdx(lk, "eligibility_note");
  for (const lid of ["bkb-013", "bkb-016", "bkb-019"]) {
    const cell = rowBy(lk, "link_id", lid).getCell(iNote);
    const cur = String(cell.value ?? "");
    const parts = cur.split(" | ARITHMETIC GAP:");
    if (parts.length !== 2) throw new Error(`${lid}: expected exactly one ' | ARITHMETIC GAP:' segment, found ${parts.length - 1}`);
    cell.value = parts[0] + " | " + NEW_GAP;
    expected.push({ sheet: "Links", key: lid, col: "eligibility_note", kind: "cell" });
  }
}

// ---- 4. Cut_Lines: the global-top-7 vs fixed-fields tension ----
{
  const cell = rowBy(cl, "cut_line_id", "fiba-m-fopqt-7").getCell(colIdx(cl, "notes"));
  const cur = String(cell.value ?? "");
  if (/AMBIGUOUS/.test(cur)) throw new Error("fiba-m-fopqt-7 already carries an AMBIGUOUS note");
  cell.value = cur +
    " | AMBIGUOUS (2 Aug 2026): a global top-7 cut and fixed regional fields (6/6/6/16) cannot both be strictly true. " +
    "Route entrants leave open seats Americas 1 + Asia 2 + Europe 4 = 7 (Africa 0); a global top-7 by ranking could demand " +
    "a different regional spread (e.g. five Europeans), which fixed fields cannot seat. Either the 7 carry fixed regional " +
    "quotas (contradicting bkb-042–045's 'no fixed count exists per tournament') or the fields flex. FIBA's FOPQT entry " +
    "document should settle it; until then the global TOP_N_OF_POOL reading is a modelling assumption.";
  expected.push({ sheet: "Cut_Lines", key: "fiba-m-fopqt-7", col: "notes", kind: "cell" });
}

// ---- 5. README tab: replace the "do not re-litigate" block (lines 99-103) ----
{
  const guard = String(rd.getRow(99).getCell(1).value ?? "");
  if (!guard.startsWith("RESOLVED (was open in handoff PART 7): the FIBA FOPQT pool arithmetic"))
    throw new Error("README line 99 is not the FOPQT block — line numbers have drifted, aborting");
  const LINES = [
    "NARROWED (2 Aug 2026), not resolved: the FIBA FOPQT route arithmetic. Fixtures derive 28 second-",
    "round teams missing the 2027 World Cup (Africa 7, Americas 5, Asia 4, Europe 12; 60 distinct 2R",
    "teams vs the 32-team field incl. host Qatar — WC allocation 5/7/7/12 confirmed via olympics.com).",
    "FIBA's document states 27, and 27 + 7 ranking places = the 34 FOPQT seats exactly. The difference",
    "is one African team: 7 route candidates for Africa's 6 seats. Verify the Africa FOPQT entry rule.",
  ];
  LINES.forEach((text, i) => {
    const n = 99 + i;
    rd.getRow(n).getCell(1).value = text;
    expected.push({ sheet: "README", key: `(line ${n})`, col: null, kind: "cell" });
  });
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v14.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes ` +
  `(${expected.filter(e => e.kind === "cell").length} cell, ${expected.filter(e => e.kind === "row-add").length} row-adds, ${expected.filter(e => e.kind === "row-del").length} row-dels)`);
