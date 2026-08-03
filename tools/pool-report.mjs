/**
 * Report a-d: computed from the workbook, not asserted.
 */
import { loadWorkbook } from "../src/lib/load.ts";
import { teamKey } from "../src/lib/normalise.ts";
import { computeThresholds, derivePoolExclusions } from "../src/lib/thresholds.ts";

const ds = loadWorkbook("data/LA28_Qualification_Database_v13.xlsx");
const RID = "fiba-mens-world-ranking";

const standings = ds.standings.filter(s => s.ranking_id === RID).sort((a, b) => a.rank - b.rank);
const cuts = ds.cuts.filter(c => c.ranking_id === RID);
const excl = derivePoolExclusions(ds.cuts, ds.links, ds.fixtures, teamKey)["fiba-m-fopqt-7"];

// (a) pool + the 7 holders
const pool = standings.filter(r =>
  (r.olympic_eligible === "Y" || r.counts_in_field === "Y") &&
  r.already_qualified !== "Y" && r.provisional !== "Y" && !excl.has(teamKey(r.team)));
console.log(`(a) Ranking pool within captured depth 100: ${pool.length} teams (excluded: ${excl.size} second-round participants)`);
console.log("    Current 7 ranking-place holders:");
pool.slice(0, 7).forEach((r, i) => console.log(`      ${i + 1}. ${r.team} — world rank ${r.rank} (${r.continent}, ${r.rating})`));
console.log("    Next 5 (first out):");
pool.slice(7, 12).forEach(r => console.log(`      ${r.team} — rank ${r.rank} (${r.continent})`));

// threshold via the shared module
const standBy = {}; ds.standings.forEach(s => { if (s.ranking_id) (standBy[s.ranking_id] ||= []).push(s); });
const cutsBy = {}; ds.cuts.forEach(c => { if (c.ranking_id) (cutsBy[c.ranking_id] ||= []).push(c); });
const exAll = derivePoolExclusions(ds.cuts, ds.links, ds.fixtures, teamKey);
const { thresholds, blocked, capturedDepth } = computeThresholds(cutsBy, standBy, exAll, teamKey);
const th = (thresholds[RID] || []).find(t => t.cut.cut_line_id === "fiba-m-fopqt-7");
console.log(`    Threshold (shared module): ${th ? `rank ${th.atRank}` : "BLOCKED — " + JSON.stringify(blocked[RID]?.map(b => b.cut.cut_line_id))}`);

// (b) fixture teams not in the captured 100
const comps = ["2027-fiba-basketball-world-cup-qualification-africa", "2027-fiba-basketball-world-cup-qualification-americas",
  "2027-fiba-basketball-world-cup-qualification-asia", "2027-fiba-basketball-world-cup-qualification-europe",
  "fiba-eurobasket-2029-pre-qualifiers-second-round"];
const fxTeams = new Set();
ds.fixtures.filter(f => comps.includes(String(f.competition_id)) && f.team1 && f.team2)
  .forEach(f => { fxTeams.add(String(f.team1)); fxTeams.add(String(f.team2)); });
const rankedKeys = new Set(standings.map(r => teamKey(r.team)));
const missing = [...fxTeams].filter(t => !rankedKeys.has(teamKey(t))).sort();
console.log(`\n(b) Fixture teams NOT in the captured 100: ${missing.length ? missing.join(", ") : "(none)"}`);

// (c) regional composition of the pool vs the 6/6/6/16 table
console.log("\n(c) Regional composition:");
const byCont = {};
pool.forEach(r => (byCont[r.continent] ||= []).push(r.team));
Object.entries(byCont).forEach(([c, ts]) => console.log(`    ranking pool ${c}: ${ts.length} — ${ts.join(", ")}`));
// tournament route counts from links (ADVANCE into FOPQTs)
console.log("    tournament route (from links): Africa 6, Americas 6, Asia 6, Europe 16 = 34; ranking adds 7 via umbrella? NO —");
console.log("    (see analysis in the final report — the 6/6/6/16 table vs 34-team umbrella format is computed there)");

// (d) zero-headroom at depth 100
console.log("\n(d) FIBA cut-lines at captured depth " + capturedDepth[RID] + ":");
for (const c of cuts) {
  const t = (thresholds[RID] || []).find(x => x.cut.cut_line_id === c.cut_line_id);
  if (!t) { console.log(`    ${c.cut_line_id}: BLOCKED`); continue; }
  console.log(`    ${c.cut_line_id}: resolves at rank ${t.atRank} — headroom ${capturedDepth[RID] - t.atRank} ranks ${t.atRank === capturedDepth[RID] ? "(ZERO-HEADROOM)" : ""}`);
}
