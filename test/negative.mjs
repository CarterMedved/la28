/**
 * Negative tests: a rule that has never fired is not known to work.
 * Each case copies the real workbook, applies one mutation in memory, writes
 * a mutant .xlsx to test/mutants/, runs the CLI on it, and asserts that the
 * expected rule key appears in the JSON report with the expected severity.
 * The source workbook is never touched.
 *
 * Rules that already fire on the REAL workbook are asserted against the real
 * report instead of a mutant (listed at the bottom).
 */
import * as XLSX from "xlsx";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const SRC = root + "data/LA28_Qualification_Database.xlsx";
const MUT = root + "test/mutants/";
mkdirSync(MUT, { recursive: true });
const REF = "2026-08-02";

/** workbook → { sheetName: rows[][] } with header row 0 */
function readAoA() {
  const wb = XLSX.read(readFileSync(SRC));
  const out = {};
  for (const n of wb.SheetNames) out[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: null });
  return out;
}
function writeAoA(aoa, path) {
  const wb = XLSX.utils.book_new();
  for (const [n, rows] of Object.entries(aoa)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n);
  XLSX.writeFile(wb, path);
}
const col = (aoa, sheet, name) => aoa[sheet][0].indexOf(name);
/** first data row where predicate on named column holds */
function findRow(aoa, sheet, name, pred) {
  const c = col(aoa, sheet, name);
  for (let i = 1; i < aoa[sheet].length; i++) if (pred(aoa[sheet][i][c])) return i;
  throw new Error(`no row in ${sheet} where ${name} matches`);
}

function runValidator(path, extra = []) {
  const report = path.replace(/\.xlsx$/, ".report.json");
  try {
    execFileSync("node", [root + "src/validate/cli.ts", path, "--reference-date", REF,
      // empty suppression file: negative tests assert rules FIRE, so the
      // project's real known-issues.json (which suppresses documented gaps)
      // must not hide the very findings under test
      "--json", report, "--known-issues", root + "test/known-issues.empty.json", "--sentinels", root + "sentinels.json", ...extra],
      { stdio: "pipe" });
  } catch { /* non-zero exit is expected for ERROR mutants */ }
  return JSON.parse(readFileSync(report, "utf8"));
}

const QHEAD = ["olympic_event_id", "team", "qualified_via", "date", "confidence", "notes"];

let failures = 0;
const check = (label, report, rule, severity, rowIdPart) => {
  const hit = report.findings.find(f => f.rule === rule && f.severity === severity && (!rowIdPart || f.rowId.includes(rowIdPart)));
  console.log(`  ${hit ? "PASS" : "FAIL"}  ${label} → ${rule} [${severity}]${hit ? "" : "  (NOT FOUND)"}`);
  if (!hit) failures++;
};

