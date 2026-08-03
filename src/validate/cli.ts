/**
 * LA28 workbook validator — the gate between the sheet and anything published.
 *
 *   node src/validate/cli.ts <workbook.xlsx> [--reference-date YYYY-MM-DD]
 *                            [--json <report path>] [--known-issues <path>]
 *                            [--sentinels <path>]
 *
 * Exit code: 1 if any unsuppressed ERROR, else 0. WARN and INFO never block.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { relative, resolve, basename } from "node:path";
import { loadWorkbook } from "../lib/load.ts";
import type { Finding, RuleContext, Severity } from "./types.ts";
import { referential } from "./rules/referential.ts";
import { arithmetic, qualifiedFill } from "./rules/arithmetic.ts";
import { statusWindow, standingsStates, duplicateRanks, appliesToBinds, confirmedPlaceholderDates, completedWithoutOutcome, storedQualificationShadowed, tzProvenance } from "./rules/state.ts";
import { cutLineDepth, staleStandings, pastFixturesNoResult, undatedFixtures, tzUndeclared, unlinkedCompetitions, blankConfederation, duplicateFixtures, fixturesBeforeStart, missingEarlierRounds, placeholderFixtures, roundRobinIncomplete, namedContinentsDeclared, poolPreview } from "./rules/coverage.ts";
import { hygiene, notesSmell } from "./rules/hygiene.ts";
import { dayOf } from "../lib/load.ts";

// --- args ---
const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const workbookPath = args.find(a => !a.startsWith("--") && a !== flag("--reference-date") && a !== flag("--json") && a !== flag("--known-issues") && a !== flag("--sentinels"));
if (!workbookPath) {
  console.error("usage: node src/validate/cli.ts <workbook.xlsx> [--reference-date YYYY-MM-DD] [--json out.json] [--known-issues known-issues.json] [--sentinels sentinels.json]");
  process.exit(2);
}
const refDate = flag("--reference-date") ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(refDate)) { console.error(`--reference-date must be YYYY-MM-DD, got "${refDate}"`); process.exit(2); }
const jsonPath = flag("--json");
const knownIssuesPath = flag("--known-issues") ?? "known-issues.json";
const sentinelsPath = flag("--sentinels") ?? "sentinels.json";

// --- config ---
interface KnownIssue { key: string; note: string }
const loadJson = <T>(path: string, fallback: T): T => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : fallback;
const sentinelsCfg = loadJson<{ sentinels: { id: string; note: string }[] }>(sentinelsPath, { sentinels: [] });
const knownIssues = loadJson<{ issues: KnownIssue[] }>(knownIssuesPath, { issues: [] });
const badKnown = knownIssues.issues.filter(i => !i.note || !String(i.note).trim());
if (badKnown.length) {
  console.error(`known-issues.json: every suppression needs a non-empty "note" saying why. Missing on: ${badKnown.map(i => i.key).join(", ")}`);
  process.exit(2);
}

// --- run rules ---
const ds = loadWorkbook(workbookPath);
const ctx: RuleContext = { ds, refDate, sentinels: new Set(sentinelsCfg.sentinels.map(s => s.id)) };
const rules = [referential, arithmetic, qualifiedFill, statusWindow, standingsStates, duplicateRanks, appliesToBinds, confirmedPlaceholderDates, completedWithoutOutcome, storedQualificationShadowed, tzProvenance,
               cutLineDepth, staleStandings, pastFixturesNoResult, undatedFixtures, tzUndeclared, unlinkedCompetitions, blankConfederation, duplicateFixtures,
               fixturesBeforeStart, missingEarlierRounds, placeholderFixtures, roundRobinIncomplete, namedContinentsDeclared, poolPreview, hygiene, notesSmell];
const all: Finding[] = rules.flatMap(r => r(ctx));

const suppressedKeys = new Map(knownIssues.issues.map(i => [i.key, i.note]));
const suppressed = all.filter(f => suppressedKeys.has(f.key));
const active = all.filter(f => !suppressedKeys.has(f.key));
const unusedSuppressions = knownIssues.issues.filter(i => !all.some(f => f.key === i.key));

// --- INFO coverage stats ---
const rankingsWithStandings = new Set(ds.standings.map(s => s.ranking_id).filter(v => v != null));
const stats = {
  reference_date: refDate,
  events: ds.events.length,
  links: ds.links.length,
  competitions: ds.comps.length,
  fixtures: ds.fixtures.length,
  results_recorded: ds.fixtures.filter(f => f.result != null).length,
  past_fixtures: ds.fixtures.filter(f => { const d = dayOf(f.date); return d && d < refDate; }).length,
  rankings_with_standings: rankingsWithStandings.size,
  rankings_without_standings: ds.rank.filter(r => !rankingsWithStandings.has(r.ranking_id)).length,
  cut_lines: ds.cuts.length,
  standings_rows: ds.standings.length,
  qualified_rows: ds.qualified.length,
};

// --- console output: severity, then rule ---
const ORDER: Severity[] = ["ERROR", "WARN", "INFO"];
const count = (sev: Severity) => active.filter(f => f.severity === sev).length;

for (const sev of ORDER) {
  const group = active.filter(f => f.severity === sev);
  if (!group.length) continue;
  console.log(`\n${"=".repeat(70)}\n${sev} — ${group.length}\n${"=".repeat(70)}`);
  const byRule: Record<string, Finding[]> = {};
  for (const f of group) (byRule[f.rule] ||= []).push(f);
  for (const [rule, fs] of Object.entries(byRule)) {
    console.log(`\n  [${rule}]`);
    for (const f of fs) console.log(`    ${f.tab} · ${f.rowId}\n      ${f.message}`);
  }
}

console.log(`\n${"-".repeat(70)}\nSUMMARY  (reference date ${refDate})`);
console.log(`  ERROR ${count("ERROR")} · WARN ${count("WARN")} · INFO ${count("INFO")}`);
if (suppressed.length) {
  console.log(`  ${suppressed.length} finding(s) suppressed by ${knownIssuesPath}:`);
  for (const f of suppressed) console.log(`    - ${f.key} (${suppressedKeys.get(f.key)})`);
}
for (const u of unusedSuppressions)
  console.log(`  NOTE: suppression "${u.key}" matched nothing — the issue may be fixed; remove it.`);
console.log(`  coverage: ${stats.events} events · ${stats.links} links · ${stats.competitions} competitions · ` +
  `${stats.fixtures} fixtures (${stats.results_recorded} results recorded, ${stats.past_fixtures} past) · ` +
  `${stats.rankings_with_standings} rankings with standings, ${stats.rankings_without_standings} without · ` +
  `${stats.cut_lines} cut-lines · ${stats.standings_rows} standings rows · ${stats.qualified_rows} settled berths in Qualified`);

// --- machine-readable report ---
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify({
    // Repo-root-relative, NOT cwd-relative or argv-verbatim: the same
    // workbook must yield the same string from any working directory, and
    // an absolute argv path must never leak a machine-specific prefix into
    // a report (failed-run archives embed reports verbatim and publish).
    workbook: (() => {
      const repoRoot = new URL("../..", import.meta.url).pathname;
      const rel = relative(repoRoot, resolve(workbookPath));
      return rel.startsWith("..") ? basename(workbookPath) : rel;
    })(), reference_date: refDate, generated_by: "la28-validator",
    summary: { error: count("ERROR"), warn: count("WARN"), info: count("INFO"), suppressed: suppressed.length },
    stats,
    findings: active,
    suppressed: suppressed.map(f => ({ ...f, note: suppressedKeys.get(f.key) })),
    unused_suppressions: unusedSuppressions,
  }, null, 2));
  console.log(`  report written to ${jsonPath}`);
}

const fit = count("ERROR") === 0;
console.log(`\n${fit ? "FIT TO PUBLISH" : "NOT FIT TO PUBLISH"} — ${fit ? "no errors" : `${count("ERROR")} error(s) must be fixed`}.`);
process.exit(fit ? 0 : 1);
