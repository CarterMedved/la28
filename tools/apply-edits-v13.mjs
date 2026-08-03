/**
 * Ninth edit pass: v12 → v13. FIBA men's standings (top 100 of 154) +
 * TOP_N_OF_POOL wiring + the fopqt-7 leads_to remodel.
 *
 * leads_to remodel (the known-issues entry's deferred decision, due now):
 * the 7 ranking places fan out to FOUR FOPQTs, and leads_to is single-valued.
 * Four per-region cut-lines would be WRONG — the 7 places are shared across
 * regions, not split (bkb-014's own qualifiers_note). So: one umbrella
 * competition, properly linked (ranking → umbrella ×1 carrying the 7,
 * umbrella → each FOPQT ×4 for the regional fan-out), replacing the four
 * direct ranking → FOPQT links. leads_to points at the umbrella.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v12.xlsx";
const OUT = "data/LA28_Qualification_Database_v13.xlsx";
const UMB = "fiba-olympic-pre-qualifying-tournaments-2027";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);
const rowBy = (ws, keyCol, keyVal) => {
  const i = colIdx(ws, keyCol);
  let hit = null, hitN = null;
  ws.eachRow((r, n) => { if (n > 1 && r.getCell(i).value === keyVal) { hit = r; hitN = n; } });
  if (!hit) throw new Error(`no row ${keyVal} in ${ws.name}`);
  return { row: hit, n: hitN };
};
const set = (ws, keyCol, keyVal, col, value) => {
  const cell = rowBy(ws, keyCol, keyVal).row.getCell(colIdx(ws, col));
  if ((cell.value == null ? null : String(cell.value)) === (value == null ? null : String(value))) return;
  cell.value = value;
  expected.push({ sheet: ws.name, key: keyVal, col, kind: "cell" });
};

const cp = wb.getWorksheet("Competitions");
const lk = wb.getWorksheet("Links");
const st = wb.getWorksheet("Standings");
const rs = wb.getWorksheet("Ranking_Systems");
const cl = wb.getWorksheet("Cut_Lines");

// ---- 1. Standings: 100 rows ----
const DATA = `1 USA 920.7 Americas|2 Germany 843.6 Europe|3 Serbia 836.6 Europe|4 France 836 Europe|5 Canada 831.4 Americas|6 Spain 798.1 Europe|7 Australia 796.8 Asia|8 Argentina 783.1 Americas|9 Brazil 776.6 Americas|10 Lithuania 773.7 Europe|11 Türkiye 770.6 Europe|12 Latvia 759.4 Europe|13 Greece 756.2 Europe|14 Slovenia 728 Europe|15 Italy 721.4 Europe|16 Puerto Rico 676.5 Americas|17 Finland 676 Europe|18 Montenegro 647.2 Europe|19 Poland 622.7 Europe|20 Georgia 580.8 Europe|21 Dominican Rep 571.5 Americas|22 Japan 526.2 Asia|23 Czechia 521.9 Europe|24 South Sudan 497.5 Africa|25 New Zealand 492 Asia|26 Iran 455.7 Asia|27 Venezuela 455 Americas|28 Mexico 448.5 Americas|29 Israel 447.9 Europe|30 China 446.4 Asia|31 Lebanon 442.6 Asia|32 Angola 441.7 Africa|33 Bosnia and Herz. 437.6 Europe|34 Croatia 428.7 Europe|35 Belgium 406.7 Europe|36 Estonia 386.3 Europe|37 Cote d'Ivoire 384.2 Africa|38 Ukraine 376.9 Europe|39 Philippines 376 Asia|40 Sweden 375.9 Europe|41 Jordan 370.7 Asia|42 Uruguay 346.2 Americas|43 Egypt 345.3 Africa|44 Iceland 342.7 Europe|45 Portugal 342.3 Europe|46 Great Britain 339.2 Europe|47 Hungary 333.5 Europe|48 Senegal 323.2 Africa|49 Bahamas 312.1 Americas|50 Cape Verde 305.2 Africa|51 Tunisia 303.1 Africa|52 Netherlands 298.7 Europe|53 Nigeria 298 Africa|54 Colombia 293.7 Americas|55 Bulgaria 269.2 Europe|56 Panama 268 Americas|57 Korea 264.1 Asia|58 Cameroon 260.6 Africa|59 Denmark 255.4 Europe|60 Chile 248.4 Americas|61 Switzerland 247 Europe|62 Romania 243.4 Europe|63 Mali 231.5 Africa|64 North Macedonia 230.9 Europe|65 Saudi Arabia 228.4 Asia|66 Austria 226.5 Europe|67 Cuba 210.9 Americas|68 Chinese Taipei 210 Asia|69 Cyprus 207.3 Europe|70 Slovakia 205.1 Europe|71 Guinea 193.3 Africa|72 Congo DR 187.3 Africa|73 Nicaragua 185.6 Americas|74 Syria 183.8 Asia|75 India 170.8 Asia|76 Qatar 169.3 Asia|77 Guam 160.2 Asia|78 Jamaica 157.7 Americas|79 Uganda 154.8 Africa|80 Bahrain 151.3 Asia|81 Iraq 149.5 Asia|82 Rwanda 148.1 Africa|83 Ireland 144.8 Europe|84 Norway 144.4 Europe|85 Costa Rica 140.2 Americas|86 Kazakhstan 137.7 Asia|87 Luxembourg 135.6 Europe|88 Kosovo 133.8 Europe|89 Libya 133.2 Africa|90 Madagascar 126.8 Africa|91 Virgin Islands 124.8 Americas|92 Armenia 119.5 Europe|93 Paraguay 116.6 Americas|94 Indonesia 112.3 Asia|95 Albania 108.5 Europe|96 Andorra 106.9 Europe|97 Thailand 105.1 Asia|98 Central African Rep 104.1 Africa|99 Azerbaijan 103 Europe|100 Malta 102.8 Europe`;
const rows = DATA.split("|").map(s => {
  const m = s.match(/^(\d+) (.+) ([\d.]+) (Americas|Europe|Asia|Africa)$/);
  if (!m) throw new Error("bad row: " + s);
  return { rank: Number(m[1]), team: m[2], rating: Number(m[3]), continent: m[4] };
});
if (rows.length !== 100) throw new Error(`parsed ${rows.length} rows, expected 100`);
{
  const head = st.getRow(1).values;
  for (const r of rows) {
    const row = new Array(head.length - 1).fill(null);
    const put = (col, v) => row[head.indexOf(col) - 1] = v;
    put("ranking_id", "fiba-mens-world-ranking");
    put("rank", r.rank); put("team", r.team); put("continent", r.continent);
    put("rating", r.rating);
    put("olympic_eligible", "Y");
    put("as_of", "2026-07-13");
    put("source_url", "https://www.fiba.basketball/en/ranking/men");
    put("confidence", "CONFIRMED");
    st.addRow(row);
    expected.push({ sheet: "Standings", key: `fiba-mens-world-ranking|${r.team}`, col: null, kind: "row-add" });
  }
}

// ---- 2. Ranking_Systems row ----
set(rs, "ranking_id", "fiba-mens-world-ranking", "standings_url", "https://www.fiba.basketball/en/ranking/men");
set(rs, "ranking_id", "fiba-mens-world-ranking", "feeds_id", UMB);
set(rs, "ranking_id", "fiba-mens-world-ranking", "points_notes",
  "PRIMARY entry criterion, unlike the women's list. The March 2027 ranking awards 7 of the 34 FOPQT places outright — to the highest-ranked teams in the FOPQT ranking pool (did NOT reach the WC qualifiers' second round; see README terminology). " +
  "MODEL REPLACED Nov 2025 (Assist Research): game-based, points added every game and never subtracted, wins worth more, updated after each Qualifiers window — anything assuming the 2017-2025 model is stale. " +
  "Model docs: how-it-works, FAQ and detailed-examples PDFs linked from the ranking page. Snapshots: 15 Sep 2025, 2 Dec 2025, 3 Mar 2026, 13 Jul 2026; next lands after the 24 Aug-1 Sep 2026 window. " +
  "Captured to rank 100 of 154; ALL captured rows are NOCs, but the uncaptured tail is NOT uniformly eligible (Macau 145, Tahiti 134, New Caledonia 153 are not NOCs) — if the tail is ever captured, olympic_eligible stops being uniformly Y.");

// ---- 3. leads_to remodel: umbrella comp + link surgery ----
{
  const head = cp.getRow(1).values;
  const row = new Array(head.length - 1).fill(null);
  const put = (col, v) => row[head.indexOf(col) - 1] = v;
  put("competition_id", UMB);
  put("name", "FIBA Men's Olympic Pre-Qualifying Tournaments 2027 (allocation umbrella)");
  put("sport", "Basketball"); put("gender", "M"); put("confederation", "GLOBAL");
  put("start_date", "2027-08-14"); put("end_date", "2027-08-22");
  put("date_confidence", "CONFIRMED"); put("status", "SCHEDULED");
  put("format", "34 teams · four tournaments (Africa 6, Americas 6, Asia 6, Europe 2×8)");
  put("notes",
    "Allocation umbrella for the four regional FOPQTs — exists because the 7 ranking places are awarded across ALL four tournaments (not per region), so the ranking edge and cut-line fiba-m-fopqt-7 need a single target. " +
    "Tournament-route entrants go directly to their regional FOPQT (bkb-013/016/019/022); only the ranking-allocated 7 pass through here, distributed to their region's tournament.");
  cp.addRow(row);
  expected.push({ sheet: "Competitions", key: UMB, col: null, kind: "row-add" });
}
{
  // delete the four direct ranking → FOPQT links
  const iL = colIdx(lk, "link_id");
  for (const lid of ["bkb-014", "bkb-017", "bkb-020", "bkb-023"]) {
    const { n } = rowBy(lk, "link_id", lid);
    lk.spliceRows(n, 1);
    expected.push({ sheet: "Links", key: lid, col: null, kind: "row-del" });
  }
  const lh = lk.getRow(1).values;
  const addLink = (lid, from, to, rel, qualifiers, qnote, criterion, cutId) => {
    const row = new Array(lh.length - 1).fill(null);
    const put = (col, v) => row[lh.indexOf(col) - 1] = v;
    put("link_id", lid); put("from_id", from);
    put("from_type", from === "fiba-mens-world-ranking" ? "RANKING" : "COMPETITION");
    put("to_id", to); put("to_type", "COMPETITION");
    put("relationship", rel); put("qualifiers", qualifiers); put("qualifiers_note", qnote);
    put("criterion", criterion); put("cut_line_id", cutId ?? null);
    put("confidence", "FROM_IOC_DOC");
    lk.addRow(row);
    expected.push({ sheet: "Links", key: lid, col: null, kind: "row-add" });
  };
  addLink("bkb-041", "fiba-mens-world-ranking", UMB, "RANKING_TO_EVENT", 7, null,
    "The 7 highest-ranked teams on the March 2027 FIBA ranking among those that did NOT reach the WC qualifiers' second round (the FOPQT ranking pool)", "fiba-m-fopqt-7");
  const FANOUT = "Ranking-allocated teams play the FOPQT of their own region; how the 7 split across regions depends on who they are, so no fixed count exists per tournament.";
  addLink("bkb-042", UMB, "fiba-olympic-pre-qualifying-tournament-2027-for-africa", "ADVANCE", null, FANOUT, "Ranking-allocated African teams enter here", null);
  addLink("bkb-043", UMB, "fiba-olympic-pre-qualifying-tournament-2027-for-americas", "ADVANCE", null, FANOUT, "Ranking-allocated Americas teams enter here", null);
  addLink("bkb-044", UMB, "fiba-olympic-pre-qualifying-tournament-2027-for-asia", "ADVANCE", null, FANOUT, "Ranking-allocated Asian-zone teams enter here", null);
  addLink("bkb-045", UMB, "two-fiba-olympic-pre-qualifying-tournaments-2027-for-europe", "ADVANCE", null, FANOUT, "Ranking-allocated European teams enter here", null);
}
set(cl, "cut_line_id", "fiba-m-fopqt-7", "leads_to", UMB);

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v13.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes ` +
  `(${expected.filter(e => e.kind === "cell").length} cell, ${expected.filter(e => e.kind === "row-add").length} row-adds, ${expected.filter(e => e.kind === "row-del").length} row-dels)`);