const CASES = [
  ["berth-changed", "arithmetic/berth-sum", "ERROR", null, a => {
    // bump the first nonzero berths value on a link into an Olympic event
    const i = findRow(a, "Links", "berths", v => Number(v) > 0);
    a.Links[i][col(a, "Links", "berths")] = String(Number(a.Links[i][col(a, "Links", "berths")]) + 1);
  }],
  ["quota-not-a-number", "arithmetic/quota-unreadable", "ERROR", null, a => {
    a.Olympic_Events[1][col(a, "Olympic_Events", "quota_total")] = "twelve";
  }],
  ["berths-on-advancing-edge", "arithmetic/berths-on-non-event", "WARN", null, a => {
    // put berths on a link whose target is a competition (an advancing edge);
    // to keep this a single-finding test, pick a link with no berths currently
    const toT = col(a, "Links", "to_type"), b = col(a, "Links", "berths");
    const i = findRow(a, "Links", "to_type", (v, _i) => false) === -1 ? -1 : -1; // placeholder
  }],
  ["from-id-nonexistent", "referential/links-from_id", "ERROR", null, a => {
    a.Links[1][col(a, "Links", "from_id")] = "no-such-competition-xyz";
  }],
  ["to-id-nonexistent", "referential/links-to_id", "ERROR", null, a => {
    a.Links[1][col(a, "Links", "to_id")] = "no-such-event-xyz";
  }],
  ["cut-line-id-nonexistent", "referential/links-cut_line_id", "ERROR", null, a => {
    const i = findRow(a, "Links", "cut_line_id", v => v != null && String(v).trim() !== "");
    a.Links[i][col(a, "Links", "cut_line_id")] = "no-such-cut";
  }],
  ["gate-ranking-nonexistent", "referential/links-gate_ranking_id", "ERROR", null, a => {
    const i = findRow(a, "Links", "gate_ranking_id", v => v != null && String(v).trim() !== "");
    a.Links[i][col(a, "Links", "gate_ranking_id")] = "no-such-ranking";
  }],
  ["cuts-ranking-nonexistent", "referential/cuts-ranking_id", "ERROR", null, a => {
    a.Cut_Lines[1][col(a, "Cut_Lines", "ranking_id")] = "no-such-ranking";
  }],
  ["standings-ranking-nonexistent", "referential/standings-ranking_id", "ERROR", null, a => {
    a.Standings[1][col(a, "Standings", "ranking_id")] = "no-such-ranking";
  }],
  ["fixture-comp-nonexistent", "referential/fixtures-competition_id", "ERROR", null, a => {
    a.Fixtures[1][col(a, "Fixtures", "competition_id")] = "no-such-comp";
  }],
  ["scheduled-but-past", "state/scheduled-but-past", "ERROR", null, a => {
    const i = findRow(a, "Competitions", "status", v => v === "SCHEDULED");
    a.Competitions[i][col(a, "Competitions", "end_date")] = "2026-01-01";
  }],
  ["in-progress-but-ended", "state/in-progress-but-ended", "ERROR", null, a => {
    const i = findRow(a, "Competitions", "status", v => v === "IN_PROGRESS");
    a.Competitions[i][col(a, "Competitions", "start_date")] = "2026-01-01";
    a.Competitions[i][col(a, "Competitions", "end_date")] = "2026-02-01";
  }],
  ["qualified-and-provisional", "state/qualified-and-provisional", "ERROR", "United States", a => {
    const i = findRow(a, "Standings", "provisional", v => v === "Y");
    a.Standings[i][col(a, "Standings", "already_qualified")] = "Y";
  }],
  ["duplicate-rank-diff-rating", "state/duplicate-rank-diff-rating", "ERROR", null, a => {
    // give Netherlands the same rank as UAE but keep their different ratings
    const i = findRow(a, "Standings", "team", v => v === "Netherlands");
    a.Standings[i][col(a, "Standings", "rank")] = "15";
  }],
  ["tie-at-threshold", "state/tie-at-threshold", "WARN", null, a => {
    // unbroken tie at the men's FOGQT edge (rank 12, Ireland): clone Ireland's
    // rank AND rating onto Zimbabwe (rank 11 -> 12, same rating)
    const rIre = findRow(a, "Standings", "team", v => v === "Ireland");
    const rZim = findRow(a, "Standings", "team", v => v === "Zimbabwe");
    a.Standings[rZim][col(a, "Standings", "rank")] = a.Standings[rIre][col(a, "Standings", "rank")];
    a.Standings[rZim][col(a, "Standings", "rating")] = a.Standings[rIre][col(a, "Standings", "rating")];
  }],
  ["applies-to-absent-nation", "state/applies-to-binds-nothing", "ERROR", "icc-m-host-top15", a => {
    const i = findRow(a, "Cut_Lines", "cut_line_id", v => v === "icc-m-host-top15");
    a.Cut_Lines[i][col(a, "Cut_Lines", "applies_to")] = "Sri Lanka Cricket Board XI of Atlantis";
  }],
  ["stale-standings", "coverage/stale-standings", "WARN", null, a => {
    // age every as_of in the men's table past 30 days
    const rid = col(a, "Standings", "ranking_id"), asOf = col(a, "Standings", "as_of");
    for (let i = 1; i < a.Standings.length; i++)
      if (a.Standings[i][rid] === "icc-mens-t20i-team-ranking") a.Standings[i][asOf] = "2026-05-01";
  }],
  ["blank-confederation-on-graph", "coverage/blank-confederation", "WARN", null, a => {
    // blank the confederation of a competition with a non-RANKING_POINTS outbound link
    const from = col(a, "Links", "from_id"), rel = col(a, "Links", "relationship");
    const link = a.Links.slice(1).find(r => r[rel] && r[rel] !== "RANKING_POINTS" &&
      a.Competitions.slice(1).some(c => c[col(a, "Competitions", "competition_id")] === r[from]));
    const i = findRow(a, "Competitions", "competition_id", v => v === link[from]);
    a.Competitions[i][col(a, "Competitions", "confederation")] = null;
  }],
  ["duplicate-fixture-swapped-teams", "coverage/duplicate-fixture", "WARN", null, a => {
    const row = [...a.Fixtures[1]];
    const t1 = col(a, "Fixtures", "team1"), t2 = col(a, "Fixtures", "team2"), fid = col(a, "Fixtures", "fixture_id");
    [row[t1], row[t2]] = [row[t2], row[t1]];
    row[fid] = "mutant-dup-fixture";
    a.Fixtures.push(row);
  }],
  ["nan-literal", "hygiene/nan-literal", "WARN", null, a => {
    a.Competitions[1][col(a, "Competitions", "location")] = "nan";
  }],
  ["id-trailing-space", "hygiene/id-whitespace", "ERROR", null, a => {
    const c = col(a, "Fixtures", "fixture_id");
    a.Fixtures[1][c] = a.Fixtures[1][c] + " ";
  }],
  ["id-curly-apostrophe", "hygiene/id-unicode", "WARN", null, a => {
    const c = col(a, "Competitions", "competition_id");
    a.Competitions[1][c] = String(a.Competitions[1][c]).replace(/-/, "’");
  }],
  ["fixture-before-start", "coverage/fixtures-before-start", "WARN", null, a => {
    // pull one fixture's date a year before its competition's start_date
    const cid = col(a, "Fixtures", "competition_id"), d = col(a, "Fixtures", "date");
    const compId = a.Fixtures[1][cid];
    a.Fixtures[1][d] = "2024-01-01";
    void compId;
  }],
  ["confirmed-start-equals-end", "state/confirmed-placeholder-dates", "ERROR", null, a => {
    // collapse a CONFIRMED competition's window to a single stamped day
    const i = findRow(a, "Competitions", "date_confidence", v => v === "CONFIRMED");
    const s = a.Competitions[i][col(a, "Competitions", "start_date")];
    a.Competitions[i][col(a, "Competitions", "end_date")] = s;
  }],
  ["confirmed-month-span-empty", "state/confirmed-placeholder-dates", "ERROR", "mutant-fom", a => {
    // CONFIRMED month-boundary window (1st -> last day) with no fixtures at all
    const row = new Array(a.Competitions[0].length).fill(null);
    row[col(a, "Competitions", "competition_id")] = "mutant-fom";
    row[col(a, "Competitions", "name")] = "Mutant Placeholder Cup";
    row[col(a, "Competitions", "start_date")] = "2027-03-01";
    row[col(a, "Competitions", "end_date")] = "2027-03-31";
    row[col(a, "Competitions", "date_confidence")] = "CONFIRMED";
    a.Competitions.push(row);
  }],
  ["completed-without-outcome-mutant", "state/completed-without-outcome", "ERROR", "mutant-done", a => {
    // COMPLETE competition: no fixtures, no qualified_via citation, no downstream field
    const row = new Array(a.Competitions[0].length).fill(null);
    row[col(a, "Competitions", "competition_id")] = "mutant-done";
    row[col(a, "Competitions", "name")] = "Mutant Concluded Cup";
    row[col(a, "Competitions", "start_date")] = "2026-03-02";
    row[col(a, "Competitions", "end_date")] = "2026-03-09";
    row[col(a, "Competitions", "status")] = "COMPLETE";
    a.Competitions.push(row);
  }],
  ["missing-earlier-rounds-mutant", "coverage/missing-earlier-rounds", "WARN", "mutant-comp", a => {
    // synthetic competition whose only fixture is second-round, no first round
    const row = new Array(a.Competitions[0].length).fill(null);
    row[col(a, "Competitions", "competition_id")] = "mutant-comp";
    row[col(a, "Competitions", "name")] = "Mutant Cup";
    a.Competitions.push(row);
    const fr = new Array(a.Fixtures[0].length).fill(null);
    fr[col(a, "Fixtures", "fixture_id")] = "mutant-r2";
    fr[col(a, "Fixtures", "competition_id")] = "mutant-comp";
    fr[col(a, "Fixtures", "date")] = "2026-09-01";
    fr[col(a, "Fixtures", "team1")] = "A"; fr[col(a, "Fixtures", "team2")] = "B";
    fr[col(a, "Fixtures", "stage")] = "Second round · Window 1";
    a.Fixtures.push(fr);
  }],
  ["round-robin-missing-return-leg", "coverage/round-robin-incomplete", "WARN", "2027-fiba-basketball-world-cup-qualification-americas", a => {
    // delete one leg of a home-and-away pair: the pair drops to 1 appearance
    // and the group becomes irregular
    const cid = col(a, "Fixtures", "competition_id");
    const i = a.Fixtures.findIndex((r, idx) => idx > 0 && r[cid] === "2027-fiba-basketball-world-cup-qualification-americas");
    a.Fixtures.splice(i, 1);
  }],
  ["round-robin-duplicate-pair", "coverage/round-robin-incomplete", "WARN", "2026-concacaf-u-20-championship", a => {
    // clone a single-round-robin group fixture: the pair now appears twice
    const cid = col(a, "Fixtures", "competition_id"), st = col(a, "Fixtures", "stage"), fid = col(a, "Fixtures", "fixture_id");
    const i = a.Fixtures.findIndex((r, idx) => idx > 0 && r[cid] === "2026-concacaf-u-20-championship" && /group stage/i.test(String(r[st])));
    const row = [...a.Fixtures[i]];
    row[fid] = "mutant-dup-pair";
    a.Fixtures.push(row);
  }],
  ["qualified-bad-event", "referential/qualified-olympic_event_id", "ERROR", null, a => {
    a.Qualified = [QHEAD, ["no-such-event", "Brazil", "copa-america-femenina-2025", null, "CONFIRMED", null]];
  }],
  ["qualified-via-label", "referential/qualified-via", "ERROR", null, a => {
    a.Qualified = [QHEAD, ["la28-football-w", "Brazil", "Copa América Femenina 2025", null, "CONFIRMED", null]];
  }],
  ["qualified-duplicate", "referential/qualified-duplicate", "ERROR", null, a => {
    const r = ["la28-football-w", "Brazil", "copa-america-femenina-2025", null, "CONFIRMED", null];
    a.Qualified = [QHEAD, r, [...r]];
  }],
  ["qualified-overfill-link", "arithmetic/qualified-overfill-link", "ERROR", null, a => {
    // Copa América awards 2 berths (fbl-015); settle 3 through it
    a.Qualified = [QHEAD,
      ["la28-football-w", "Brazil", "copa-america-femenina-2025", null, "CONFIRMED", null],
      ["la28-football-w", "Colombia", "copa-america-femenina-2025", null, "CONFIRMED", null],
      ["la28-football-w", "Argentina", "copa-america-femenina-2025", null, "CONFIRMED", null]];
  }],
  ["qualified-overfill-event", "arithmetic/qualified-overfill-event", "ERROR", "la28-cricket-w", a => {
    // quota_total for la28-cricket-w is 6; settle 7
    const teams = ["Australia", "Great Britain", "India", "South Africa", "Sri Lanka", "Pakistan", "Ireland"];
    a.Qualified = [QHEAD, ...teams.map(t => ["la28-cricket-w", t, "icc-womens-t20-world-cup-2026", null, "CONFIRMED", null])];
  }],
  ["stored-qualification-shadowed", "state/stored-qualification-shadowed", "ERROR", null, a => {
    // manage la28-cricket-w via Qualified while the stored AQ cells remain
    a.Qualified = [QHEAD, ["la28-cricket-w", "Australia", "icc-womens-t20-world-cup-2026", null, "CONFIRMED", null]];
  }],
  ["qualified-bad-hold-status", "referential/qualified-hold_status", "ERROR", null, a => {
    a.Qualified = [[...QHEAD, "hold_status"],
      ["la28-football-w", "Brazil", "copa-america-femenina-2025", null, "CONFIRMED", null, "PENDING"]];
  }],
  ["complete-missing-dates-mutant", "state/complete-missing-dates", "ERROR", null, a => {
    const i = findRow(a, "Competitions", "status", v => v === "COMPLETE");
    a.Competitions[i][col(a, "Competitions", "start_date")] = null;
    a.Competitions[i][col(a, "Competitions", "end_date")] = null;
  }],
  ["id-unicode-twins", "hygiene/id-unicode-twins", "WARN", null, a => {
    const c = col(a, "Competitions", "competition_id");
    const row = [...a.Competitions[1]];
    row[c] = String(row[c]).replace(/-/, "–");   // en-dash twin of a real id
    a.Competitions.push(row);
  }],
];

