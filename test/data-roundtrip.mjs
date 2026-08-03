/**
 * Stage-four anti-fork harness (docs/stage-four.md §5): the data.json path
 * and the workbook path must produce IDENTICAL app outcomes. In CI this
 * runs between emit and publish against the pulled workbook; locally it
 * runs against the current workbook. Two transports, one cleaner — if they
 * ever drift, this fails before anything ships.
 *
 * Usage: node test/data-roundtrip.mjs [workbook.xlsx] [--ci]
 *
 * --ci (the CI chain, running against the PULLED workbook): every
 * equivalence and format assertion runs unchanged, but the v19 census pins
 * (exactly 154 midnights, the 5 named date-only ids, 13 null dates, 14 null
 * starts) become both-paths-identical checks — they pin a workbook, not the
 * contract, and a routine data refresh must not fail the publish chain on
 * them. Local default runs keep the pins as regression checks.
 */
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { loadWorkbook, RAW } from "../src/lib/load.ts";
import { emit, SENTINEL } from "../tools/emit-data.mjs";

const root = new URL("..", import.meta.url).pathname;
const argv = process.argv.slice(2);
const CI = argv.includes("--ci");
const WB = argv.find(a => !a.startsWith("--")) ?? root + "data/LA28_Qualification_Database_v21.xlsx";
if (CI) console.log("(--ci: v19 census pins run as both-paths-identical checks)");

await build({
  entryPoints: [root + "test/entry.mjs"],
  bundle: true, format: "esm",
  outfile: root + "test/.build/app.bundle.roundtrip.mjs",
  jsx: "automatic",
  alias: {
    "react": root + "test/stubs/react.js",
    "react/jsx-runtime": root + "test/stubs/jsx-runtime.js",
    "xlsx": root + "test/stubs/xlsx.js",
    "papaparse": root + "test/stubs/papaparse.js",
  },
  logLevel: "silent",
});
const app = await import(pathToFileURL(root + "test/.build/app.bundle.roundtrip.mjs"));
const React = app.ReactStub;
const { Explorer, normalise } = app;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// Path A: workbook → loader → strip → normalise (the harness path, as ever).
const ds = loadWorkbook(WB);
const strip = rows => rows.map(r => { const o = { ...r }; delete o[RAW]; return o; });
const rawA = { events: strip(ds.events), comps: strip(ds.comps), links: strip(ds.links),
               rank: strip(ds.rank), standings: strip(ds.standings), cuts: strip(ds.cuts),
               fixtures: strip(ds.fixtures), qualified: strip(ds.qualified) };

// Path B: workbook → emit → JSON round-trip (stringify+parse, exactly what
// the wire does) → normalise. The extra _sentinel key must be ignored.
const artefact = JSON.parse(JSON.stringify(emit(WB)));
const rawB = artefact.data;

// Artefact shape checks.
check("data._sentinel present inside the payload", rawB._sentinel === SENTINEL);
check("meta.schema_version = 1", artefact.meta.schema_version === 1);
check("meta.workbook.sha256 is a 64-char hex", /^[0-9a-f]{64}$/.test(artefact.meta.workbook.sha256));
check("meta.workbook.content_sha256 present (dual-hash: content identity, distinct from raw bytes)",
  /^[0-9a-f]{64}$/.test(artefact.meta.workbook.content_sha256)
    && artefact.meta.workbook.content_sha256 !== artefact.meta.workbook.sha256);
check("rows serialize without the RAW view (Symbol dropped by JSON)",
  !JSON.stringify(rawB).includes("Symbol") && Object.getOwnPropertySymbols(rawB.links[0] ?? {}).length === 0);
for (const k of Object.keys(rawA))
  check(`row count identical: ${k} (${rawA[k].length})`, rawA[k].length === rawB[k].length);
check("cleaned rows byte-identical after JSON round-trip",
  JSON.stringify(rawA) === JSON.stringify({ ...rawB, _sentinel: undefined, ...{} }) ||
  JSON.stringify(rawA) === JSON.stringify(Object.fromEntries(Object.entries(rawB).filter(([k]) => k !== "_sentinel"))));

