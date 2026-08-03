/**
 * Stage-four invariant enforcement (docs/stage-four.md §1): "no data
 * compiled into the app", proven in BOTH directions.
 *
 *  1. The real app bundle contains no sentinel — and no data.json import
 *     exists in the app source (the lint that catches the mistake before
 *     the bundle test does).
 *  2. A deliberate VIOLATION fixture doing the tree-shaken, meta-less
 *     `import { data } from ".../data.json"` DOES leak the sentinel into
 *     its bundle — while meta (and any meta-keyed sentinel) is shaken out.
 *     This proves the detector catches the disguised import a meta-keyed
 *     sentinel would miss, not just the naive whole-file one.
 *
 * The sentinel lives inside the data block (data._sentinel) precisely so
 * that no import which carries the payload can shed it.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { emit, SENTINEL } from "../tools/emit-data.mjs";

const root = new URL("..", import.meta.url).pathname;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the real app bundle ----
await build({
  entryPoints: [root + "test/entry.mjs"],
  bundle: true, format: "esm",
  outfile: root + "test/.build/app.bundle.invariant.mjs",
  jsx: "automatic",
  alias: {
    "react": root + "test/stubs/react.js",
    "react/jsx-runtime": root + "test/stubs/jsx-runtime.js",
    "xlsx": root + "test/stubs/xlsx.js",
    "papaparse": root + "test/stubs/papaparse.js",
  },
  logLevel: "silent",
});
const appBundle = readFileSync(root + "test/.build/app.bundle.invariant.mjs", "utf8");
console.log("Real app bundle:");
check("sentinel appears nowhere in the app bundle", !appBundle.includes(SENTINEL));
check("no workbook version label compiled in", !/LA28_Qualification_Database_v\d+/.test(appBundle));
const appSource = readFileSync(root + "qualification-app.jsx", "utf8");
check("import lint: no data.json import in app source",
  !/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*data\.json/.test(appSource));
check("app source does not contain the sentinel literal (shape-validates instead)",
  !appSource.includes(SENTINEL));

// ---- 2. the violation fixture: meta-less, tree-shaken import ----
mkdirSync(root + "test/.build/artefact", { recursive: true });
const artefact = emit(root + "data/LA28_Qualification_Database_v21.xlsx");
writeFileSync(root + "test/.build/artefact/data.json", JSON.stringify(artefact));
writeFileSync(root + "test/.build/violation-entry.mjs",
  `// DELIBERATE VIOLATION (test-only): the named import drops meta via JSON\n` +
  `// tree-shaking while compiling the entire payload into the bundle.\n` +
  `import { data } from "./artefact/data.json";\n` +
  `export const leak = data.events.length + data.fixtures.length;\n`);
await build({
  entryPoints: [root + "test/.build/violation-entry.mjs"],
  bundle: true, format: "esm",
  outfile: root + "test/.build/violation.bundle.mjs",
  logLevel: "silent",
});
const vioBundle = readFileSync(root + "test/.build/violation.bundle.mjs", "utf8");
console.log("Violation fixture (import { data } — meta-less):");
check("payload sentinel LEAKS into the violation bundle (detector catches it)",
  vioBundle.includes(SENTINEL));
const metaMarker = "documentation only";   // unique to meta.runtime_fetch_only
check("meta was tree-shaken out of the violation bundle (a meta-keyed sentinel would have passed)",
  !vioBundle.includes(metaMarker) && !vioBundle.includes(artefact.meta.workbook.sha256));
check("the payload really is compiled in (a data row string is present)",
  vioBundle.includes("fiba-m-fopqt-7"));

console.log(failures ? `\n${failures} FAILURE(S)` : "\nInvariant holds both ways: the app bundles no data, and a disguised import cannot shed the sentinel.");
process.exit(failures ? 1 : 0);