console.log("Mutant tests (one mutation per copy, source workbook untouched):");
for (const [name, rule, severity, rowIdPart, mutate] of CASES) {
  if (name === "berths-on-advancing-edge") continue; // handled below with a direct edit
  const aoa = readAoA();
  mutate(aoa);
  const path = MUT + name + ".xlsx";
  writeAoA(aoa, path);
  check(name, runValidator(path), rule, severity, rowIdPart);
}

// berths-on-advancing-edge needs its own construction: find a link to a COMP target
{
  const aoa = readAoA();
  const toType = col(aoa, "Links", "to_type"), b = col(aoa, "Links", "berths");
  const i = aoa.Links.findIndex((r, idx) => idx > 0 && r[toType] === "COMPETITION" && (r[b] == null || String(r[b]).trim() === ""));
  aoa.Links[i][b] = "3";
  const path = MUT + "berths-on-advancing-edge.xlsx";
  writeAoA(aoa, path);
  check("berths-on-advancing-edge", runValidator(path), "arithmetic/berths-on-non-event", "WARN", null);
}

console.log("\nRules asserted against the REAL workbook (they fire there by design):");
const real = runValidator(SRC.replace(MUT, "")); // real workbook, real report
for (const [rule, severity, rowIdPart] of [
  ["referential/cuts-leads_to", "ERROR", "fiba-m-fopqt-7"],
  ["state/complete-but-future", "ERROR", null],
  ["state/in-progress-not-started", "ERROR", null],
  ["state/tie", "INFO", "rank72"],
  ["coverage/cut-line-blocked", "WARN", "fiba-m-fopqt-7"],
  ["coverage/cut-line-zero-headroom", "WARN", "icc-m-host-top15"],
  ["coverage/past-fixtures-no-result", "WARN", null],
  ["coverage/unlinked-competition", "WARN", null],
  ["state/confirmed-placeholder-dates", "ERROR", "eurobasket-women-2027-qualification"],
  ["coverage/missing-earlier-rounds", "WARN", "2027-fiba-basketball-world-cup-qualification-africa"],
  ["coverage/placeholder-fixtures", "WARN", "fiba-women-s-afrobasket-2027-qualifiers"],
  ["coverage/round-robin-incomplete", "WARN", "2026-baseball-european-championship-b-pool-group-bulgaria"],
  ["state/completed-without-outcome", "ERROR", "caf-w-oqt-2028-r1"],
  ["state/complete-missing-dates", "ERROR", "afc-womens-asian-cup-2026"],
]) check(`real workbook`, real, rule, severity, rowIdPart);

