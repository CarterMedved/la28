/**
 * Second edit pass: v5 → v6.
 *   - Qualified gains hold_status column; existing 6 rows → SETTLED
 *   - New Zealand PROVISIONAL row (women's host-place fallback), note kept to
 *     sourcing — no conclusory "USA cannot reach top 15" clause
 *   - four cricket rows UNCONFIRMED → CONFIRMED, "(verify)" text dropped,
 *     India row notes the eligible-finisher rule
 *   - cri-006 confidence AMBIGUOUS → CONFIRMED
 *   - NZ's stored qualified_via/provisional cleared from Standings
 *   - README Qualified convention extended with hold_status
 * v5 is kept untouched as the audit trail of pass one.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v5.xlsx";
const OUT = "data/LA28_Qualification_Database_v6.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);

const q = wb.getWorksheet("Qualified");
const st = wb.getWorksheet("Standings");
const lk = wb.getWorksheet("Links");
const rm = wb.getWorksheet("README");

// ---- Qualified: hold_status column, existing rows SETTLED ----
{
  const c = q.columnCount + 1;
  q.getRow(1).getCell(c).value = "hold_status";
  q.getRow(1).getCell(c).style = { ...q.getRow(1).getCell(1).style };
  q.getColumn(c).width = 13;
  expected.push({ sheet: "Qualified", key: "(header)", col: "hold_status", kind: "col-add" });
  q.eachRow((r, n) => {
    if (n === 1) return;
    r.getCell(c).value = "SETTLED";
    expected.push({ sheet: "Qualified", key: `${r.getCell(1).value}#${r.getCell(2).value}`, col: "hold_status", kind: "cell" });
  });
}

// ---- Qualified: upgrade the four cricket rows to CONFIRMED ----
{
  const iEv = colIdx(q, "olympic_event_id"), iTeam = colIdx(q, "team"),
        iConf = colIdx(q, "confidence"), iNotes = colIdx(q, "notes");
  const GB_NOTE = "England's ICC results represent Great Britain; Scotland, Wales and NI cannot hold the quota place.";
  const NOTES = {
    "Australia": "ICC-confirmed continental qualifier (Oceania).",
    "Great Britain": `${GB_NOTE} ICC-confirmed continental qualifier (Europe).`,
    "India": "ICC-confirmed continental qualifier (Asia). Asia's place went to the highest-placed ELIGIBLE FINISHER, not a semi-finalist — India qualified despite going out before the semis.",
    "South Africa": "ICC-confirmed continental qualifier (Africa).",
  };
  q.eachRow((r, n) => {
    if (n === 1 || r.getCell(iEv).value !== "la28-cricket-w") return;
    const team = r.getCell(iTeam).value;
    r.getCell(iConf).value = "CONFIRMED";
    expected.push({ sheet: "Qualified", key: `la28-cricket-w#${team}`, col: "confidence", kind: "cell" });
    r.getCell(iNotes).value = NOTES[team];
    expected.push({ sheet: "Qualified", key: `la28-cricket-w#${team}`, col: "notes", kind: "cell" });
  });
}

// ---- Qualified: New Zealand PROVISIONAL row ----
// Source edge: cri-020, icc-womens-t20i-team-ranking -> la28-cricket-w
// (REALLOCATION, governed by icc-w-host-fallback). qualified_via must be a
// machine-readable id; the ranking_id is the berth's source.
{
  const row = q.addRow(["la28-cricket-w", "New Zealand", "icc-womens-t20i-team-ranking", null, "CONFIRMED",
    "Host-place fallback (cut-line icc-w-host-fallback, link cri-020): held by the highest-ranked non-qualified nation on the 31 Dec 2026 women's T20I ranking. Contestable until the cut-off.",
    "PROVISIONAL"]);
  void row;
  expected.push({ sheet: "Qualified", key: "la28-cricket-w#New Zealand", col: null, kind: "row-add" });
}

// ---- Standings: clear NZ stored qualified_via + provisional ----
{
  const iRid = colIdx(st, "ranking_id"), iTeam = colIdx(st, "team"),
        iVia = colIdx(st, "qualified_via"), iProv = colIdx(st, "provisional");
  st.eachRow((r, n) => {
    if (n > 1 && r.getCell(iRid).value === "icc-womens-t20i-team-ranking" && r.getCell(iTeam).value === "New Zealand") {
      r.getCell(iVia).value = null;
      expected.push({ sheet: "Standings", key: "icc-womens-t20i-team-ranking|New Zealand", col: "qualified_via", kind: "cell" });
      r.getCell(iProv).value = "N";   // derived from Qualified now; keep the column's N convention
      expected.push({ sheet: "Standings", key: "icc-womens-t20i-team-ranking|New Zealand", col: "provisional", kind: "cell" });
    }
  });
}

// ---- Links: cri-006 AMBIGUOUS → CONFIRMED ----
{
  const iL = colIdx(lk, "link_id"), iC = colIdx(lk, "confidence"), iN = colIdx(lk, "notes");
  lk.eachRow((r, n) => {
    if (n > 1 && r.getCell(iL).value === "cri-006") {
      r.getCell(iC).value = "CONFIRMED";
      expected.push({ sheet: "Links", key: "cri-006", col: "confidence", kind: "cell" });
      const cur = r.getCell(iN).value;
      r.getCell(iN).value = (cur ? String(cur).replace(/\s+$/, "") + " " : "") +
        "Resolved: ICC confirmed the four continental qualifiers (AUS Oceania, GBR via England Europe, IND Asia, RSA Africa); Asia's place went to the highest-placed eligible finisher.";
      expected.push({ sheet: "Links", key: "cri-006", col: "notes", kind: "cell" });
    }
  });
}

// ---- README: hold_status convention ----
const lines = [
  "",
  "Qualified.hold_status — SETTLED (blank means SETTLED) marks a filled place and derives",
  "Standings.already_qualified = Y. PROVISIONAL marks a contestable hold: it derives",
  "Standings.provisional = Y, never already_qualified, and is not counted against berth or quota",
  "capacity — a contestable hold is not a filled place. Every provisional holder in every sport is a",
  "Qualified row, so qualified_via always means the same thing regardless of hold state.",
];
lines.forEach(line => {
  const n = rm.rowCount + 1;
  rm.getRow(n).getCell(1).value = line === "" ? null : line;
  if (line !== "") expected.push({ sheet: "README", key: `(line ${n})`, col: null, kind: "row-add" });
});

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v6.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT}`);
console.log(`intended changes: ${expected.length} (${expected.filter(e => e.kind === "cell").length} cell edits, ` +
  `${expected.filter(e => e.kind === "row-add").length} row additions, ${expected.filter(e => e.kind === "col-add").length} column addition)`);
