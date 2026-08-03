/**
 * Task-3 probe: what does the app's own fixtureVerdict say about
 * fx-0026 / fx-0062 / fx-0063? Renders Explorer's calendar-fixtures view via
 * the same harness as render-app.mjs, but instead of asserting, extracts the
 * verdict the idx exposes. We rebuild the exact same inputs the app builds and
 * call the verdict through the rendered fixture rows' logic — simplest honest
 * route: re-execute the app module and pull idx.fixtureVerdict out via a tap.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { loadWorkbook, RAW } from "../src/lib/load.ts";

const root = new URL("..", import.meta.url).pathname;

await build({
  entryPoints: [root + "test/entry.mjs"],
  bundle: true, format: "esm",
  outfile: root + "test/.build/app.bundle.probe.mjs",
  jsx: "automatic",
  alias: {
    "react": root + "test/stubs/react.js",
    "react/jsx-runtime": root + "test/stubs/jsx-runtime.js",
    "xlsx": root + "test/stubs/xlsx.js",
    "papaparse": root + "test/stubs/papaparse.js",
  },
  logLevel: "silent",
});
const app = await import(pathToFileURL(root + "test/.build/app.bundle.probe.mjs"));
const React = app.ReactStub;
const { Explorer, normalise } = app;

const ds = loadWorkbook(root + (process.argv[2] ?? "data/LA28_Qualification_Database_v7.xlsx"));
const strip = rows => rows.map(r => { const o = { ...r }; delete o[RAW]; return o; });
const { data } = normalise({
  events: strip(ds.events), comps: strip(ds.comps), links: strip(ds.links),
  rank: strip(ds.rank), standings: strip(ds.standings), cuts: strip(ds.cuts),
  fixtures: strip(ds.fixtures), qualified: strip(ds.qualified),
});

// Tap: the react stub exposes __tapMemo, which sees every memo value as it is
// created. Explorer's idx memo is the one carrying fixtureVerdict.
let capturedIdx = null;
React.__tapMemo(v => { if (v && typeof v === "object" && typeof v.fixtureVerdict === "function") capturedIdx = v; });
React.__resetHooks();
React.renderToText(React.createElement(Explorer, { data, meta: {}, problems: [], onReset: () => {}, onLoad: () => {}, busy: false }));
React.__tapMemo(null);
if (!capturedIdx) { console.error("could not capture idx"); process.exit(1); }

const targets = ["fx-0026", "fx-0062", "fx-0063"];
const fxRows = ds.fixtures.filter(f => targets.includes(String(f.fixture_id)));
for (const f of fxRows) {
  const v = capturedIdx.fixtureVerdict(f.competition_id, f.team1, f.team2, String(f.date));
  console.log(`\n=== ${f.fixture_id} · ${f.team1} v ${f.team2} · ${f.competition_id} ===`);
  console.log(v === null ? "verdict: null (no RANKING_POINTS outbound link — the verdict system does not cover this fixture)"
    : `verdict: ${v.level}\n  why: ${v.why}`);
}
