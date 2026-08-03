/**
 * Placement-verdict probe: the five acceptance cases from the tier-1/2
 * implementation task, printed as text. Pure module — no app spin-up.
 * Usage: node test/placement-probe.mjs [workbook]
 */
import { fileURLToPath } from "node:url";
import { loadWorkbook } from "../src/lib/load.ts";
import { buildPlacementContext, placementVerdict } from "../src/lib/placement.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ds = loadWorkbook(root + (process.argv[2] ?? "data/LA28_Qualification_Database_v14.xlsx"));
const ctx = buildPlacementContext(ds.links, ds.comps, ds.events,
  ds.fixtures.map(f => ({ competition_id: f.competition_id, stage: f.stage })));

const byId = Object.fromEntries(ds.fixtures.map(f => [f.fixture_id, f]));
const show = (fid, note) => {
  const f = byId[fid];
  if (!f) { console.log(`\n### ${fid} — NOT FOUND`); return; }
  console.log(`\n=== ${fid} · ${f.team1} v ${f.team2} · ${f.stage} · ${f.competition_id}`);
  if (note) console.log(`    (${note})`);
  const v = placementVerdict(String(f.competition_id), f.stage, ctx);
  if (!v) { console.log("placement verdict: null — no placement route from this competition"); return; }
  console.log(`level: ${v.level} · chip: "${v.chip}" · routes: ${v.routesTotal}`);
  console.log(`why:      ${v.why}`);
  console.log(`distance: ${v.distance}`);
  v.stakes.forEach(s => console.log(`stakes:   ${s}`));
  v.conditions.forEach(c => console.log(`cond:     ${c}`));
  console.log(`footer:   ${v.footer}`);
};

show("fx-0062", "group game in a berth-awarding competition");
show("fx-0084", "the CONCACAF final — conditional recipient; must NOT say the winner qualifies");
show("fx-0391", "CAF W OQT R1 leg — berth five rounds downstream");
const wc2r = ds.fixtures.find(f => f.competition_id === "2027-fiba-basketball-world-cup-qualification-africa");
show(String(wc2r.fixture_id), "WC-qualifier second round — feeds the World Cup AND the FOPQT tournament route");
show("fx-0026", "RANKING_POINTS fixture — placement must be null; ranking verdict handled separately");
