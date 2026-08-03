/**
 * Apply the user's edit pass to a COPY of the workbook. The source stays
 * read-only; output goes to data/LA28_Qualification_Database_v5.xlsx.
 * Every edit is recorded in EXPECTED so the diff tool can prove the changed
 * set equals the intended set exactly.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database.xlsx";
const OUT = "data/LA28_Qualification_Database_v5.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);

const expected = [];   // {sheet, key, col, kind: 'cell'|'row-del'|'row-add'|'col-add'}
const log = [];

const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);
const rowOf = (ws, col, value) => {
  const i = colIdx(ws, col);
  let hit = null;
  ws.eachRow((r, n) => { if (n > 1 && r.getCell(i).value === value) hit = r; });
  if (!hit) throw new Error(`no row in ${ws.name} where ${col} = ${value}`);
  return hit;
};
const setCell = (ws, keyCol, keyVal, col, value) => {
  const r = rowOf(ws, keyCol, keyVal);
  r.getCell(colIdx(ws, col)).value = value;
  expected.push({ sheet: ws.name, key: keyVal, col, kind: "cell" });
};
const appendNotes = (ws, keyVal, text) => {
  const r = rowOf(ws, "competition_id", keyVal);
  const i = colIdx(ws, "notes");
  const cur = r.getCell(i).value;
  r.getCell(i).value = (cur ? String(cur).replace(/\s+$/, "") + " " : "") + text;
  expected.push({ sheet: ws.name, key: keyVal, col: "notes", kind: "cell" });
};

const cp = wb.getWorksheet("Competitions");
const st = wb.getWorksheet("Standings");
const fx = wb.getWorksheet("Fixtures");
const rm = wb.getWorksheet("README");

// ---- 1. COMPLETE → SCHEDULED ----
for (const id of ["2026-fiba-women-s-basketball-world-cup",
                  "2026-fiba-women-s-olympic-pre-qualifying-tournament",
                  "fiba-women-s-americup-2027-south-american-qualifier"])
  setCell(cp, "competition_id", id, "status", "SCHEDULED");

// ---- 2. WC-qualification true start dates + capture note ----
const CAPTURE_NOTE = "Only second-round windows 4-6 captured in Fixtures; windows 1-3 (Nov 2025, Feb 2026, Jun-Jul 2026) not entered.";
for (const id of ["2027-fiba-basketball-world-cup-qualification-africa",
                  "2027-fiba-basketball-world-cup-qualification-americas",
                  "2027-fiba-basketball-world-cup-qualification-asia",
                  "2027-fiba-basketball-world-cup-qualification-europe"]) {
  setCell(cp, "competition_id", id, "start_date", "2025-11-24");
  appendNotes(cp, id, CAPTURE_NOTE);
}
// Africa Window 5 open question — appended to the SAME notes cell (one change)
{
  const r = rowOf(cp, "competition_id", "2027-fiba-basketball-world-cup-qualification-africa");
  const i = colIdx(cp, "notes");
  r.getCell(i).value = String(r.getCell(i).value) +
    " OPEN QUESTION: FIBA's second round runs windows 4-6 (Window 5 = 23 Nov-1 Dec 2026), but Africa's 36 fixtures sit 18 in late Aug 2026 and 18 in late Feb 2027 with none in November. The pair set is complete (two groups of six, carry-over, home and away), so nothing is missing — but ~12 fixtures may carry the wrong window's dates. Verify against FIBA's schedule before trusting individual fixture dates.";
  // no new expected entry — same cell as the CAPTURE_NOTE append above
}

// ---- 3. UNANNOUNCED + TBD ----
for (const id of ["eurobasket-women-2027-qualification", "fiba-women-s-afrobasket-2027-qualifiers"]) {
  setCell(cp, "competition_id", id, "status", "UNANNOUNCED");
  setCell(cp, "competition_id", id, "date_confidence", "TBD");
}

// ---- do-not-guess list: eurobasket-2029 date_confidence → TBD ----
setCell(cp, "competition_id", "fiba-eurobasket-2029-pre-qualifiers-second-round", "date_confidence", "TBD");

// ---- 4. delete the 16 "Not yet drawn" fixtures (bottom-up) ----
{
  const iStage = colIdx(fx, "stage"), iFid = colIdx(fx, "fixture_id");
  const doomed = [];
  fx.eachRow((r, n) => { if (n > 1 && r.getCell(iStage).value === "Not yet drawn") doomed.push({ n, fid: r.getCell(iFid).value }); });
  for (const d of doomed.sort((a, b) => b.n - a.n)) {
    fx.spliceRows(d.n, 1);
    expected.push({ sheet: "Fixtures", key: d.fid, col: null, kind: "row-del" });
  }
  log.push(`deleted fixtures: ${doomed.map(d => d.fid).sort().join(", ")}`);
}

// ---- 5. CONCACAF U-20 off-by-one ----
setCell(cp, "competition_id", "2026-concacaf-u-20-championship", "start_date", "2026-07-24");

// ---- 6. AFC Women's Asian Cup dates + outcome note ----
setCell(cp, "competition_id", "afc-womens-asian-cup-2026", "start_date", "2026-03-01");
setCell(cp, "competition_id", "afc-womens-asian-cup-2026", "end_date", "2026-03-21");
setCell(cp, "competition_id", "afc-womens-asian-cup-2026", "date_confidence", "CONFIRMED");
appendNotes(cp, "afc-womens-asian-cup-2026",
  "Japan champions, Australia runners-up, China and South Korea losing semi-finalists. Remaining four quarter-finalists not yet identified.");

// ---- 7. AFC W OQT year slip ----
setCell(cp, "competition_id", "afc-w-oqt-2028", "end_date", "2028-03-04");

// ---- 8. caf-w-oqt-2028-r2 notes reword ----
setCell(cp, "competition_id", "caf-w-oqt-2028-r2", "notes",
  "32 teams in 16 ties: the 3 first-round winners join the 29 teams that received byes — the byes include the 3 highest-ranked (Nigeria, South Africa, Ghana). 29 + 3 = 32. 16 winners advance. 35 nations entered; all ties home-and-away. Round 2 of 5.");

// ---- 9. Standings: represents_noc column ----
{
  const newCol = st.columnCount + 1;
  const header = st.getRow(1).getCell(newCol);
  header.value = "represents_noc";
  header.style = { ...st.getRow(1).getCell(newCol - 1).style };   // match header styling
  expected.push({ sheet: "Standings", key: "(header)", col: "represents_noc", kind: "col-add" });
  const iTeam = colIdx(st, "team"), iRid = colIdx(st, "ranking_id");
  st.eachRow((r, n) => {
    if (n > 1 && r.getCell(iTeam).value === "England") {
      r.getCell(newCol).value = "Great Britain";
      expected.push({ sheet: "Standings", key: `${r.getCell(iRid).value}|England`, col: "represents_noc", kind: "cell" });
    }
  });
}

// ---- 10. Qualified tab ----
// qualified_via must be a machine-readable competition_id (the tab's own
// schema). The verbatim Standings text — "Direct place, Women's T20 World Cup
// 2026 (verify)" — is a label; it is carried into notes verbatim, its (verify)
// flag becomes confidence UNCONFIRMED, and the id it names is
// icc-womens-t20-world-cup-2026. Copa rows date from the copa end_date.
const viaVerbatim = {};
{
  const iRid = colIdx(st, "ranking_id"), iTeam = colIdx(st, "team"), iVia = colIdx(st, "qualified_via");
  st.eachRow((r, n) => {
    if (n > 1 && r.getCell(iRid).value === "icc-womens-t20i-team-ranking" && r.getCell(iVia).value != null)
      viaVerbatim[r.getCell(iTeam).value] = String(r.getCell(iVia).value);
  });
}
const copaEnd = String(rowOf(cp, "competition_id", "copa-america-femenina-2025").getCell(colIdx(cp, "end_date")).value);
const t20End = String(rowOf(cp, "competition_id", "icc-womens-t20-world-cup-2026").getCell(colIdx(cp, "end_date")).value);
const GB_NOTE = "England's ICC results represent Great Britain; Scotland, Wales and NI cannot hold the quota place.";
const qRows = [
  ["la28-football-w", "Brazil", "copa-america-femenina-2025", copaEnd, "CONFIRMED", null],
  ["la28-football-w", "Colombia", "copa-america-femenina-2025", copaEnd, "CONFIRMED", null],
  ["la28-cricket-w", "Australia", "icc-womens-t20-world-cup-2026", t20End, "UNCONFIRMED", `Carried from Standings: "${viaVerbatim["Australia"]}"`],
  ["la28-cricket-w", "Great Britain", "icc-womens-t20-world-cup-2026", t20End, "UNCONFIRMED", `${GB_NOTE} Carried from Standings (England row): "${viaVerbatim["England"]}"`],
  ["la28-cricket-w", "India", "icc-womens-t20-world-cup-2026", t20End, "UNCONFIRMED", `Carried from Standings: "${viaVerbatim["India"]}"`],
  ["la28-cricket-w", "South Africa", "icc-womens-t20-world-cup-2026", t20End, "UNCONFIRMED", `Carried from Standings: "${viaVerbatim["South Africa"]}"`],
];
{
  const q = wb.addWorksheet("Qualified", { views: [{ state: "frozen", xSplit: 1, ySplit: 1 }] });
  const head = ["olympic_event_id", "team", "qualified_via", "date", "confidence", "notes"];
  q.addRow(head);
  head.forEach((_, i) => { q.getRow(1).getCell(i + 1).style = { ...st.getRow(1).getCell(1).style }; });
  q.getColumn(1).width = 22; q.getColumn(2).width = 16; q.getColumn(3).width = 30;
  q.getColumn(4).width = 12; q.getColumn(5).width = 13; q.getColumn(6).width = 60;
  qRows.forEach(r => q.addRow(r));
  expected.push({ sheet: "Qualified", key: "(tab)", col: null, kind: "tab-add" });
  qRows.forEach(r => expected.push({ sheet: "Qualified", key: `${r[0]}#${r[1]}`, col: null, kind: "row-add" }));
}

// ---- 11. clear the four women's stored AQ/via cells ----
{
  const iRid = colIdx(st, "ranking_id"), iTeam = colIdx(st, "team"),
        iAq = colIdx(st, "already_qualified"), iVia = colIdx(st, "qualified_via");
  st.eachRow((r, n) => {
    if (n > 1 && r.getCell(iRid).value === "icc-womens-t20i-team-ranking" && r.getCell(iAq).value === "Y") {
      const team = r.getCell(iTeam).value;
      r.getCell(iAq).value = null;
      r.getCell(iVia).value = null;
      expected.push({ sheet: "Standings", key: `icc-womens-t20i-team-ranking|${team}`, col: "already_qualified", kind: "cell" });
      expected.push({ sheet: "Standings", key: `icc-womens-t20i-team-ranking|${team}`, col: "qualified_via", kind: "cell" });
    }
  });
}

// ---- 12. README conventions ----
const readmeLines = [
  "",
  "CONVENTIONS (added 2 Aug 2026):",
  "start_date / end_date — always the competition's TRUE start and end, from the official schedule,",
  "even when earlier rounds' fixtures aren't captured in Fixtures. The start of the captured segment",
  "is never stored: it is derivable as the earliest fixture date, and the validator warns when stored",
  "dates and fixtures disagree (fixtures-before-start, missing-earlier-rounds). If only later rounds",
  "are captured, say so in notes.",
  "",
  "Qualified — the single source for settled berths, for any sport, ranking or not. Columns:",
  "olympic_event_id · team · qualified_via (competition_id) · date · confidence · notes. team is the",
  "NOC (Great Britain, not England — note why in notes). Once an event has any Qualified row, the",
  "loader derives Standings.already_qualified and .qualified_via from this tab for every ranking",
  "feeding that event, and stored values in those Standings columns are dead cells the validator",
  "flags. Do not store both.",
  "",
  "Standings.represents_noc — set when a ranked team holds a berth on behalf of a different NOC",
  "(England → Great Britain in both ICC tables). Directional and per-row: the Qualified join matches",
  "on team OR represents_noc, so a Qualified row naming Great Britain reaches England's standings row",
  "without teaching the global name normaliser that GB and England are the same team — in football",
  "they are not. Leave blank for Scotland (already olympic_eligible = N) and West Indies (no NOC; the",
  "Caribbean Qualifier exists precisely because of that).",
];
readmeLines.forEach((line) => {
  const n = rm.rowCount + 1;
  rm.getRow(n).getCell(1).value = line === "" ? null : line;
  // blank separator lines hold no value and are invisible to a cell diff —
  // only non-empty lines are expected observable changes
  if (line !== "") expected.push({ sheet: "README", key: `(line ${n})`, col: null, kind: "row-add" });
});

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes.json", JSON.stringify({ expected, qRows }, null, 1));
console.log(`written ${OUT}`);
console.log(`intended changes: ${expected.length} (${expected.filter(e => e.kind === "cell").length} cell edits, ` +
  `${expected.filter(e => e.kind === "row-del").length} row deletions, ${expected.filter(e => e.kind === "row-add").length} row additions, ` +
  `${expected.filter(e => e.kind === "col-add").length} column addition, ${expected.filter(e => e.kind === "tab-add").length} new tab)`);
log.forEach(l => console.log(l));
console.log("\nQualified rows as written:");
qRows.forEach(r => console.log("  " + r.map(v => v ?? "—").join(" | ")));
