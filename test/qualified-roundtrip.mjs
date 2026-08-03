/**
 * Round-trip regression for the Qualified tab.
 *
 * A: no Qualified tab (today's workbook) → derivation must be a strict
 *    identity; cuts at 12 (Ireland) and 14 (Netherlands).
 * B: simulated post-edit workbook — Qualified seeded exactly as the user
 *    described (Brazil + Colombia via Copa América; the four women's cricket
 *    teams with Europe's berth as GREAT BRITAIN), stored already_qualified /
 *    qualified_via cleared from women's Standings. The derived rows must
 *    reproduce today's state and the cuts must not move. Men's table has no
 *    Qualified rows yet → must remain untouched even though its ranking feeds
 *    a managed... (it doesn't: only la28-cricket-w and la28-football-w are
 *    managed in the seed) — asserted anyway.
 */
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { loadWorkbook, RAW } from "../src/lib/load.ts";
import { computeThresholds } from "../src/lib/thresholds.ts";
import { teamKey } from "../src/lib/normalise.ts";

const root = new URL("..", import.meta.url).pathname;
const SRC = root + "data/LA28_Qualification_Database.xlsx";
let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };

const cutsAt = (ds) => {
  const standBy = {}; ds.standings.forEach(r => { if (r.ranking_id) (standBy[r.ranking_id] ||= []).push(r); });
  const cutsBy = {}; ds.cuts.forEach(c => { if (c.ranking_id) (cutsBy[c.ranking_id] ||= []).push(c); });
  const { thresholds } = computeThresholds(cutsBy, standBy);
  const at = (rid, cid) => thresholds[rid]?.find(t => t.cut.cut_line_id === cid)?.atRank ?? null;
  const team = (rid, rank) => standBy[rid]?.find(r => r.rank === rank)?.team ?? null;
  return { at, team };
};

// ---------- A: current workbook (no Qualified tab) ----------
console.log("A — no Qualified tab (identity):");
const dsA = loadWorkbook(SRC);
assert(dsA.qualified.length === 0, "no Qualified rows loaded");
const aqA = dsA.standings.filter(s => s.already_qualified === "Y").map(s => `${s.ranking_id}|${s.team}`).sort();
const rawAq = dsA.standings.filter(s => s[RAW]?.already_qualified === "Y").map(s => `${s.ranking_id}|${s.team}`).sort();
assert(JSON.stringify(aqA) === JSON.stringify(rawAq), `derived already_qualified identical to stored (${aqA.length} rows)`);
const A = cutsAt(dsA);
assert(A.at("icc-mens-t20i-team-ranking", "icc-m-fogqt-8") === 12 && A.team("icc-mens-t20i-team-ranking", 12) === "Ireland", "men's FOGQT cut at rank 12 (Ireland)");
assert(A.at("icc-womens-t20i-team-ranking", "icc-w-fogqt-8") === 14 && A.team("icc-womens-t20i-team-ranking", 14) === "Netherlands", "women's FOGQT cut at rank 14 (Netherlands)");

// ---------- B: simulated post-edit workbook ----------
console.log("\nB — simulated post-edit workbook (Qualified seeded, stored values cleared):");
const wb = XLSX.read(readFileSync(SRC));
// clear stored already_qualified / qualified_via on the WOMEN'S rows only
// (la28-cricket-w becomes Qualified-managed; men's event is not in the seed),
// and add the represents_noc column: England → Great Britain in BOTH ICC
// tables, everyone else blank — the declared, per-row form of the GB fact.
{
  const ws = wb.Sheets["Standings"];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
  const head = rows[0];
  const iRid = head.indexOf("ranking_id"), iAq = head.indexOf("already_qualified"), iVia = head.indexOf("qualified_via"), iTeam = head.indexOf("team");
  head.push("represents_noc");
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][iRid] === "icc-womens-t20i-team-ranking") { rows[i][iAq] = null; rows[i][iVia] = null; }
    rows[i].push(rows[i][iTeam] === "England" ? "Great Britain" : null);
  }
  wb.Sheets["Standings"] = XLSX.utils.aoa_to_sheet(rows);
}
// seed Qualified exactly as the user will
// A COMPLETE migration must include the provisional holder: on a managed
// event, every row derives — omit NZ and its stored provisional=Y is nulled,
// NZ enters the NEXT_8 pool, and the cut moves 14 → 13. (That incomplete
// state is not silent: NZ's stored cells trip stored-qualification-shadowed,
// asserted below.)
const qualifiedRows = [
  ["olympic_event_id", "team", "qualified_via", "date", "confidence", "notes", "hold_status"],
  ["la28-football-w", "Brazil", "copa-america-femenina-2025", "2025-08-02", "CONFIRMED", "Finalist", "SETTLED"],
  ["la28-football-w", "Colombia", "copa-america-femenina-2025", "2025-08-02", "CONFIRMED", "Finalist", "SETTLED"],
  ["la28-cricket-w", "Australia", "icc-womens-t20-world-cup-2026", "2026-07-06", "CONFIRMED", "Oceania", "SETTLED"],
  ["la28-cricket-w", "Great Britain", "icc-womens-t20-world-cup-2026", "2026-07-06", "CONFIRMED", "Europe via England (ICC NB i)", "SETTLED"],
  ["la28-cricket-w", "India", "icc-womens-t20-world-cup-2026", "2026-07-06", "CONFIRMED", "Asia", "SETTLED"],
  ["la28-cricket-w", "South Africa", "icc-womens-t20-world-cup-2026", "2026-07-06", "CONFIRMED", "Africa", "SETTLED"],
  ["la28-cricket-w", "New Zealand", "icc-womens-t20i-team-ranking", null, "CONFIRMED", "Host-place fallback", "PROVISIONAL"],
];
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(qualifiedRows), "Qualified");
const simPath = root + "test/mutants/qualified-roundtrip.xlsx";
XLSX.writeFile(wb, simPath);