// Suppression mechanics: suppress one real finding, confirm it moves to the
// suppressed list and the count is printed.
// Negative-space check: outcomes captured via qualified_via must NOT fire.
{
  const miss = real.findings.find(f => f.rule === "state/completed-without-outcome" && f.rowId === "icc-womens-t20-world-cup-2026");
  console.log(`  ${miss ? "FAIL" : "PASS"}  icc-womens-t20-world-cup-2026 passes completed-without-outcome (cited in qualified_via)`);
  if (miss) failures++;
}
// past-fixtures-no-result: named form at <=5 missing, aggregate above.
console.log("\npast-fixtures-no-result forms:");
{
  // real workbook (v7 baseline used by `real` above may differ; test the CURRENT source):
  const named = real.findings.find(f => f.rule === "coverage/past-fixtures-no-result");
  const isNamed = named && /Missing:\n/.test(named.message) && /fx-\d+/.test(named.message);
  const count = named ? Number(named.message.match(/^(\d+) of/)?.[1]) : null;
  const ok = named && (count <= 5 ? isNamed : !isNamed);
  console.log(`  ${ok ? "PASS" : "FAIL"}  real workbook (${count} missing) uses the ${count <= 5 ? "named" : "aggregate"} form`);
  if (!ok) failures++;
}
{
  // force >5 missing: strip results from six past fixtures → aggregate form
  const aoa = readAoA();
  const iRes = col(aoa, "Fixtures", "result"), iDate = col(aoa, "Fixtures", "date");
  let stripped = 0;
  for (let i = 1; i < aoa.Fixtures.length && stripped < 6; i++) {
    const d = String(aoa.Fixtures[i][iDate] ?? "").slice(0, 10);
    if (d && d < REF && aoa.Fixtures[i][iRes] != null) { aoa.Fixtures[i][iRes] = null; stripped++; }
  }
  const p = MUT + "many-missing-results.xlsx";
  writeAoA(aoa, p);
  const rep = runValidator(p);
  const f = rep.findings.find(f => f.rule === "coverage/past-fixtures-no-result");
  const ok = f && !/Missing:\n/.test(f.message) && /\d+ of \d+ past fixtures/.test(f.message);
  console.log(`  ${ok ? "PASS" : "FAIL"}  >5 missing collapses to the aggregate form`);
  if (!ok) failures++;
}

// undated-fixtures — both directions.
console.log("\nundated-fixtures directions:");
{
  // fire: blank the date on one fixture → the aggregate WARN lists it by id
  const aoa = readAoA();
  const i = findRow(aoa, "Fixtures", "date", v => v != null && String(v).trim() !== "");
  const fid = aoa.Fixtures[i][col(aoa, "Fixtures", "fixture_id")];
  aoa.Fixtures[i][col(aoa, "Fixtures", "date")] = null;
  const p = MUT + "undated-fixture.xlsx";
  writeAoA(aoa, p);
  const rep = runValidator(p);
  const f = rep.findings.find(f => f.rule === "coverage/undated-fixtures" && f.severity === "WARN");
  const ok = f && f.message.includes(String(fid));
  console.log(`  ${ok ? "PASS" : "FAIL"}  one date blanked → coverage/undated-fixtures fires and names ${fid}`);
  if (!ok) failures++;
}
{
  // silent: the source workbook has every fixture dated
  const hit = real.findings.find(f => f.rule === "coverage/undated-fixtures");
  console.log(`  ${hit ? "FAIL" : "PASS"}  source workbook (all fixtures dated) → rule silent`);
  if (hit) failures++;
}

