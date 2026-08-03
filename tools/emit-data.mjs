/**
 * Stage-four step 1: workbook → data.json (docs/stage-four.md §4).
 *
 * Emits CLEANED ROWS, never derived values — thresholds, verdicts,
 * already_qualified and placement stay runtime-derived through the shared
 * modules (PART 4's "never type" list is also a "never publish as data"
 * list). Cleaning happens here once, through src/lib/load.ts — the same
 * loader every harness uses, so the artefact's data block is exactly the
 * shape the app's normalise() is already proven against daily.
 *
 * RAW stripping: load.ts keys the raw cell view on a Symbol, and
 * JSON.stringify never serializes symbol-keyed properties — the emitted
 * rows are RAW-free by construction (asserted in test/data-roundtrip.mjs).
 * No load.ts change was needed for this script to exist.
 *
 * The sentinel lives INSIDE the data block (data._sentinel), not in meta:
 * meta is tree-shakeable on a named JSON import, the payload is not — see
 * stage-four.md §1.
 *
 * Usage: node tools/emit-data.mjs <workbook.xlsx> [--out data.json]
 *        [--report report.json] [--reference-date YYYY-MM-DD]
 * --report embeds the validator summary (CI passes the gate's report; a
 * local run may omit it, leaving meta.validator null — such an artefact is
 * for local testing and must never be published).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { loadWorkbook } from "../src/lib/load.ts";

export const SENTINEL = "LA28-DATA-MUST-NOT-BE-BUNDLED";

const dataBlock = ds => ({
  events: ds.events, comps: ds.comps, links: ds.links, rank: ds.rank,
  standings: ds.standings, cuts: ds.cuts, fixtures: ds.fixtures, qualified: ds.qualified,
});

/**
 * Content identity: sha256 of the normalised data block — what data.json
 * carries, not the container bytes. Google's xlsx export is byte-UNSTABLE
 * on unchanged content (measured 4 Aug 2026: two exports of an untouched
 * sheet differed in sha256 and size, zero differing cells), so raw-bytes
 * identity would republish daily for no change. Content drives the SKIP
 * decision, the archive key and the bootstrap digest; the raw workbook
 * sha keeps its one job — the baseline integrity check, whose two sides
 * come from the same stored bytes and never cross an export boundary.
 */
export function contentSha256(workbookPath) {
  // Symbol-keyed RAW is dropped by JSON.stringify; key order follows the
  // sheet's header order, so identical content serialises identically.
  return createHash("sha256").update(JSON.stringify(dataBlock(loadWorkbook(workbookPath)))).digest("hex");
}

export function emit(workbookPath, { reportPath = null, referenceDate = null } = {}) {
  const ds = loadWorkbook(workbookPath);
  const bytes = readFileSync(workbookPath);

  let validator = null;
  if (reportPath) {
    const rep = JSON.parse(readFileSync(reportPath, "utf8"));
    const rules = {};
    for (const f of rep.findings ?? []) rules[f.rule] = (rules[f.rule] || 0) + 1;
    const count = sev => (rep.findings ?? []).filter(f => f.severity === sev).length;
    validator = {
      error: count("ERROR"), warn: count("WARN"), info: count("INFO"),
      suppressed: (rep.suppressed ?? []).length,
      fit_to_publish: count("ERROR") === 0,
      rules,
    };
  }

  return {
    meta: {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      reference_date: referenceDate,
      runtime_fetch_only: "documentation only — the tested sentinel is data._sentinel",
      workbook: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        content_sha256: createHash("sha256").update(JSON.stringify(dataBlock(ds))).digest("hex"),
        version_label: basename(workbookPath).match(/v\d+/)?.[0] ?? null,
        source_path: basename(workbookPath),
      },
      validator,
    },
    data: {
      _sentinel: SENTINEL,
      events: ds.events, comps: ds.comps, links: ds.links, rank: ds.rank,
      standings: ds.standings, cuts: ds.cuts, fixtures: ds.fixtures, qualified: ds.qualified,
    },
  };
}

// CLI
if (import.meta.url === new URL(process.argv[1], "file://").href || process.argv[1]?.endsWith("emit-data.mjs")) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const workbook = args.find(a => a.endsWith(".xlsx"));
  if (!workbook) { console.error("usage: node tools/emit-data.mjs <workbook.xlsx> [--out f] [--report f] [--reference-date d]"); process.exit(2); }
  const artefact = emit(workbook, { reportPath: flag("--report"), referenceDate: flag("--reference-date") });
  const out = flag("--out") ?? "data.json";
  // JSON.stringify drops the Symbol-keyed RAW view — rows serialize clean.
  writeFileSync(out, JSON.stringify(artefact));
  const d = artefact.data;
  console.log(`written ${out} — ${Object.keys(d).filter(k => k !== "_sentinel").map(k => `${k}:${d[k].length}`).join(" ")}` +
    ` · workbook ${artefact.meta.workbook.version_label} (${artefact.meta.workbook.sha256.slice(0, 8)})` +
    ` · validator ${artefact.meta.validator ? `${artefact.meta.validator.error}E/${artefact.meta.validator.warn}W/${artefact.meta.validator.info}I` : "not embedded"}`);
}