// App outcomes on both paths.
const outcomes = raw => {
  const { data, problems } = normalise(raw);
  if (!data) throw new Error("normalise returned no data: " + JSON.stringify(problems));
  let idx = null;
  React.__tapMemo(v => { if (v && typeof v === "object" && typeof v.fixtureVerdict === "function") idx = v; });
  React.__resetHooks();
  React.renderToText(React.createElement(Explorer, { data, meta: {}, problems: [], onReset: () => {}, onLoad: () => {}, busy: false }));
  React.__tapMemo(null);
  return {
    fxAll: data.fx,                                             // every derived fixture row, dates included
    fxDates: data.fx.map(f => f[1]),                            // toStamp output for all fixtures
    compDates: Object.fromEntries(data.comps.map(c => [c.competition_id, [c.start_date, c.end_date]])),
    rankDates: Object.fromEntries(data.rank.map(r => [r.ranking_id,
      [r.window_start ?? null, r.window_end ?? null, r.cutoff_date ?? null, r.next_refresh_expected ?? null]])),
    cutDeadlines: Object.fromEntries(data.cuts.map(c => [c.cut_line_id, c.deadline ?? null])),
    problems: problems.filter(p => p.level !== "info").length,
    fx: data.fx.length,
    berthSum: idx.berthSum,
    thresholds: Object.fromEntries(Object.entries(idx.thresholds).map(([r, ts]) => [r, ts.map(t => `${t.cut.cut_line_id}@${t.atRank}`)])),
    blocked: Object.fromEntries(Object.entries(idx.blocked).map(([r, bs]) => [r, bs.map(b => `${b.cut.cut_line_id}:${b.reason}`)])),
    cricketVerdict: idx.fixtureVerdict("pakistan-women-s-cricket-team-in-sri-lanka-in-2026", "Sri Lanka Women", "Pakistan Women", "2026-07-31")?.why,
    concacafFinal: idx.placement("2026-concacaf-u-20-championship", "Final")?.chip,
    africaRoutes: idx.placement("2027-fiba-basketball-world-cup-qualification-africa", "Second round · Window 4")?.routesTotal,
  };
};
const A = outcomes(rawA), B = outcomes(rawB);
check("normalise problem count identical", A.problems === B.problems, `${A.problems} vs ${B.problems}`);
check(`fixture count identical (${A.fx})`, A.fx === B.fx);
check("berth sums identical across all events", JSON.stringify(A.berthSum) === JSON.stringify(B.berthSum));
check("thresholds identical (cut ids and ranks)", JSON.stringify(A.thresholds) === JSON.stringify(B.thresholds));
check("blocked sets identical (ids and reasons)", JSON.stringify(A.blocked) === JSON.stringify(B.blocked));
check("sample ranking verdict identical", A.cricketVerdict === B.cricketVerdict && !!A.cricketVerdict);
check("sample placement verdict identical", A.concacafFinal === B.concacafFinal && A.concacafFinal === "1 win from title");
check("sample route count identical", A.africaRoutes === B.africaRoutes && A.africaRoutes === 3);

// ---- Exhaustive date round-trip: every dated row, both paths (not samples) ----
console.log("\nDate round-trip (every row):");
check(`ALL ${A.fxDates.length} fixture toStamp outputs identical`,
  JSON.stringify(A.fxDates) === JSON.stringify(B.fxDates));