// next_refresh_expected semantics — four directions on mutants (the base
// workbook predates the column; each mutant adds it and pins as_of so the
// arithmetic is deterministic), plus real-v18 silence.
console.log("\nnext_refresh_expected semantics:");
{
  const mutant = (name, nre, asOf) => {
    const aoa = readAoA();
    aoa.Ranking_Systems[0].push("next_refresh_expected");
    const newIdx = aoa.Ranking_Systems[0].length - 1;
    const iR = col(aoa, "Ranking_Systems", "ranking_id");
    for (let i = 1; i < aoa.Ranking_Systems.length; i++)
      aoa.Ranking_Systems[i][newIdx] = aoa.Ranking_Systems[i][iR] === "icc-mens-t20i-team-ranking" ? nre : null;
    const rid = col(aoa, "Standings", "ranking_id"), a2 = col(aoa, "Standings", "as_of");
    for (let i = 1; i < aoa.Standings.length; i++)
      if (aoa.Standings[i][rid] === "icc-mens-t20i-team-ranking") aoa.Standings[i][a2] = asOf;
    const p = MUT + name + ".xlsx";
    writeAoA(aoa, p);
    return runValidator(p).findings.filter(f => f.rowId === "icc-mens-t20i-team-ranking");
  };
  { // overdue: past the declared date, standings still older than it → stale (declared form)
    const fs2 = mutant("nre-overdue", "2026-07-20", "2026-07-10");
    const ok = fs2.some(f => f.rule === "coverage/stale-standings" && /declared refresh threshold/.test(f.message));
    console.log(`  ${ok ? "PASS" : "FAIL"}  past nre, as_of older → stale-standings in the declared form`);
    if (!ok) failures++;
  }
  { // refreshed but not re-declared → refresh-undeclared, and NOT stale
    const fs2 = mutant("nre-undeclared", "2026-07-20", "2026-07-25");
    const ok = fs2.some(f => f.rule === "coverage/refresh-undeclared") && !fs2.some(f => f.rule === "coverage/stale-standings");
    console.log(`  ${ok ? "PASS" : "FAIL"}  refreshed past nre without re-declaring → refresh-undeclared, not stale`);
    if (!ok) failures++;
  }
  { // fat-fingered far-future date → refresh-horizon fires NOW, and no stale (the silenced state is visible)
    const fs2 = mutant("nre-horizon", "2027-06-01", "2026-07-25");
    const ok = fs2.some(f => f.rule === "coverage/refresh-horizon" && /180-day horizon/.test(f.message))
      && !fs2.some(f => f.rule === "coverage/stale-standings");
    console.log(`  ${ok ? "PASS" : "FAIL"}  nre 311 days past as_of → refresh-horizon fires immediately`);
    if (!ok) failures++;
  }
  { // declared, in range, before the date → fully silent
    const fs2 = mutant("nre-silent", "2026-09-07", "2026-07-25");
    const ok = !fs2.some(f => ["coverage/stale-standings", "coverage/refresh-undeclared", "coverage/refresh-horizon"].includes(f.rule));
    console.log(`  ${ok ? "PASS" : "FAIL"}  declared and in range → silent on all three keys`);
    if (!ok) failures++;
  }
  { // real v18: FIBA declared 2026-09-07 → nothing fires for it at the reference date
    const v18 = runValidator(root + "data/LA28_Qualification_Database_v18.xlsx");
    const fiba = v18.findings.filter(f => f.rowId === "fiba-mens-world-ranking" &&
      ["coverage/stale-standings", "coverage/refresh-undeclared", "coverage/refresh-horizon"].includes(f.rule));
    console.log(`  ${fiba.length ? "FAIL" : "PASS"}  v18: fiba-mens-world-ranking silent under the declared date`);
    if (fiba.length) failures++;
  }
}

// PROVISIONAL rows must NOT count toward overfill — both directions.
console.log("\nProvisional fill-count semantics:");
{
  // Direction 1: 2 SETTLED + 1 PROVISIONAL through Copa's 2-berth link → no overfill finding.
  const aoa = readAoA();
  aoa.Qualified = [[...QHEAD, "hold_status"],
    ["la28-football-w", "Brazil", "copa-america-femenina-2025", null, "CONFIRMED", null, "SETTLED"],
    ["la28-football-w", "Colombia", "copa-america-femenina-2025", null, "CONFIRMED", null, null],
    ["la28-football-w", "Argentina", "copa-america-femenina-2025", null, "CONFIRMED", null, "PROVISIONAL"]];
  const p1 = MUT + "provisional-not-counted.xlsx";
  writeAoA(aoa, p1);
  const rep = runValidator(p1);
  const fired = rep.findings.some(f => f.rule.startsWith("arithmetic/qualified-overfill"));
  console.log(`  ${fired ? "FAIL" : "PASS"}  PROVISIONAL row not counted: 2 settled + 1 provisional in a 2-berth link → no overfill`);
  if (fired) failures++;
}
{
  // Direction 2: same rows with the provisional flipped to SETTLED → overfill fires.
  const aoa = readAoA();
  aoa.Qualified = [[...QHEAD, "hold_status"],
    ["la28-football-w", "Brazil", "copa-america-femenina-2025", null, "CONFIRMED", null, "SETTLED"],
    ["la28-football-w", "Colombia", "copa-america-femenina-2025", null, "CONFIRMED", null, "SETTLED"],
    ["la28-football-w", "Argentina", "copa-america-femenina-2025", null, "CONFIRMED", null, "SETTLED"]];
  const p2 = MUT + "provisional-flipped-settled.xlsx";
  writeAoA(aoa, p2);
  const rep = runValidator(p2);
  const fired = rep.findings.some(f => f.rule === "arithmetic/qualified-overfill-link");
  console.log(`  ${fired ? "PASS" : "FAIL"}  same rows all SETTLED: 3 in a 2-berth link → overfill fires`);
  if (!fired) failures++;
}
// PROVISIONAL derivation: provisional = Y derived, never already_qualified.
{
  const aoa = readAoA();
  aoa.Qualified = [[...QHEAD, "hold_status"],
    ["la28-cricket-w", "New Zealand", "icc-womens-t20i-team-ranking", null, "CONFIRMED", null, "PROVISIONAL"]];
  const p3 = MUT + "provisional-derivation.xlsx";
  writeAoA(aoa, p3);
  const rep = runValidator(p3);
  // if NZ had leaked into already_qualified, the women's NEXT_8 pool would
  // shrink and the tie/threshold structure would shift — but the direct
  // observable here is the shadow rule NOT firing on rows with stored N values
  // plus no qualified-overfill; deeper cut assertions live in the round-trip.
  const bad = rep.findings.some(f => f.rule === "state/qualified-and-provisional");
  console.log(`  ${bad ? "FAIL" : "PASS"}  PROVISIONAL derivation produces no qualified-and-provisional contradiction`);
  if (bad) failures++;
}