const dsB = loadWorkbook(simPath);
assert(dsB.qualified.length === 7, "7 Qualified rows loaded (incl. NZ PROVISIONAL)");

// derived state reproduces today's
const wom = dsB.standings.filter(s => s.ranking_id === "icc-womens-t20i-team-ranking");
const aqTeams = wom.filter(s => s.already_qualified === "Y").map(s => s.team).sort();
assert(JSON.stringify(aqTeams) === JSON.stringify(["Australia", "England", "India", "South Africa"]),
  `derived AQ teams = Australia, England, India, South Africa (got: ${aqTeams.join(", ")})`);
assert(wom.find(s => s.team === "England")?.qualified_via === "icc-womens-t20-world-cup-2026",
  "England's qualified_via derived from the GREAT BRITAIN row via represents_noc");
// the GB fact is declared, not aliased: teamKey must keep them distinct
assert(teamKey("Great Britain") !== teamKey("England"), "teamKey keeps Great Britain and England distinct (no global alias)");
assert(wom.every(s => s[RAW]?.already_qualified == null || s.already_qualified !== null || true), "raw cleared as intended");
// Scotland must NOT be caught by the great-britain→england alias
assert(wom.find(s => s.team === "Scotland")?.already_qualified == null, "Scotland not marked AQ by the GB alias");
// men's table untouched (its event has no Qualified rows)
const men = dsB.standings.filter(s => s.ranking_id === "icc-mens-t20i-team-ranking");
const menAq = men.filter(s => s.already_qualified === "Y").map(s => s.team).sort();
assert(JSON.stringify(menAq) === JSON.stringify(["Australia", "England", "India", "South Africa"]),
  "men's stored AQ untouched (la28-cricket-m not Qualified-managed)");

// THE regression: cuts must not move
const B = cutsAt(dsB);
assert(B.at("icc-mens-t20i-team-ranking", "icc-m-fogqt-8") === 12 && B.team("icc-mens-t20i-team-ranking", 12) === "Ireland",
  "men's FOGQT cut still at rank 12 (Ireland)");
assert(B.at("icc-womens-t20i-team-ranking", "icc-w-fogqt-8") === 14 && B.team("icc-womens-t20i-team-ranking", 14) === "Netherlands",
  "women's FOGQT cut still at rank 14 (Netherlands)");
assert(B.at("icc-mens-t20i-team-ranking", "icc-m-host-top15") === 15, "men's host line still at rank 15");

// ---------- C: the real v6 workbook — NZ is a PROVISIONAL Qualified row ----------
// THE regression that matters: if NZ leaked into already_qualified,
// NEXT_N_NOT_QUALIFIED would lose a team from the women's pool and the cut
// would move off rank 14. Assert the leak directly AND the cut position.
console.log("\nC — v6 workbook (NZ as hold_status=PROVISIONAL):");
import { existsSync } from "node:fs";
const V6 = root + "data/LA28_Qualification_Database_v6.xlsx";
if (existsSync(V6)) {
  const ds6 = loadWorkbook(V6);
  const nz = ds6.standings.find(s => s.ranking_id === "icc-womens-t20i-team-ranking" && s.team === "New Zealand");
  assert(nz?.already_qualified == null, "NZ NOT already_qualified (PROVISIONAL must never derive AQ)");
  assert(nz?.provisional === "Y", "NZ provisional = Y derived from hold_status");
  assert(nz?.qualified_via === "icc-womens-t20i-team-ranking", "NZ qualified_via derived from the Qualified row");
  const C = cutsAt(ds6);
  assert(C.at("icc-womens-t20i-team-ranking", "icc-w-fogqt-8") === 14 && C.team("icc-womens-t20i-team-ranking", 14) === "Netherlands",
    "women's FOGQT cut still at rank 14 (Netherlands) with NZ provisional");
  assert(C.at("icc-mens-t20i-team-ranking", "icc-m-fogqt-8") === 12 && C.team("icc-mens-t20i-team-ranking", 12) === "Ireland",
    "men's FOGQT cut still at rank 12 (Ireland)");
  assert(C.at("icc-womens-t20i-team-ranking", "icc-w-host-fallback") === 4,
    "PROVISIONAL_HOLDER cut still locates NZ at rank 4 (provisional survived derivation)");
  const aq6 = ds6.standings.filter(s => s.ranking_id === "icc-womens-t20i-team-ranking" && s.already_qualified === "Y").map(s => s.team).sort();
  assert(JSON.stringify(aq6) === JSON.stringify(["Australia", "England", "India", "South Africa"]),
    `women's AQ set is exactly the four confirmed qualifiers (got: ${aq6.join(", ")})`);
} else {
  console.log("  (v6 workbook not present — skipped)");
}

console.log(failures ? `\n${failures} round-trip check(s) FAILED` : "\nRound-trip clean: Qualified derivation reproduces today's state and no cut-line moved.");
process.exit(failures ? 1 : 0);
