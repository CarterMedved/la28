/**
 * Placement-verdict negative tests — every refusal proven in both
 * directions on in-memory mutations of the real dataset (the module is
 * pure, so no mutant workbooks are needed).
 *
 *  1. A conditional link with a BLANK eligibility_note must still verdict
 *     cleanly (criterion quoted, nothing fabricated, no "undefined"/"null"
 *     leaking into text) — and with the note present it must be quoted.
 *  2. A competition with no path to any berth must return null — no
 *     verdict, not a wrong one. With the path restored, non-null.
 *  3. An undrawn knockout (placeholder teams) must verdict from stage
 *     alone; an unparseable stage must return "unresolved" with a reason,
 *     never a guessed distance.
 *  4. A berth edge whose berths count is blank must not be treated as a
 *     berth route (fails closed to null).
 *  5. The walk must respect the region gate and must not traverse ranking
 *     edges.
 */
import { fileURLToPath } from "node:url";
import { loadWorkbook } from "../src/lib/load.ts";
import { buildPlacementContext, placementVerdict, parseStage } from "../src/lib/placement.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const ds = loadWorkbook(root + (process.argv[2] ?? "data/LA28_Qualification_Database_v14.xlsx"));

let failures = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
};
const fxLite = ds.fixtures.map(f => ({ competition_id: f.competition_id, stage: f.stage }));
const ctxOf = links => buildPlacementContext(links, ds.comps, ds.events, fxLite);
const CONCACAF = "2026-concacaf-u-20-championship";
const textOf = v => JSON.stringify(v);

// ---- 1. blank eligibility_note on a conditional link ----
{
  const mutated = ds.links.map(l => l.link_id === "fbl-005" ? { ...l, eligibility_note: null } : l);
  const v = placementVerdict(CONCACAF, "Final", ctxOf(mutated));
  check("blank eligibility_note: verdict still produced", !!v && v.level === "live");
  check("blank eligibility_note: criterion still quoted verbatim",
    !!v && v.stakes.some(s => s.includes("Should the United States")));
  check("blank eligibility_note: no fabricated condition for fbl-005",
    !!v && !v.conditions.some(c => c.startsWith("fbl-005")));
  check("blank eligibility_note: no undefined/null leaks into text",
    !!v && !/undefined|»null|«null/.test(textOf(v)));
  const v2 = placementVerdict(CONCACAF, "Final", ctxOf(ds.links));
  check("note present: fbl-005 eligibility_note quoted verbatim",
    !!v2 && v2.conditions.some(c => c.startsWith("fbl-005 · eligibility_note:") && c.includes("passes to the runner-up")));
}

// ---- 2. no path to any berth ----
{
  const v = placementVerdict("pakistan-women-s-cricket-team-in-sri-lanka-in-2026", "Series match 1 of 3", ctxOf(ds.links));
  check("RANKING_POINTS-only competition: verdict is null", v === null);
  const orphaned = ds.links.filter(l => l.from_id !== CONCACAF);
  check("competition with links removed: verdict is null, not a wrong one",
    placementVerdict(CONCACAF, "Final", ctxOf(orphaned)) === null);
  check("path present: same competition verdicts non-null",
    placementVerdict(CONCACAF, "Final", ctxOf(ds.links)) !== null);
}

// ---- 3. undrawn knockout and unparseable stage ----
{
  const ctx = ctxOf(ds.links);
  const fin = ds.fixtures.find(f => f.fixture_id === "fx-0084");
  check("undrawn final (placeholder teams): verdicts from stage alone",
    String(fin.team1).startsWith("Winner") &&
    placementVerdict(String(fin.competition_id), fin.stage, ctx)?.chip === "1 win from title");
  check("undrawn semi-final: 2 wins from title",
    placementVerdict(CONCACAF, "Semi-final 1", ctx)?.chip === "2 wins from title");
  const u = placementVerdict(CONCACAF, "Mystery round 9", ctx);
  check("unparseable stage: unresolved with the label in the reason",
    !!u && u.level === "unresolved" && u.distance.includes("Mystery round 9") && u.stakes.length > 0);
  const n = placementVerdict(CONCACAF, null, ctx);
  check("missing stage: unresolved with a no-stage reason, stakes intact",
    !!n && n.level === "unresolved" && /No stage recorded/.test(n.distance) && n.stakes.length > 0);
  const g = placementVerdict(CONCACAF, "Group stage · Matchday 3", ctx);
  check("group game: no invented win count",
    !!g && g.level === "low" && /no fixed win count/.test(g.distance) && !/\d+ wins? from/.test(g.chip));
}

// ---- 4. berth edge with blank berths fails closed ----
{
  const mutated = ds.links.map(l => l.link_id === "fbl-005" ? { ...l, berths: null } : l);
  check("berth edge with blank berths: no route claimed (null verdict)",
    placementVerdict(CONCACAF, "Final", ctxOf(mutated)) === null);
}

// ---- 5. region gate and no ranking traversal ----
{
  const ctx = ctxOf(ds.links);
  const v = placementVerdict("2027-fiba-basketball-world-cup-qualification-africa", "Second round · Window 4", ctx);
  const t = textOf(v);
  check("Africa 2R: routes exist (WC + FOPQT tournament route)", !!v && v.routesTotal === 3);
  check("region gate: no other region's FOPQT on any Africa route",
    !!v && !/for-americas|for-asia|for-europe/.test(t));
  check("no ranking traversal: umbrella (ranking-pool route) absent",
    !!v && !t.includes("allocation umbrella") && !t.includes("fiba-mens-world-ranking"));
  check("fallback into the FOPQT carries its entry_condition verbatim",
    !!v && v.conditions.some(c => c.startsWith("bkb-013 · entry_condition:") && c.includes("did NOT reach the World Cup")));
}

// ---- parseStage spot checks, both directions ----
check("parseStage: 'Quarter-final 3' is 3 wins", parseStage("Quarter-final 3").winsToTitle === 3);
check("parseStage: 'Final' is 1 win", parseStage("Final").winsToTitle === 1);
check("parseStage: 'Semi-final 2' does not read as a final", parseStage("Semi-final 2").winsToTitle === 2);
check("parseStage: 'Second round · Window 5' is a window, no win count",
  parseStage("Second round · Window 5").kind === "window" && parseStage("Second round · Window 5").winsToTitle === null);
check("parseStage: 'Tie 2 · Leg 1' is a leg", parseStage("Tie 2 · Leg 1").kind === "leg");

console.log(failures ? `\n${failures} FAILURE(S)` : "\nAll placement negative tests passed — every refusal fires and clears.");
process.exit(failures ? 1 : 0);