// 4th channel: a Qualified row citing a COMPLETE competition clears it.
{
  const aoa = readAoA();
  aoa.Qualified = [QHEAD,
    ["la28-football-w", "Brazil", "copa-america-femenina-2025", null, "CONFIRMED", null],
    ["la28-football-w", "Colombia", "copa-america-femenina-2025", null, "CONFIRMED", null]];
  const path = MUT + "qualified-fourth-channel.xlsx";
  writeAoA(aoa, path);
  const rep = runValidator(path);
  const still = rep.findings.find(f => f.rule === "state/completed-without-outcome" && f.rowId === "copa-america-femenina-2025");
  console.log(`  ${still ? "FAIL" : "PASS"}  copa-america-femenina-2025 clears completed-without-outcome once Qualified cites it (4th channel)`);
  if (still) failures++;
}

// continents-not-declared + pool-preview (new rules)
console.log("\nContinents + pool rules:");
{
  // original workbook has no continents column → the WARN fires there
  const hit = real.findings.some(f => f.rule === "coverage/continents-not-declared");
  console.log(`  ${hit ? "PASS" : "FAIL"}  original workbook (no continents column) → coverage/continents-not-declared fires`);
  if (!hit) failures++;
}
{
  // v8 declares continents on icc-m-continental-4 → silent; pool INFO present
  const v8 = runValidator(root + "data/LA28_Qualification_Database_v8.xlsx");
  const declared = v8.findings.some(f => f.rule === "coverage/continents-not-declared");
  console.log(`  ${declared ? "FAIL" : "PASS"}  v8 workbook: continents declared, rule silent`);
  if (declared) failures++;
  // (pool-preview arithmetic asserted on v13 below — v8 predates the umbrella
  //  remodel, so the structural feeder derivation legitimately finds only the
  //  cut's pre-remodel leads_to there, not the four WC qualifiers.)
}

// TOP_N_OF_POOL: resolves on v13 (standings + second-round fixtures present);
// deleting the second-round fixtures must BLOCK it, not let it guess.
console.log("\nTOP_N_OF_POOL semantics (v13):");
{
  const v13 = runValidator(root + "data/LA28_Qualification_Database_v13.xlsx");
  const blocked = v13.findings.some(f => f.rule === "coverage/cut-line-blocked" && f.rowId === "fiba-m-fopqt-7");
  console.log(`  ${blocked ? "FAIL" : "PASS"}  fiba-m-fopqt-7 resolves on v13 (no longer unlocatable)`);
  if (blocked) failures++;
  // (pool-preview arithmetic asserted on v19 below — field sizes now come
  //  from the declared teams_count, which v13 predates.)
}

// Pool-preview arithmetic (v20: declared teams_count, conditional edges stated).
console.log("\npool-preview arithmetic (v20):");
{
  const vNow = runValidator(root + "data/LA28_Qualification_Database_v21.xlsx");
  const pool = vNow.findings.find(f => f.rule === "coverage/pool-preview" && f.severity === "INFO");
  const okN = pool && /60 distinct second-round teams/.test(pool.message) && /28 of them miss it/.test(pool.message);
  console.log(`  ${okN ? "PASS" : "FAIL"}  WC edge (unconditional): 60 second-round teams, 28 miss the 32-team field`);
  if (!okN) failures++;
  const okF = pool && !/eurobasket/.test(pool.message);
  console.log(`  ${okF ? "PASS" : "FAIL"}  feeders exclude the EuroBasket pre-qualifiers (structural derivation)`);
  if (!okF) failures++;
  const okC = pool && !/6 of them miss it/.test(pool.message) && /conditional edge/.test(pool.message)
    && /route-entrant counts are recorded on those links/.test(pool.message);
  console.log(`  ${okC ? "PASS" : "FAIL"}  FOPQT edges (entry_condition): no miss-count derived, condition stated`);
  if (!okC) failures++;
  const okE = pool && /two-fiba-olympic-pre-qualifying-tournaments-2027-for-europe \(16-team field\)/.test(pool.message);
  console.log(`  ${okE ? "PASS" : "FAIL"}  Europe present with its 16-team field (regex retired for teams_count)`);
  if (!okE) failures++;
  const okT = pool && /standings for fiba-mens-world-ranking are captured, so pool membership is derivable/.test(pool.message);
  console.log(`  ${okT ? "PASS" : "FAIL"}  tail states membership is derivable (standings captured), not pending capture`);
  if (!okT) failures++;
}
{
  // strip every second-round fixture → exclusion basis gone → cut must block
  const XLSX2 = XLSX;
  const wb13 = XLSX2.read(readFileSync(root + "data/LA28_Qualification_Database_v13.xlsx"));
  const aoa = {};
  for (const n of wb13.SheetNames) aoa[n] = XLSX2.utils.sheet_to_json(wb13.Sheets[n], { header: 1, raw: false, defval: null });
  const iStage = col(aoa, "Fixtures", "stage");
  aoa.Fixtures = aoa.Fixtures.filter((r, i) => i === 0 || !/second round/i.test(String(r[iStage] ?? "")));
  const p = MUT + "no-second-round.xlsx";
  writeAoA(aoa, p);
  const rep = runValidator(p);
  const blocked = rep.findings.some(f => f.rule === "coverage/cut-line-blocked" && f.rowId === "fiba-m-fopqt-7");
  console.log(`  ${blocked ? "PASS" : "FAIL"}  with second-round fixtures deleted, fiba-m-fopqt-7 blocks instead of guessing`);
  if (!blocked) failures++;
}

