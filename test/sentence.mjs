/**
 * Fixture-card sentence engine — the fbl-005 acceptance test, mechanized.
 * The plain sentence is NEW derivation (not a quote), so this harness pins
 * the property that makes it safe: A CONDITIONAL CAN NEVER FLATTEN.
 *
 * States proven on the real graph (v22 + in-memory link mutations):
 *   fbl-005 columns blank            → marker form
 *   fbl-005 filled (HOST_WINS/RUNNER_UP) → structured conditional clause
 *   fbl-005 garbage / half-filled    → marker form (enums fail closed)
 *   fbl-005 prose stripped clean     → the ONLY path to the unconditional form
 *   fbl-012 in every state           → never names a definite recipient
 *                                      (the draw decides; correct until then)
 * Plus the three design cards derive their sentences from the real artefact,
 * and no sentence carries internal ids.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { loadWorkbook, RAW } from "../src/lib/load.ts";

const root = new URL("..", import.meta.url).pathname;
await build({
  entryPoints: [root + "test/entry.mjs"],
  bundle: true, format: "esm",
  outfile: root + "test/.build/sentence.bundle.mjs",
  jsx: "automatic",
  alias: { "react": root + "test/stubs/react.js", "react/jsx-runtime": root + "test/stubs/jsx-runtime.js",
           "xlsx": root + "test/stubs/xlsx.js", "papaparse": root + "test/stubs/papaparse.js" },
  logLevel: "silent",
});
const { buildIndex, fixtureCardModel, normalise, routesFrom, routeMateriality, routeHeader, recordedRule, INLINE_RULE_MAX } =
  await import(pathToFileURL(root + "test/.build/sentence.bundle.mjs"));

const ds = loadWorkbook(root + "data/LA28_Qualification_Database_v22.xlsx");
const strip = rows => rows.map(r => { const o = { ...r }; delete o[RAW]; return o; });
const ctx = (mutate) => {
  const raw = { events: strip(ds.events), comps: strip(ds.comps), links: strip(ds.links), rank: strip(ds.rank),
                standings: strip(ds.standings), cuts: strip(ds.cuts), fixtures: strip(ds.fixtures), qualified: strip(ds.qualified) };
  mutate?.(raw);
  const { data } = normalise(raw);
  return { data, idx: buildIndex(data) };
};
const model = (fx, mutate) => {
  const { data, idx } = ctx(mutate);
  return fixtureCardModel(idx, data, fx);
};
const notesOf = (m, id) => (m.edgeNotes[id] || []).join(" | ");
const allNotes = (m) => Object.values(m.edgeNotes).flat().join(" | ");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// The flattened shape that must never appear on a conditional edge.
const FLAT = /tournament winner takes it|winner qualifies|winner takes the (berth|place)/i;
const MARKER = /who receives it is conditional\./i;
const link = (raw, id) => raw.links.find(x => x.link_id === id);

// ---- fbl-005: a knockout fixture on the conditional edge ----
const QF = ["2026-concacaf-u-20-championship", "2026-08-14 20:00:00", "USA U-20", "Guatemala U-20", "Quarter-final"];

console.log("fbl-005 — every state:");
{
  const m = model(QF);
  check("columns blank → marker form", MARKER.test(m.sentence) && !FLAT.test(m.sentence), m.sentence);
  check("marker names the host fact (derived from the HOST link)", /already in as hosts/.test(m.sentence));
}
{
  const m = model(QF, raw => { const l = link(raw, "fbl-005"); l.condition_trigger = "HOST_WINS"; l.condition_recipient = "RUNNER_UP"; });
  check("filled → structured conditional, no flatten",
    /if the USA win the tournament, the berth passes to the losing finalist/.test(m.sentence) && !FLAT.test(m.sentence), m.sentence);
}
{
  const m = model(QF, raw => { const l = link(raw, "fbl-005"); l.condition_trigger = "A_VALUE_NOBODY_TAUGHT_IT"; l.condition_recipient = "RUNNER_UP"; });
  check("unrecognised trigger → marker form (enum fails closed)", MARKER.test(m.sentence) && !FLAT.test(m.sentence), m.sentence);
}
{
  const m = model(QF, raw => { const l = link(raw, "fbl-005"); l.condition_trigger = "HOST_WINS"; });
  check("trigger without recipient → marker form", MARKER.test(m.sentence) && !FLAT.test(m.sentence), m.sentence);
}
{
  const m = model(QF, raw => { const l = link(raw, "fbl-005");
    l.eligibility_note = null; l.criterion = "The tournament winner qualifies for the 2028 Olympics."; });
  check("prose stripped clean + columns empty → the only path to the unconditional form",
    FLAT.test(m.sentence) && !MARKER.test(m.sentence), m.sentence);
}

// ---- fbl-012: never a definite recipient, in any state ----
const WSEMI = ["concacaf-w-championship-2026", "2026-11-20 20:00:00", "USA", "Canada", "Semi-final"];
console.log("fbl-012 — never names a definite recipient:");
const DEFINITE = /losing finalist|runner[- ]up|next eligible/i;
for (const [name, mut] of [
  ["blank", null],
  ["filled (HOST_IN_SEMIS/OTHER_SEMIFINALISTS)", raw => { const l = link(raw, "fbl-012");
    l.condition_trigger = "HOST_IN_SEMIS"; l.condition_recipient = "OTHER_SEMIFINALISTS"; }],
  ["garbage", raw => { const l = link(raw, "fbl-012"); l.condition_trigger = "WHO_KNOWS"; l.condition_recipient = "SOMEONE"; }],
]) {
  const m = model(WSEMI, mut);
  check(`${name} → marker, no definite recipient`,
    !DEFINITE.test(m.sentence) && !FLAT.test(m.sentence) && /conditional/.test(m.sentence), m.sentence);
}

// ---- the three design cards, from the real artefact ----
console.log("design cards derive from the real data:");
{
  const f = ds.fixtures.map(x => [x.competition_id, x.date, x.team1, x.team2, x.stage])
    .find(x => x[0] === "fiba-women-s-americup-2027-south-american-qualifier");
  const m = model(f);
  check("Chile v Brazil: bracket + rounds-away + berth venue, no ids",
    /sets the bracket/.test(m.sentence) && /2 rounds away/.test(m.sentence) &&
    /2028 FIBA Women's Olympic Qualifying Tournaments/.test(m.sentence) &&
    !/la28-|bkb-\d|fbl-\d|cri-\d/.test(m.sentence), m.sentence);
  // Condition TYPES are derived from the graph (berths vs qualifiers), not
  // from prose, and each condition renders ON ITS OWN EDGE (edgeNotes) —
  // there is no "how it works" paragraph to retype the trace. bkb-028
  // (berths edge) asserts TODAY only because its app-addressed note
  // contains "should" — the accepted replacement flips it quiet with no
  // code change. Both states pinned.
  check("route condition sits on bkb-033, its own edge",
    /route condition applies on this step: how many teams advance/i.test(notesOf(m, "bkb-033")), notesOf(m, "bkb-033"));
  check("recipient condition sits on bkb-028 (its current note asserts via 'should')",
    /recipient condition applies on this step: who receives/i.test(notesOf(m, "bkb-028")), notesOf(m, "bkb-028"));
  check("the two types never share an edge or a label",
    !/recipient/i.test(notesOf(m, "bkb-033")) && !/route condition/i.test(notesOf(m, "bkb-028")));
}
{
  // The accepted bkb-028 replacement (pasted 4 Aug, live) goes QUIET:
  // arithmetic explanation, no condition — the label must disappear while
  // the note stays quoted verbatim. (The pinned v22 fixture predates the
  // paste, so the mutation reproduces it.)
  const REPLACEMENT = "The host and the FWBWC champion are already inside the 16-team field, so two of the twelve qualifying positions will be taken by teams that have already qualified. The recorded figure is the NET ten new places — that is why it is not 'twelve advance', and why the quota reconciles.";
  const f = ds.fixtures.map(x => [x.competition_id, x.date, x.team1, x.team2, x.stage])
    .find(x => x[0] === "fiba-women-s-americup-2027-south-american-qualifier");
  const m = model(f, raw => { const l = link(raw, "bkb-028"); l.eligibility_note = REPLACEMENT; });
  check("after the accepted paste, bkb-028 goes quiet (no note on its edge)",
    !notesOf(m, "bkb-028"), notesOf(m, "bkb-028"));
  check("route condition on bkb-033 survives the paste", /route condition/i.test(notesOf(m, "bkb-033")));
  check("the replaced note is still quoted verbatim",
    m.quotes.some(q => q.id === "bkb-028" && /NET ten new places/.test(q.text)));
}

// ---- the fbl-013 class: descriptive prose must NOT be labelled a condition ----
console.log("descriptive notes stay quiet (the AFC card bug):");
{
  const f = ds.fixtures.map(x => [x.competition_id, x.date, x.team1, x.team2, x.stage])
    .find(x => x[0] === "afc-womens-asian-cup-2026");
  const m = model(f);
  check("fbl-013 ('Two groups of four, league format.') carries no condition label anywhere",
    !/condition applies/i.test(allNotes(m)), allNotes(m));
  check("no conditional marker in the sentence either",
    !MARKER.test(m.sentence) && !FLAT.test(m.sentence), m.sentence);
  const { data, idx } = ctx();
  const headers = routesFrom(idx, "afc-womens-asian-cup-2026").map(r => routeHeader(idx, data, r));
  check("the play-off route is separated by its header",
    headers.some(h => /2 places decided at .*Olympic Qualifying/i.test(h)) &&
    headers.some(h => /1 place decided at .*play.?off/i.test(h)), headers.join(" || "));
  check("the separate route's sheet text joins the verbatim layer",
    m.quotes.some(q => q.id === "fbl-017"));
  check("quotes never duplicate an id+field",
    new Set(m.quotes.map(q => `${q.id}|${q.field}`)).size === m.quotes.length);
}

// ---- route headers name WHICH place; materiality under the band ----
console.log("cricket routes: named lines, settled route suppressed:");
{
  const { data, idx } = ctx();
  const comp = "pakistan-women-s-cricket-team-in-sri-lanka-in-2026";
  const routes = routesFrom(idx, comp);
  const headers = routes.map(r => routeHeader(idx, data, r));
  check("the fallback route's header names its cut-line",
    headers.some(h => /Host-place fallback/i.test(h)), headers.join(" || "));
  check("the qualifier-field route's header names ITS cut-line — different place, stated first",
    headers.some(h => /FOGQT field — next eight not yet qualified/i.test(h)), headers.join(" || "));
  const teams = ["Sri Lanka Women", "Pakistan Women"];
  const byCut = (id) => routes.find(r => r.some(l => l.cut_line_id === id));
  const live = routeMateriality(idx, data, byCut("icc-w-host-fallback"), teams);
  const settled = routeMateriality(idx, data, byCut("icc-w-fogqt-8"), teams);
  check("the host-fallback route stays in play (11-point live chase)", live.inPlay === true);
  check("the qualifier-field route collapses, saying why",
    settled.inPlay === false && /Sri Lanka.*clear of this line/i.test(settled.reason) &&
    /Pakistan.*clear of this line/i.test(settled.reason), settled.reason);
  // The mechanism sentence lives on the cut-carrying edge, not in a section.
  const f = ds.fixtures.map(x => [x.competition_id, x.date, x.team1, x.team2, x.stage]).find(x => x[0] === comp);
  const m = model(f);
  check("ranking mechanism renders on cri-020, the edge carrying the live cut",
    /isn't settled.*highest-ranked team not already qualified/i.test(notesOf(m, "cri-020")), notesOf(m, "cri-020"));
}
{
  const f = ds.fixtures.map(x => [x.competition_id, x.date, x.team1, x.team2, x.stage])
    .find(x => x[0] === "pakistan-women-s-cricket-team-in-sri-lanka-in-2026");
  const m = model(f);
  check("SL v PAK: holder + margin + close date + the other team's clause",
    /New Zealand/.test(m.sentence) && /11 rating points/.test(m.sentence) &&
    /1 Mar 2027/.test(m.sentence) && /Pakistan are too far back/.test(m.sentence), m.sentence);
  check("quotes carry the cut notes exactly once",
    m.quotes.filter(q => q.id === "icc-w-host-fallback").length === 1);
}

// ---- the step carries the rule: inline at ≤ INLINE_RULE_MAX, else opening in place ----
console.log("rules live on their steps; nothing signposts:");
{
  const { data } = ctx();
  const L = (id) => (data.links || []).find(l => l.link_id === id);
  const len = (id) => (recordedRule(L(id)) || "").length;
  check("threshold = 134, the longest signpost sentence it replaced", INLINE_RULE_MAX === 134);
  check("bkb-032/033/034/035 inline (99/59/59/59 chars, all ≤ threshold)",
    ["bkb-032", "bkb-033", "bkb-034", "bkb-035"].every(id => len(id) > 0 && len(id) <= INLINE_RULE_MAX));
  check("fbl-005/fbl-012/bkb-001/bkb-027 open in place (212/221/311/159 chars, all > threshold)",
    ["fbl-005", "fbl-012", "bkb-001", "bkb-027"].every(id => len(id) > INLINE_RULE_MAX));
  check("descriptive notes yield no rule (fbl-013 stays audit-only)", recordedRule(L("fbl-013")) === null);
  const SIGNPOST = /Sheet text|README|see how it works|carries the rule|see the route|is in the|quoted .* below/i;
  const cards = [
    "fiba-women-s-americup-2027-south-american-qualifier",
    "pakistan-women-s-cricket-team-in-sri-lanka-in-2026",
    "afc-womens-asian-cup-2026",
  ].map(c => model(ds.fixtures.map(x => [x.competition_id, x.date, x.team1, x.team2, x.stage]).find(x => x[0] === c)));
  check("no design card carries a signpost string, in sentence or on any edge",
    cards.every(m => !SIGNPOST.test(m.sentence) && !SIGNPOST.test(allNotes(m))),
    cards.map(m => m.sentence).join(" § "));
}

// ---- the marker's edge is always in a rendered route ----
// The primary path is drawn from the SAME enumeration the trace renders,
// so the conditional edge is in a rendered route by construction. The one
// data-shape assumption left is the trace's 8-route display cap — pinned
// here over the whole graph so growth breaks the harness, not the pointer.
console.log("the sentence never points at a route that doesn't render:");
{
  const { data, idx } = ctx();
  let over8WithDirect = 0, over8NoDirect = 0, orphaned = 0;
  for (const c of (data.comps || [])) {
    const routes = routesFrom(idx, c.competition_id).sort((a, b) => a.length - b.length);
    const direct = routes.filter(r => r.every(l => l.relationship !== "RANKING_POINTS"))[0];
    if (routes.length > 8) { direct ? over8WithDirect++ : over8NoDirect++; }
    if (!direct) continue;   // no direct route → no placeSentence → no marker to point
    const rendered = new Set(routes.slice(0, 8).flat().map(l => l.link_id));
    if (direct.some(l => !rendered.has(l.link_id))) orphaned++;
  }
  check("no marker-capable competition exceeds the 8-route display cap", over8WithDirect === 0, `${over8WithDirect} over cap`);
  check("every primary path is inside the rendered route set", orphaned === 0, `${orphaned} orphaned`);
  // Known display truncation, not a pointer risk: the fencing ranking
  // feeders (12 routes, no direct route, no possible marker) show
  // "+4 more routes" in the trace. Not silent, so not asserted to zero.
  console.log(`  (info) ${over8NoDirect} route-only competitions truncate at 8 with the "+N more" chip`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nSentence engine proven: conditionals cannot flatten, enums fail closed, sentences derive from the graph.");
process.exit(failures ? 1 : 0);
