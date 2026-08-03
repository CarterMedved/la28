/**
 * Sixth edit pass: v9 → v10. Men's essay triage per the agreed plan:
 *  - host-test ambiguity upgraded to a three-reading flag on the cut-line
 *  - four bilateral VERIFY notes (multi-format-tour reframing, no cell writes)
 *  - Asian Games men's VERIFY note (Games window ≠ cricket window)
 *  - regional-finals umbrella row + men's associate umbrella, with links
 *  - the five essay notes cells cleared
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v9.xlsx";
const OUT = "data/LA28_Qualification_Database_v10.xlsx";

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
  rowBy(ws, keyCol, keyVal).getCell(colIdx(ws, col)).value = value;
  expected.push({ sheet: ws.name, key: keyVal, col, kind: "cell" });
};

const cp = wb.getWorksheet("Competitions");
const lk = wb.getWorksheet("Links");
const cl = wb.getWorksheet("Cut_Lines");

// ---- 1. host-test: three readings, sourced, with blast radius ----
set(cl, "cut_line_id", "icc-m-host-top15", "notes",
  "USA ONLY. AMBIGUOUS — the contradiction is inside the ICC's own output; THREE readings: " +
  '(1) "any time during the window" (30 Jun-31 Dec 2026) — ICC release "Qualification and Format Confirmed", Olympics.com, Wikipedia, Business Standard; ' +
  '(2) "at the 31 Dec 2026 cut-off" — ICC Women\'s T20 WC news page, InsideTheGames; ' +
  '(3) "remain in the top 15 until 31 Dec" (continuous) — The National. ' +
  "USA men (13th on 30 Jun, the window's first day) already satisfy (1) and probably (2); only (3) is at risk. Section D.2/H supports (1) but is not decisive. " +
  "BLAST RADIUS: host place only — the USA are outside the FOGQT pool either way, so the Qualifier cut stays at Ireland/12. " +
  "USA 13th on 183, 3 points clear of Netherlands (180); 16th place uncaptured, true margin unknown.");

// ---- 2. four bilaterals: VERIFY notes, no cell writes ----
const TOUR_NOTE = (proseWindow) =>
  `VERIFY: prior-session prose gives the window as ${proseWindow} — likely the full multi-format tour (Tests + ODIs + T20Is); this row models the T20I leg only, which is the only part that accrues T20I ranking points. Verify against the official itinerary.`;
set(cp, "competition_id", "sri-lankan-cricket-team-in-england-in-2026", "notes", TOUR_NOTE("15-27 Sep 2026"));
set(cp, "competition_id", "indian-cricket-team-in-bangladesh-in-2026", "notes", TOUR_NOTE("1-13 Sep 2026"));
set(cp, "competition_id", "west-indian-cricket-team-in-india-in-202627", "notes", TOUR_NOTE("27 Sep-17 Oct 2026"));
set(cp, "competition_id", "bangladeshi-cricket-team-in-south-africa-in-202627", "notes", TOUR_NOTE("15 Nov-13 Dec 2026"));

// ---- 3. Asian Games men's: VERIFY note only, with the why ----
set(cp, "competition_id", "cricket-at-the-2026-asian-games-men-s-tournament", "notes",
  "VERIFY: start = end = 2026-09-24 is a placeholder. Prior-session prose says 19 Sep-4 Oct 2026 (Aichi-Nagoya) — but that is the window of the ENTIRE Asian Games, not the cricket tournament: the women's cricket fixtures (16-18 Sep) would predate a 19 Sep start, so the range was not adopted. " +
  "Prose's own caveat — matches count only IF they carry T20I status, as at previous editions — means Olympic materiality is unresolved even once dates are known. Confirm the men's cricket schedule and T20I status from the official Asian Games programme.");

// ---- 4. umbrella rows + links ----
{
  const head = cp.getRow(1).values;
  const addComp = (id, name, gender, notes) => {
    const row = new Array(head.length - 1).fill(null);
    const put = (col, v) => row[head.indexOf(col) - 1] = v;
    put("competition_id", id); put("name", name); put("sport", "Cricket"); put("gender", gender);
    put("status", "UNANNOUNCED"); put("date_confidence", "TBD"); put("confidence", "UNCONFIRMED");
    put("notes", notes);
    cp.addRow(row);
    expected.push({ sheet: "Competitions", key: id, col: null, kind: "row-add" });
  };
  addComp("2028-t20-world-cup-regional-finals-m", "2028 T20 World Cup regional finals (umbrella)", "M",
    "Umbrella for five regional finals with unpublished dates: Europe (Netherlands, Scotland, Italy), Africa (Namibia), Asia (Nepal, Oman, UAE), EAP (PNG), Americas (USA, Canada, Cayman Islands). " +
    "Multi-match T20Is between bubble teams — the single biggest ranking event for the Netherlands/Scotland/Ireland fight IF any land before 31 Dec 2026; if they slip to 2027 they are Olympically irrelevant (last cycle's regional finals fell ~4-8 months before the World Cup). " +
    "UNCONFIRMED, from prior-session research prose. Split into five rows the moment dates publish and any land inside the window.");
  addComp("2026-27-mens-associate-t20i-series", "2026-27 men's associate T20I series (umbrella)", "M",
    "Tri- and quadrangular series and tours expected from ~Oct 2026 — the main route for associate bubble sides (Netherlands, Scotland, Namibia, Nepal, UAE, Oman, Canada) to earn rating points. " +
    "UNCONFIRMED umbrella row from prior-session research prose (mirror of the women's row); split into individual series as schedules are announced.");

  const lh = lk.getRow(1).values;
  const addLink = (lid, from) => {
    const row = new Array(lh.length - 1).fill(null);
    const put = (col, v) => row[lh.indexOf(col) - 1] = v;
    put("link_id", lid); put("from_id", from); put("from_type", "COMPETITION");
    put("to_id", "icc-mens-t20i-team-ranking"); put("to_type", "RANKING");
    put("relationship", "RANKING_POINTS");
    put("criterion", "T20I matches award rating points toward the men's ranking");
    put("confidence", "UNCONFIRMED");
    lk.addRow(row);
    expected.push({ sheet: "Links", key: lid, col: null, kind: "row-add" });
  };
  addLink("cri-024", "2028-t20-world-cup-regional-finals-m");
  addLink("cri-025", "2026-27-mens-associate-t20i-series");
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v10.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes ` +
  `(${expected.filter(e => e.kind === "cell").length} cell, ${expected.filter(e => e.kind === "row-add").length} rows)`);