// Declared-unsatisfiable allocation — both directions (v17: the fail-closed
// decision after the global reading returned six Europeans for four seats).
console.log("\nUnsatisfiable-allocation semantics (v17):");
{
  // Direction 1: v17 declares computability=UNSATISFIABLE → blocks with the
  // no-satisfiable-reading form, and the pool-preview shows no top-N.
  const v17 = runValidator(root + "data/LA28_Qualification_Database_v17.xlsx");
  const hit = v17.findings.find(f => f.rule === "coverage/cut-line-blocked" && f.rowId === "fiba-m-fopqt-7");
  const okB = hit && /UNSATISFIABLE/.test(hit.message) && /satisfiable/.test(hit.message);
  console.log(`  ${okB ? "PASS" : "FAIL"}  v17: fiba-m-fopqt-7 blocks under the declared-unsatisfiable form`);
  if (!okB) failures++;
  const preview = v17.findings.find(f => f.rule === "coverage/pool-preview" && f.rowId === "fiba-m-fopqt-7");
  const okP = preview && /UNSATISFIABLE/.test(preview.message) && !/Czechia|top 7:/.test(preview.message);
  console.log(`  ${okP ? "PASS" : "FAIL"}  v17: pool-preview states the block and displays no top-7`);
  if (!okP) failures++;
}
{
  // Direction 2: clearing the marker resolves the cut (the "satisfiable
  // reading declared" path — blank means normal computation resumes).
  const wb17 = XLSX.read(readFileSync(root + "data/LA28_Qualification_Database_v17.xlsx"));
  const aoa = {};
  for (const n of wb17.SheetNames) aoa[n] = XLSX.utils.sheet_to_json(wb17.Sheets[n], { header: 1, raw: false, defval: null });
  const i = findRow(aoa, "Cut_Lines", "cut_line_id", v => v === "fiba-m-fopqt-7");
  aoa.Cut_Lines[i][col(aoa, "Cut_Lines", "computability")] = null;
  const p = MUT + "computability-cleared.xlsx";
  writeAoA(aoa, p);
  const rep = runValidator(p);
  const blocked = rep.findings.some(f => f.rule === "coverage/cut-line-blocked" && f.rowId === "fiba-m-fopqt-7");
  console.log(`  ${blocked ? "FAIL" : "PASS"}  marker cleared → fiba-m-fopqt-7 resolves again`);
  if (blocked) failures++;
}

// notes smells — the original workbook carries both pasted essays.
console.log("\nNotes smells:");
{
  const essay = real.findings.filter(f => f.rule === "hygiene/notes-essay");
  const dup = real.findings.filter(f => f.rule === "hygiene/notes-duplicated");
  const okE = essay.length >= 8;   // 3 women's-essay rows + 5 men's-essay rows
  const okD = dup.length >= 2;     // the two essays each duplicated across rows
  console.log(`  ${okE ? "PASS" : "FAIL"}  original workbook: ${essay.length} notes-essay warnings (expected >= 8)`);
  console.log(`  ${okD ? "PASS" : "FAIL"}  original workbook: ${dup.length} notes-duplicated warnings (expected >= 2)`);
  if (!okE) failures++;
  if (!okD) failures++;
}

// --- tz rules (v20, docs/timezones.md option B): all directions ---
// The canonical baseline has no tz column, so the mutants build one: filled
// for every timed fixture except a chosen gap (rule must fire on exactly
// that), fully filled (rule must fall silent), and filled with one typo'd
// zone (tz-invalid fires per row while tz-undeclared stays silent — the two
// keys are proven distinct).
console.log("\ntz rules (both directions):");
{
  const T = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/;
  const timed = v => { const m = String(v ?? "").trim().match(T); return !!m && !(Number(m[2]) === 0 && m[3] === "00"); };
  const buildTz = (name, adjust) => {
    const aoa = readAoA();
    const H = aoa["Fixtures"][0]; H.push("tz");
    const cD = col(aoa, "Fixtures", "date"), cI = col(aoa, "Fixtures", "fixture_id"), cT = H.length - 1;
    const timedRows = [];
    for (let i = 1; i < aoa["Fixtures"].length; i++) {
      const r = aoa["Fixtures"][i];
      while (r.length < H.length) r.push(null);
      if (timed(r[cD])) { r[cT] = "Africa/Cairo"; timedRows.push(i); }
    }
    if (!timedRows.length) throw new Error("no timed fixtures in baseline — tz directions cannot run");
    const gapInfo = adjust(aoa, timedRows, cT, cI);
    const p = MUT + name + ".xlsx";
    writeAoA(aoa, p);
    return { report: runValidator(p), gapInfo };
  };

  // Direction 1: exactly one timed fixture left bare → fires, count 1, names it.
  const gap = buildTz("tz-one-bare", (aoa, rows, cT, cI) => {
    const r = aoa["Fixtures"][rows[0]]; r[cT] = null; return String(r[cI]);
  });
  const f1 = gap.report.findings.find(f => f.rule === "coverage/tz-undeclared");
  const ok1 = !!f1 && f1.severity === "WARN" && /(^|\D)1 fixtures? carr/.test(f1.message);
  console.log(`  ${ok1 ? "PASS" : "FAIL"}  tz-undeclared fires on a single bare timed fixture (count 1)`);
  if (!ok1) failures++;

  // Direction 2: every timed fixture declared → silent.
  const full = buildTz("tz-all-filled", () => null);
  const ok2 = !full.report.findings.some(f => f.rule === "coverage/tz-undeclared" || f.rule === "coverage/tz-invalid");
  console.log(`  ${ok2 ? "PASS" : "FAIL"}  fully declared workbook clears both tz rules`);
  if (!ok2) failures++;

  // Direction 3: one typo'd zone → tz-invalid fires per row; tz-undeclared silent.
  const typo = buildTz("tz-typo", (aoa, rows, cT, cI) => {
    const r = aoa["Fixtures"][rows[0]]; r[cT] = "Eastern Time"; return String(r[cI]);
  });
  const f3 = typo.report.findings.find(f => f.rule === "coverage/tz-invalid");
  const ok3 = !!f3 && f3.severity === "WARN" && f3.rowId === typo.gapInfo &&
    !typo.report.findings.some(f => f.rule === "coverage/tz-undeclared");
  console.log(`  ${ok3 ? "PASS" : "FAIL"}  a typo'd zone fires tz-invalid on that row while tz-undeclared stays silent`);
  if (!ok3) failures++;
}