check("ALL derived fixture rows identical (every column)",
  JSON.stringify(A.fxAll) === JSON.stringify(B.fxAll));
{
  const nullsA = A.fxDates.filter(d => d === null).length, nullsB = B.fxDates.filter(d => d === null).length;
  check(CI ? `null fixture dates identical on both paths (A=${nullsA}, B=${nullsB})`
           : `null fixture dates: exactly 13 on both paths (A=${nullsA}, B=${nullsB})`,
    CI ? nullsA === nullsB : nullsA === 13 && nullsB === 13);
  const midA = A.fxDates.filter(d => d && d.endsWith(" 00:00")).length;
  const midB = B.fxDates.filter(d => d && d.endsWith(" 00:00")).length;
  check(CI ? `app-midnight count identical on both paths (A=${midA}, B=${midB})`
           : `app-midnight count is exactly 154 on both paths — 149 midnight datetimes + 5 date-only strings (A=${midA}, B=${midB})`,
    CI ? midA === midB : midA === 154 && midB === 154);
  // The stamp format is load-bearing: fxByComp orders fixtures by
  // localeCompare on the full stamp, where an unpadded "8:00" sorts after
  // "10:00". Nothing but this assertion proves every stamp is padded.
  const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
  const badA = A.fxDates.filter(d => d !== null && !STAMP.test(d));
  const badB = B.fxDates.filter(d => d !== null && !STAMP.test(d));
  check(`every non-null derived stamp matches ^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$ on both paths (${A.fxDates.length - 13} stamps)`,
    badA.length === 0 && badB.length === 0, [...badA, ...badB].slice(0, 5).join(", "));
}
{
  // String-typed (date-only) fixture dates: exact set pinned locally; the
  // midnight-derivation contract asserted in both modes.
  const dateOnly = ds.fixtures.filter(f => typeof f.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f.date));
  if (!CI)
    check(`exactly 5 date-only string fixture dates found (${dateOnly.map(f => f.fixture_id).join(", ")})`,
      dateOnly.length === 5);
  const ok = dateOnly.every(f => {
    const want = `${f.date} 00:00`;
    const ia = ds.fixtures.indexOf(f);
    return A.fxDates[ia] === want && B.fxDates[ia] === want;
  });
  check(`all ${dateOnly.length} date-only strings derive '<date> 00:00' (midnight survives as midnight) on both paths`, ok);
}
{
  // RELATION GUARD (runs in --ci too; refresh-proof because it compares each
  // row to its own source cell, never to a pinned count). Its independence,
  // stated precisely rather than implied:
  //  - The string relation below is anchored on the LOADER-RENDERED string
  //    (SheetJS numFmt rendering, raw:false — load.ts), which is upstream of
  //    both parsers but downstream of cell→text. RAW is no deeper: load.ts
  //    stores the same formatted string under RAW, not the cell serial.
  //  - The recognised-format regex T shares its origin with toStamp's regex
  //    (same author, same change). A NOVEL format still always trips the
  //    unrecognised check — it keys on T alone, and toStamp's leniency
  //    (Date fallback) cannot blind it. The residual is both regexes being
  //    edited into the same wrong reading in tandem.
  //  - Both residuals are why the SERIAL ANCHOR below exists: it re-reads
  //    the cells raw:true and derives the time from the Excel serial's
  //    fraction — bypassing numFmt, T and toStamp entirely. numFmt cannot
  //    hide a time from it; only the workbook cell itself is trusted.
  // The string relation is the check that would have caught the
  // single-digit-hour bug: the format assertion above matched
  // "2026-08-27 00:00" perfectly, and both-paths-identical held throughout
  // the bug's life, so neither guards a recurrence.
  const src = ds.fixtures.filter(r => r.competition_id);   // same filter as normalise(); count identity asserted above
  const T = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
  const expectStamp = v => {
    const m = String(v).trim().match(T);
    return m ? `${m[1]} ${String(m[2] ?? "0").padStart(2, "0")}:${m[3] ?? "00"}` : undefined;
  };
  const unrecognised = [], mismatches = [];
  src.forEach((f, i) => {
    if (f.date === null || f.date === undefined || f.date === "") return;   // null derivation asserted above
    const want = expectStamp(f.date);
    if (want === undefined) { unrecognised.push(`${f.fixture_id}: "${f.date}"`); return; }
    if (A.fxDates[i] !== want || B.fxDates[i] !== want)
      mismatches.push(`${f.fixture_id}: source "${f.date}" derived ${A.fxDates[i]} — expected ${want}`);
  });
  check("relation: every derived stamp equals an independent parse of its source cell (silent time loss impossible)",
    mismatches.length === 0, mismatches.slice(0, 5).join(" · "));
  check("no fixture date in an unrecognised source format (a new format must be a decision, not silence)",
    unrecognised.length === 0, unrecognised.slice(0, 5).join(", "));

  // RED DIRECTION, permanent: the pre-fix parser (two-digit hour group,
  // no pad) applied to the same sources must violate the relation on every
  // single-digit-hour real time — exactly 47 on v19; on other workbooks,
  // however many such sources exist (vacuously 0 = 0 if none).
  const preFix = v => {
    const m = String(v).trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    return m ? `${m[1]} ${m[2] ?? "00"}:${m[3] ?? "00"}` : null;
  };
  const withDate = src.filter(f => f.date && expectStamp(f.date) !== undefined);
  const violations = withDate.filter(f => preFix(f.date) !== expectStamp(f.date));
  const census = withDate.filter(f => {
    const m = String(f.date).trim().match(T);
    return m?.[2]?.length === 1 && !(m[2] === "0" && m[3] === "00");
  });
  check(`red direction: pre-fix parser violates the relation on every single-digit-hour time (${violations.length} = ${census.length}${CI ? "" : ", pinned 47 on v19"})`,
    violations.length === census.length && (CI || violations.length === 47));

  // SERIAL ANCHOR: the independent leg. Re-read the Fixtures sheet raw
  // (numbers, not formatted text) and derive each datetime cell's time from
  // the serial fraction itself. Anything numFmt hid — or both regexes agree
  // to drop — disagrees with the serial and fails here.
  const XLSXmod = (await import("xlsx")).default;
  const { readFileSync: readBytes } = await import("node:fs");
  const wbRaw = XLSXmod.read(readBytes(WB), { cellDates: false });
  const fxSheetName = wbRaw.SheetNames.find(n => n.trim().toLowerCase() === "fixtures");
  const rawRows = XLSXmod.utils.sheet_to_json(wbRaw.Sheets[fxSheetName], { header: 1, raw: true, defval: null });
  const rawHead = rawRows[0].map(h => String(h ?? "").trim().toLowerCase());
  const [cId, cDate] = [rawHead.indexOf("fixture_id"), rawHead.indexOf("date")];
  const serialOf = new Map(rawRows.slice(1).filter(r => r[cId] != null).map(r => [String(r[cId]), r[cDate]]));
  const pad2 = n => String(n).padStart(2, "0");
  const serialStamp = ser => {
    let days = Math.floor(ser);
    let mins = Math.round((ser - days) * 1440);          // serial fraction → minutes, binary error absorbed
    if (mins === 1440) { days += 1; mins = 0; }
    const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
  };
  let serialCells = 0; const serialMismatches = [];
  src.forEach((f, i) => {
    const raw = serialOf.get(String(f.fixture_id));
    if (typeof raw !== "number") return;                 // string cells covered by the T relation; nulls asserted above
    serialCells++;
    const want = serialStamp(raw);
    if (A.fxDates[i] !== want || B.fxDates[i] !== want)
      serialMismatches.push(`${f.fixture_id}: serial ${raw} → ${want}, derived ${A.fxDates[i]}`);
  });
  check(`serial anchor: all ${serialCells} datetime cells' derived stamps equal the time in the raw serial (numFmt bypassed)${CI ? "" : " — 298 on v19"}`,
    serialMismatches.length === 0 && (CI || serialCells === 298), serialMismatches.slice(0, 5).join(" · "));
}

