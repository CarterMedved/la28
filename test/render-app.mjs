/**
 * Render-check (handoff PART 8 #9): parse-checking proves nothing, so this
 * executes the app module for real. React/XLSX/Papa are stubbed, the module
 * is bundled with esbuild, the real workbook is pushed through the app's own
 * normalise(), and Explorer is rendered — every view — with the output text
 * asserted against the known thresholds:
 *   men's FOGQT cut at rank 12 (Ireland)
 *   women's FOGQT cut at rank 14 (Netherlands)
 *   men's host-place test: United States at rank 13, inside the top-15 line
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { loadWorkbook, RAW } from "../src/lib/load.ts";
import { computeThresholds } from "../src/lib/thresholds.ts";
import { teamKey } from "../src/lib/normalise.ts";

const root = new URL("..", import.meta.url).pathname;

await build({
  entryPoints: [root + "test/entry.mjs"],
  bundle: true,
  format: "esm",
  outfile: root + "test/.build/app.bundle.mjs",
  jsx: "automatic",
  alias: {
    "react": root + "test/stubs/react.js",
    "react/jsx-runtime": root + "test/stubs/jsx-runtime.js",
    "xlsx": root + "test/stubs/xlsx.js",
    "papaparse": root + "test/stubs/papaparse.js",
  },
  logLevel: "silent",
});

const app = await import(pathToFileURL(root + "test/.build/app.bundle.mjs"));
const React = app.ReactStub;   // the bundle's own instance — see entry.mjs
const { Explorer, normalise } = app;
if (typeof Explorer !== "function" || typeof normalise !== "function")
  throw new Error("Explorer/normalise not exported from the app module");

// Real workbook → the app's own normalise(), via the shared loader (same
// header/cell cleaning as parseWorkbook).
const ds = loadWorkbook(process.argv[2] ?? root + "data/LA28_Qualification_Database.xlsx");
const strip = rows => rows.map(r => { const o = { ...r }; delete o[RAW]; return o; });
const raw = { events: strip(ds.events), comps: strip(ds.comps), links: strip(ds.links),
              rank: strip(ds.rank), standings: strip(ds.standings), cuts: strip(ds.cuts),
              fixtures: strip(ds.fixtures), qualified: strip(ds.qualified) };
const { data, problems } = normalise(raw);
if (!data) { console.error("normalise() returned no data:", problems); process.exit(1); }

const fatals = problems.filter(p => p.level === "fatal" || p.level === "error");
console.log(`normalise(): ${data.events.length} events, ${data.comps.length} comps, ${data.links.length} links, ` +
  `${data.standings.length} standings, ${data.fx.length} fixtures · ${problems.length} problems (${fatals.length} error/fatal)`);

// Render every view. The stub lets us seed the root component's first
// useState calls, which is how the view switch is driven.
const meta = { source: "render-test", loadedAt: new Date().toISOString(), counts: {} };
const views = [
  ["pathway", []],
  ["calendar-events", ["calendar", null, null, null, "All", "events"]],
  ["calendar-fixtures", ["calendar", null, null, null, "All", "fixtures"]],
  ["rankings", ["rankings"]],
  ["audit", ["audit"]],
  ["data", ["data"]],
];
const rendered = {};
for (const [label, seed] of views) {
  React.__resetHooks();
  React.__seedRootState(seed);
  const el = React.createElement(Explorer, { data, meta, problems, onReset: () => {}, onLoad: () => {}, busy: false });
  rendered[label] = React.renderToText(el);
  console.log(`render ${label}: ok (${rendered[label].length} chars)`);
}
writeFileSync(root + "test/.build/rendered.txt", Object.entries(rendered).map(([k, v]) => `\n===== ${k} =====\n${v}`).join(""));

// --- assertions ---
let failures = 0;
const assert = (cond, msg) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };

// 1. Thresholds via the shared module on the app-normalised data — the same
//    call path Explorer now uses.
const standBy = {}; data.standings.forEach(r => (standBy[r.ranking_id] ||= []).push(r));
const cutsBy = {}; data.cuts.forEach(c => (cutsBy[c.ranking_id] ||= []).push(c));
const { thresholds } = computeThresholds(cutsBy, standBy);
const at = (rid, cutId) => thresholds[rid]?.find(t => t.cut.cut_line_id === cutId)?.atRank ?? null;
const teamAt = (rid, rank) => standBy[rid]?.find(r => r.rank === rank)?.team ?? null;

console.log("\nThreshold assertions (shared module, app data):");
assert(at("icc-mens-t20i-team-ranking", "icc-m-fogqt-8") === 12, "men's FOGQT cut falls at rank 12");
assert(teamAt("icc-mens-t20i-team-ranking", 12) === "Ireland", "rank 12 in the men's table is Ireland");
assert(at("icc-womens-t20i-team-ranking", "icc-w-fogqt-8") === 14, "women's FOGQT cut falls at rank 14");
assert(teamAt("icc-womens-t20i-team-ranking", 14) === "Netherlands", "rank 14 in the women's table is Netherlands");
const hostAt = at("icc-mens-t20i-team-ranking", "icc-m-host-top15");
const us = standBy["icc-mens-t20i-team-ranking"].find(r => teamKey(r.team) === teamKey("United States"));
assert(hostAt === 15, "men's host-place line resolves at rank 15");
assert(us?.rank === 13 && us.rank <= hostAt, `United States at rank ${us?.rank}, inside the host line`);

// 2. The rendered Rankings view actually shows those thresholds.
// The text renderer joins sibling nodes with spaces, so match on \s+.
console.log("\nRendered-output assertions:");
const rk = rendered["rankings"];
assert(/falls at rank\s+12\b/.test(rk), "Rankings view shows a cut falling at rank 12");
assert(/falls at rank\s+14\b/.test(rk), "Rankings view shows a cut falling at rank 14");
assert(/falls at rank\s+15\b/.test(rk), "Rankings view shows the host line at rank 15");
assert(/13\s+United States/.test(rk), "Rankings view lists United States at rank 13");
assert(/12\s+Ireland/.test(rk), "Rankings view lists Ireland at rank 12");
assert(/14\s+Netherlands/.test(rk), "Rankings view lists Netherlands at rank 14");

// 3. Pathway view berth-sum chip still reconciles for the default event.
assert(/berths sum ✓/.test(rendered["pathway"]), "Pathway view shows a reconciled berth sum for the default event");
assert(rendered["pathway"].includes("All places allocated"), "Pathway cascade closes at zero");

const cf = rendered["calendar-fixtures"];
assert(cf.includes("1 win from title"), "Fixtures view carries the placement chip on the CONCACAF final");
assert(cf.includes("shapes bracket"), "Fixtures view carries the placement chip on group games");
assert(!/the winner of this game qualifies/i.test(cf), "No rendered text claims the winner of a game qualifies");

// 4. Audit view derives zero berth-sum mismatches.
assert(/0\s+Berth-sum mismatches/.test(rendered["audit"]), "Audit view shows 0 berth-sum mismatches");

// 5. Provenance strip + audit block (stage-four step 4): the strip states the
//    LOAD PATH as a fact, all three paths render, and the stored path says
//    why there is no validator summary instead of rendering blank.
console.log("\nProvenance assertions:");
const renderWith = (m, seed = []) => {
  React.__resetHooks();
  React.__seedRootState(seed);
  return React.renderToText(React.createElement(Explorer,
    { data, meta: m, problems, onReset: () => {}, onLoad: () => {}, busy: false }));
};
const artefactMeta = {
  source: "data.json · workbook v19", loadedAt: "2026-08-03T09:00:00Z", loadPath: "artefact",
  counts: {},
  artefact: {
    schema_version: 1, reference_date: "2026-08-03", generated_at: "2026-08-03T09:00:00.000Z",
    workbook: { version_label: "v19", sha256: "08af8155eb084861d30a89d43a87599836108358637959199e2997d50991d7b3" },
    validator: { error: 0, warn: 9, info: 2, suppressed: 0, fit_to_publish: true,
                 rules: { "coverage/stale-standings": 3, "coverage/pool-preview": 1 } },
  },
};
{
  const t = renderWith(artefactMeta);
  assert(t.includes("published artefact"), "artefact path: strip names the load path");
  assert(/as of\s+2026-08-03/.test(t) && /generated\s+2026-08-03T09:00:00\.000Z/.test(t),
    "artefact path: as-of and generated_at shown as a pair");
  assert(/0E\/9W\/2I/.test(t), "artefact path: strip carries the validator summary");
  assert(!/NOT FIT TO PUBLISH/.test(t), "artefact path: fit artefact shows no warning");
  const au = renderWith(artefactMeta, ["audit"]);
  assert(au.includes("coverage/stale-standings") && /3\b/.test(au), "audit view lists the artefact rules map");
  assert(au.includes("fit to publish") && au.includes("0 error · 9 warn · 2 info · 0 suppressed"),
    "audit view shows fit_to_publish and the findings line");
}
{
  const unfit = JSON.parse(JSON.stringify(artefactMeta));
  unfit.artefact.validator.fit_to_publish = false; unfit.artefact.validator.error = 3;
  assert(/NOT FIT TO PUBLISH/.test(renderWith(unfit)), "an unfit artefact is flagged in the strip");
}
{
  const t = renderWith({ source: "LA28_Qualification_Database_v19.xlsx",
    loadedAt: "2026-08-01T10:00:00Z", loadPath: "stored", counts: {} });
  assert(t.includes("stored dataset (this browser)"), "stored path: strip names the load path");
  assert(t.includes("validator summary unavailable"), "stored path: strip says WHY there is no summary, not blank");
  const au = renderWith({ loadPath: "stored", counts: {} }, ["audit"]);
  assert(au.includes("no embedded validator report"), "stored path: audit view explains the absent artefact block");
}
{
  const t = renderWith({ source: "LA28_Qualification_Database_v19.xlsx",
    loadedAt: "2026-08-03T09:00:00Z", loadPath: "dragdrop", counts: {} });
  assert(t.includes("workbook (drag-drop)"), "drag-drop path: strip names the load path");
  assert(t.includes("not the published artefact"), "drag-drop path: strip states it is not the artefact");
}
assert(rendered["pathway"].includes("load path unrecorded"),
  "legacy meta without loadPath renders an explicit 'unrecorded', not a wrong claim");

// 6. tz display (docs/timezones.md option B, v20): declared zones render as
//    a short zone name, undeclared real times render "zone?" — a bare time
//    the viewer could mis-zone must not exist.
console.log("\ntz display assertions (v20 workbook):");
{
  const ds20 = loadWorkbook(root + "data/LA28_Qualification_Database_v21.xlsx");
  const raw20 = { events: strip(ds20.events), comps: strip(ds20.comps), links: strip(ds20.links),
                  rank: strip(ds20.rank), standings: strip(ds20.standings), cuts: strip(ds20.cuts),
                  fixtures: strip(ds20.fixtures), qualified: strip(ds20.qualified) };
  const { data: d20 } = normalise(raw20);
  React.__resetHooks();
  React.__seedRootState(["calendar", null, null, null, "All", "fixtures"]);
  const t = React.renderToText(React.createElement(Explorer,
    { data: d20, meta, problems: [], onReset: () => {}, onLoad: () => {}, busy: false }));
  assert(/22:30\s+EDT/.test(t), "FWOPQT declared row shows its time with the zone (22:30 EDT)");
  assert(/\d\d:\d\d\s+zone\?/.test(t), "an undeclared real time is labelled zone?, never bare");
  assert(!/00:00\s+zone\?/.test(t) || !/TBC\s+zone\?/.test(t), "no-time rows never carry a zone label");
  const bare = t.match(/\d\d:\d\d(?!\s+(EDT|zone\?|[A-Z]{2,5}\b))/g) || [];
  assert(bare.length === 0, `every rendered kickoff time carries a zone or zone? (${bare.length} bare)`);
}

console.log(failures ? `\n${failures} assertion(s) FAILED` : "\nAll render assertions passed.");
process.exit(failures ? 1 : 0);
