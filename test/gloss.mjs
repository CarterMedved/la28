/**
 * Links.count_gloss render pin — DECLARED in the sheet, never detected.
 * The motivating row is fbl-019: "↓ 1 advance" into the AFC–CONMEBOL
 * play-off reads as "the group winner goes through", and it is the
 * opposite — the two group winners take Asia's berths directly and the
 * play-off slot goes to a third team. The gloss carries that on the
 * count line itself: unlabelled, plain ink, part of the count.
 *
 * Pinned: blank column → bare count (fail closed, today's live shape);
 * filled → the gloss renders in the trace; nothing about it is quoted or
 * labelled as a rule.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { loadWorkbook, RAW } from "../src/lib/load.ts";

const root = new URL("..", import.meta.url).pathname;
await build({
  entryPoints: [root + "test/entry.mjs"],
  bundle: true, format: "esm",
  outfile: root + "test/.build/gloss.bundle.mjs",
  jsx: "automatic",
  alias: { "react": root + "test/stubs/react.js", "react/jsx-runtime": root + "test/stubs/jsx-runtime.js",
           "xlsx": root + "test/stubs/xlsx.js", "papaparse": root + "test/stubs/papaparse.js" },
  logLevel: "silent",
});
const app = await import(pathToFileURL(root + "test/.build/gloss.bundle.mjs"));
const React = app.ReactStub;
const { Explorer, normalise } = app;

const ds = loadWorkbook(root + "data/LA28_Qualification_Database_v22.xlsx");
const strip = rows => rows.map(r => { const o = { ...r }; delete o[RAW]; return o; });

const GLOSS = "Two teams beyond the group winners play off for this slot — the group winners take Asia's places directly.";

const renderAfcCard = (mutate) => {
  const raw = { events: strip(ds.events), comps: strip(ds.comps), links: strip(ds.links), rank: strip(ds.rank),
                standings: strip(ds.standings), cuts: strip(ds.cuts), fixtures: strip(ds.fixtures), qualified: strip(ds.qualified) };
  mutate?.(raw);
  const { data } = normalise(raw);
  const f = data.fx.find(x => x[0] === "afc-womens-asian-cup-2026");
  React.__resetHooks();
  React.__seedRootState(["calendar", null, null, null, "All", "fixtures", `${f[0]}|${f[1]}|${f[2]}|${f[4]}`, false]);
  return React.renderToText(React.createElement(Explorer,
    { data, meta: {}, problems: [], onReset: () => {}, onLoad: () => {}, busy: false }));
};

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

console.log("count_gloss — fbl-019, both states:");
{
  const out = renderAfcCard();
  check("blank column → bare count, no gloss text anywhere (fail closed)",
    !out.includes("beyond the group winners"));
}
{
  const out = renderAfcCard(raw => { raw.links.find(l => l.link_id === "fbl-019").count_gloss = GLOSS; });
  check("filled → the gloss renders on the play-off step", out.includes(GLOSS));
  check("unlabelled and unquoted — it must not look like a rule",
    !out.includes(`«${GLOSS}»`) && !new RegExp(`recorded[^«]{0,40}${"beyond the group winners"}`).test(out));
  const i = out.indexOf(GLOSS);
  check("part of the count line: sits with '1 advance', before the next node",
    out.lastIndexOf("1 advance", i) > -1 && i - out.lastIndexOf("1 advance", i) < 40, String(i - out.lastIndexOf("1 advance", i)));
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\ncount_gloss proven: declared not detected, blank-safe, unlabelled on the count line.");
process.exit(failures ? 1 : 0);