check(`ALL ${Object.keys(A.compDates).length} competitions' start/end dates identical`,
  JSON.stringify(A.compDates) === JSON.stringify(B.compDates));
if (!CI) {
  const nullStarts = Object.values(A.compDates).filter(([s]) => s === null).length;
  check(`null competition start_dates: exactly 14 (${nullStarts})`, nullStarts === 14);
}
check(`ALL ${Object.keys(A.rankDates).length} rankings' window/cutoff/next_refresh dates identical`,
  JSON.stringify(A.rankDates) === JSON.stringify(B.rankDates));
check(`ALL ${Object.keys(A.cutDeadlines).length} cut-line deadlines identical`,
  JSON.stringify(A.cutDeadlines) === JSON.stringify(B.cutDeadlines));
{
  // Emit-path type coercion report: date values in the artefact must be
  // string|null only (the loader renders dates to text; JSON adds nothing).
  const bad = [];
  for (const f of rawB.fixtures) if (f.date !== null && typeof f.date !== "string") bad.push(f.fixture_id);
  for (const c of rawB.comps) for (const k of ["start_date", "end_date"]) if (c[k] !== null && typeof c[k] !== "string") bad.push(`${c.competition_id}.${k}`);
  check("emit performs no date type coercion: every artefact date is string or null", bad.length === 0,
    bad.slice(0, 5).join(", "));
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nRound-trip clean: the data.json path and the workbook path are the same app.");
process.exit(failures ? 1 : 0);
