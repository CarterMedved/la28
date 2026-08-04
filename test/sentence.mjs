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
const { buildIndex, fixtureCardModel, normalise } = await import(pathToFileURL(root + "test/.build/sentence.bundle.mjs"));

const ds = loadWorkbook(root + "data/LA28_Qualification_Database_v22.xlsx");
const strip = rows => rows.map(r => { const o = { ...r }; delete o[RAW]; return o; });
const model = (fx, mutate) => {
  const raw = { events: strip(ds.events), comps: strip(ds.comps), links: strip(ds.links), rank: strip(ds.rank),
                standings: strip(ds.standings), cuts: strip(ds.cuts), fixtures: strip(ds.fixtures), qualified: strip(ds.qualified) };
  mutate?.(raw);
  const { data } = normalise(raw);
  return fixtureCardModel(buildIndex(data), data, fx);
};

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// The flattened shape that must never appear on a conditional edge.
const FLAT = /tournament winner takes it|winner qualifies|winner takes the (berth|place)/i;
const MARKER = /conditional — see how it works/i;
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
  // from prose: bkb-033 (qualifiers edge, AmeriCup → FWOQT) must surface
  // as a ROUTE condition naming its step; bkb-028 (berths edge) stays a
  // RECIPIENT condition on the final step. Both, distinctly, on one card.
  const howText = m.how.join(" | ");
  check("route condition surfaced at its step (bkb-033, derived from the qualifiers column)",
    /route condition applies at .*AmeriCup.*how many teams advance/i.test(howText), howText);
  check("recipient condition still typed on the final step (bkb-028, berths column)",
    /recipient condition applies on the final step: who receives/i.test(howText), howText);
  check("the two types never share a label",
    !/route condition applies on the final step/i.test(howText) &&
    !/recipient condition applies at/i.test(howText), howText);
  check("conditional steps marked in the step list",
    /4 advance \(conditional\) → /.test(howText) && /10 places \(conditional\) → /.test(howText), howText);
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

console.log(failures ? `\n${failures} FAILURE(S)` : "\nSentence engine proven: conditionals cannot flatten, enums fail closed, sentences derive from the graph.");
process.exit(failures ? 1 : 0);
