/**
 * Fifth edit pass: v8 → v9. REVERT the prose-over-data writes.
 * Precedence rule: structured rows with fixture children outrank prose from a
 * prior session. The prose raises verification items in notes; it does not
 * overwrite. Every prose-sourced field write from v8 goes back to its v7
 * value (dates, format, location, date_confidence); confidence UNCONFIRMED
 * and the conflict list in notes stay.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v8.xlsx";
const OUT = "data/LA28_Qualification_Database_v9.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);
const rowOf = (ws, keyVal) => {
  const i = colIdx(ws, "competition_id");
  let hit = null;
  ws.eachRow((r, n) => { if (n > 1 && r.getCell(i).value === keyVal) hit = r; });
  if (!hit) throw new Error(`no row ${keyVal}`);
  return hit;
};
const cp = wb.getWorksheet("Competitions");
const set = (keyVal, col, value) => {
  const cell = rowOf(cp, keyVal).getCell(colIdx(cp, col));
  const cur = cell.value == null ? null : String(cell.value);
  const next = value == null ? null : String(value);
  if (cur === next) return;   // already at the target value (e.g. never overwritten) — no-op
  cell.value = value;
  expected.push({ sheet: "Competitions", key: keyVal, col, kind: "cell" });
};
const rm = wb.getWorksheet("README");

// ---- Asian Games women: restore v7 values (fixtures win) ----
const AG = "cricket-at-the-2026-asian-games-women-s-tournament";
set(AG, "start_date", "2026-09-16 20:00:00");
set(AG, "end_date", "2026-09-18 1:00:00");
set(AG, "format", "8 teams · groups, single round-robin");
set(AG, "location", null);
set(AG, "date_confidence", null);
set(AG, "notes",
  "VERIFY (prior-session research prose disagrees with this row's fixtures — the fixtures win until a primary source says otherwise): " +
  "prose claims 17-22 Sep at Kōrogi Sports Park, straight knockout, seeded on the 23 Jul 2026 ICC rankings, field of India, Pakistan, Bangladesh, Nepal, UAE, Thailand, Malaysia, Japan. " +
  "This row's four Group-stage fixtures (16-18 Sep) name India, Japan, Pakistan, Thailand, Malaysia, Sri Lanka, Bangladesh, China — the two sources disagree about WHO IS PLAYING. " +
  "Check the official Asian Games schedule and replace whichever side is wrong.");

// ---- SA in Zimbabwe: restore format (five fixture rows exist) ----
const SZ = "south-africa-women-s-cricket-team-in-zimbabwe-in-2026";
set(SZ, "format", "Bilateral series · 5 matches between 2 nations");
set(SZ, "notes",
  "VERIFY (prose vs fixtures): prior-session research prose says 3 T20Is, 11-19 Sep 2026; this row has five fixtures ('Series match n of 5', 11-19 Sep) — the fixtures win until the official series announcement is checked. " +
  "High leverage for Zimbabwe either way: rating points against a top-five side, inside the women's ranking window.");

// ---- README: precedence rule + resolved PART 7 item ----
const lines = [
  "",
  "PRECEDENCE — structured rows with fixture children outrank prose. Prose from a prior chat",
  "session is a research artifact, not a source; it may itself be a paraphrase. It can raise a",
  "verification item in notes; it cannot overwrite dates, formats, fields or any other structured",
  "cell on a row that has fixtures behind it.",
  "",
  "RESOLVED (was open in handoff PART 7): the FIBA FOPQT pool arithmetic. The document said 27",
  "second-round teams miss the 2027 World Cup; the fixture data says 28 — 60 distinct second-round",
  "teams across the four regional qualifiers (Africa 12, Americas 12, Asia 12, Europe 24) against a",
  "32-team World Cup field. Derived by the validator's pool-preview check from second-round fixture",
  "participation; do not re-litigate from the document's 27.",
];
lines.forEach(line => {
  const n = rm.rowCount + 1;
  rm.getRow(n).getCell(1).value = line === "" ? null : line;
  if (line !== "") expected.push({ sheet: "README", key: `(line ${n})`, col: null, kind: "row-add" });
});

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v9.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes`);
