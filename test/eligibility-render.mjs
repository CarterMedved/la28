/**
 * Render-check for the fbl-005 lesson: eligibility_note must be visible in
 * the Pathway trace (PathwayTrace Step), not only behind the detail-view
 * toggle. Eight links carry conditional language; several originate at
 * competitions with no fixtures yet, so this harness injects SYNTHETIC
 * fixtures (test-only — never written to the workbook) to force every route
 * to render, then asserts each note's distinctive text appears.
 * bkb-001 starts at HOST_USA (an ALLOC node, never a fixture competition),
 * so it cannot appear in a trace; it is asserted via the cascade's openNote
 * toggle instead, which is where that note lives.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { loadWorkbook, RAW } from "../src/lib/load.ts";

const root = new URL("..", import.meta.url).pathname;

await build({
  entryPoints: [root + "test/entry.mjs"],
  bundle: true, format: "esm",
  outfile: root + "test/.build/app.bundle.elig.mjs",
  jsx: "automatic",
  alias: {
    "react": root + "test/stubs/react.js",
    "react/jsx-runtime": root + "test/stubs/jsx-runtime.js",
    "xlsx": root + "test/stubs/xlsx.js",
    "papaparse": root + "test/stubs/papaparse.js",
  },
  logLevel: "silent",
});
const app = await import(pathToFileURL(root + "test/.build/app.bundle.elig.mjs"));
const React = app.ReactStub;
const { Explorer, normalise } = app;

const ds = loadWorkbook(root + "data/LA28_Qualification_Database_v12.xlsx");
const strip = rows => rows.map(r => { const o = { ...r }; delete o[RAW]; return o; });
const raw = {
  events: strip(ds.events), comps: strip(ds.comps), links: strip(ds.links),
  rank: strip(ds.rank), standings: strip(ds.standings), cuts: strip(ds.cuts),
  fixtures: strip(ds.fixtures), qualified: strip(ds.qualified),
};

// Synthetic fixtures (TEST ONLY) so no-fixture competitions render a trace.
const SYNTH = [
  "concacaf-w-championship-2026",
  "eurobasket-women-2027",
  "2027-fiba-women-s-americup",
  "2027-fiba-women-s-asia-cup",
  "fiba-womens-afrobasket-2027",
];
SYNTH.forEach((comp, i) => raw.fixtures.push({
  fixture_id: `synth-${i}`, competition_id: comp, date: "2027-06-01",
  team1: "Test A", team2: "Test B", stage: "Group stage", stage_source: "DERIVED",
  result: null, broadcast: null, check: null, notes: null, date_confidence: null,
}));

const { data } = normalise(raw);
if (!data) { console.error("normalise failed"); process.exit(1); }

let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };

const renderWith = (seed) => {
  React.__resetHooks();
  React.__seedRootState(seed);
  return React.renderToText(React.createElement(Explorer,
    { data, meta: {}, problems: [], onReset: () => {}, onLoad: () => {}, busy: false }));
};
// Root useState order: view, sel, openNote, openComp, sportFilter, calMode, openFx
// Key format matches FxRow: comp|date|team1|stage — the stage was added so
// two undated semi-finals in one competition don't share a key.
const fxKey = (comp) => {
  const f = data.fx.find(f => f[0] === comp);
  return f ? `${f[0]}|${f[1]}|${f[2]}|${f[4]}` : null;
};
const trace = (comp) => renderWith(["calendar", null, null, null, "All", "fixtures", fxKey(comp)]);

console.log("PathwayTrace shows eligibility_note (route-reachable links):");
const CASES = [
  ["fbl-005", "2026-concacaf-u-20-championship", "passes to the runner-up"],
  ["fbl-012", "concacaf-w-championship-2026", "three other semi-finalists qualify instead"],
  ["bkb-027", "2026-fiba-women-s-basketball-world-cup", "The winner only"],
  ["bkb-032", "eurobasket-women-2027", "Five if the FWOPQT winner is European"],
  ["bkb-033", "2027-fiba-women-s-americup", "Reduced by one if the FWOPQT winner comes from this region"],
  ["bkb-034", "2027-fiba-women-s-asia-cup", "Reduced by one if the FWOPQT winner comes from this region"],
  ["bkb-035", "fiba-womens-afrobasket-2027", "Reduced by one if the FWOPQT winner comes from this region"],
];
for (const [link, comp, text] of CASES) {
  const out = trace(comp);
  assert(out.includes(text), `${link}: "${text.slice(0, 48)}…" visible in the trace from ${comp}`);
}

console.log("\nbkb-001 (HOST_USA source — no trace exists; cascade toggle is its home):");
const cascade = renderWith(["pathway", "la28-basketball-m", "bkb-001"]);
assert(cascade.includes("FIBA Central Board"), "bkb-001 note visible in the la28-basketball-m cascade with the toggle open");

console.log("\nBlank-note rows do not break:");
const plain = trace("2026-concacaf-u-20-championship");
assert(plain.length > 1000, "U-20 trace renders fully (blank-note steps render without the note block)");
const pathway = renderWith([]);
assert(pathway.includes("berths sum"), "default Pathway view still renders");

console.log(failures ? `\n${failures} eligibility render check(s) FAILED` : "\nAll eligibility-note render checks passed.");
process.exit(failures ? 1 : 0);
