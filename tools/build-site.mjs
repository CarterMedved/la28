/**
 * Stage-four step 4: build the site shell — the production app bundle plus
 * the index.html that mounts it — into the Pages tree, BESIDE data/data.json
 * (never into src/). One build definition, exported, so the CI workflow, the
 * bundle-invariant harness and the rehearsal all build the SAME artefact —
 * a harness that built its own variant would prove nothing about the page.
 *
 * The shell is data-free by design: data.json is fetched at RUNTIME by the
 * app (relative path, so it resolves under the /la28/ Pages base) and never
 * imported at build time. test/bundle-invariant.mjs scans THIS bundle for
 * the sentinel.
 *
 * Every asset reference is RELATIVE (./app.js, data/data.json): the site is
 * served at /la28/, and a root-absolute path that works at / and 404s under
 * the project base is the obvious trap.
 *
 * Usage: node tools/build-site.mjs --out site
 */
import { build } from "esbuild";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LA28 Qualification Tracker</title>
<link rel="icon" href="data:,">
</head>
<body>
<div id="root"></div>
<script type="module" src="./app.js"></script>
</body>
</html>
`;

export async function buildSite(outDir) {
  mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [root + "site-entry.jsx"],
    bundle: true,
    format: "esm",
    minify: true,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: `${outDir}/app.js`,
    logLevel: "silent",
  });
  writeFileSync(`${outDir}/index.html`, INDEX_HTML);
  // Shell identity: folded into ci-publish's skip decision so an app change
  // with unchanged data still publishes (content+rules alone would skip
  // forever and the new shell would never deploy).
  const shell = createHash("sha256")
    .update(readFileSync(`${outDir}/app.js`))
    .update(readFileSync(`${outDir}/index.html`))
    .digest("hex");
  return shell;
}

if (process.argv[1]?.endsWith("build-site.mjs")) {
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? process.argv[i + 1] : null;
  if (!out) { console.error("usage: node tools/build-site.mjs --out <dir>"); process.exit(2); }
  const shell = await buildSite(out);
  console.log(`site shell -> ${out}/app.js + ${out}/index.html (shell sha256 ${shell})`);
}