// --- tz provenance enum (state/tz-*): tz_source is REQUIRED when tz is
// filled, leading RESEARCHED or DERIVED; DERIVED needs its premise; orphaned
// markers WARN; blank/blank rows are silent. ---
console.log("\ntz provenance enum (state/tz-*):");
{
  const build = (name, tzVal, srcVal) => {
    const aoa = readAoA();
    const H = aoa["Fixtures"][0]; H.push("tz", "tz_source");
    const cI = col(aoa, "Fixtures", "fixture_id"), cT = H.length - 2, cS = H.length - 1;
    for (let i = 1; i < aoa["Fixtures"].length; i++) {
      const r = aoa["Fixtures"][i];
      while (r.length < H.length) r.push(null);
    }
    const r = aoa["Fixtures"][1];
    r[cT] = tzVal; r[cS] = srcVal;
    const p = MUT + name + ".xlsx"; writeAoA(aoa, p);
    return { report: runValidator(p), id: String(r[cI]) };
  };
  const a = build("tzp-unsourced", "America/New_York", null);
  check("tz filled, tz_source blank", a.report, "state/tz-unsourced", "ERROR", a.id);
  const b = build("tzp-bad-enum", "America/New_York", "guessed from broadcast graphics");
  check("tz_source without a leading RESEARCHED/DERIVED", b.report, "state/tz-source-invalid", "ERROR", b.id);
  const c = build("tzp-bare-derived", "America/New_York", "DERIVED");
  check("bare DERIVED with no premise", c.report, "state/tz-source-invalid", "ERROR", c.id);
  const d = build("tzp-researched", "America/New_York", "RESEARCHED");
  const dOK = !d.report.findings.some(f => f.rule.startsWith("state/tz-"));
  console.log(`  ${dOK ? "PASS" : "FAIL"}  bare RESEARCHED is valid (the claim is the content)`);
  if (!dOK) failures++;
  const e = build("tzp-orphan", null, "DERIVED (test): a marker describing no value");
  check("tz_source without tz (dangling marker)", e.report, "state/tz-source-orphaned", "WARN", e.id);
  const v21r = runValidator(root + "data/LA28_Qualification_Database_v21.xlsx");
  const fOK = !v21r.findings.some(f => f.rule.startsWith("state/tz-"));
  console.log(`  ${fOK ? "PASS" : "FAIL"}  v21 clean: twelve DERIVED rows comply, 137 blank/blank rows silent`);
  if (!fOK) failures++;
}

console.log("\nSuppression mechanics:");
const suppFile = MUT + "known-issues.test.json";
writeFileSync(suppFile, JSON.stringify({ issues: [
  { key: "referential/cuts-leads_to/fiba-m-fopqt-7", note: "known — leads_to is a display label; fix is a separate task" },
] }));
const suppressedRun = (() => {
  const report = MUT + "suppression.report.json";
  try {
    execFileSync("node", [root + "src/validate/cli.ts", SRC, "--reference-date", REF,
      "--json", report, "--known-issues", suppFile, "--sentinels", root + "sentinels.json"], { stdio: "pipe" });
  } catch {}
  return JSON.parse(readFileSync(report, "utf8"));
})();
const sOK = suppressedRun.summary.suppressed === 1 &&
  !suppressedRun.findings.some(f => f.key === "referential/cuts-leads_to/fiba-m-fopqt-7") &&
  suppressedRun.suppressed[0]?.key === "referential/cuts-leads_to/fiba-m-fopqt-7";
console.log(`  ${sOK ? "PASS" : "FAIL"}  known-issues.json suppresses by key, reports the count, keeps the note`);
if (!sOK) failures++;

// A suppression without a note must be rejected (exit 2).
writeFileSync(suppFile, JSON.stringify({ issues: [{ key: "x", note: "" }] }));
let noteRejected = false;
try {
  execFileSync("node", [root + "src/validate/cli.ts", SRC, "--reference-date", REF,
    "--known-issues", suppFile, "--sentinels", root + "sentinels.json"], { stdio: "pipe" });
} catch (e) { noteRejected = e.status === 2; }
console.log(`  ${noteRejected ? "PASS" : "FAIL"}  a suppression with an empty note is rejected`);
if (!noteRejected) failures++;

console.log(failures ? `\n${failures} negative test(s) FAILED` : "\nAll negative tests passed — every rule has been seen to fire.");
process.exit(failures ? 1 : 0);
