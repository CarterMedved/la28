/**
 * Coverage and staleness — incomplete or suspicious, never blocking. 19 of 24
 * berth-awarding competitions legitimately have no fixtures yet; a validator
 * that errors on incompleteness gets disabled within a week.
 */
import type { Rule, Finding } from "../types.ts";
import { finding, idOf } from "../types.ts";
import { dayOf } from "../../lib/load.ts";
import { computeThresholds, derivePoolExclusions, poolFeeders, type CutLine, type StandingRow } from "../../lib/thresholds.ts";
import { teamKey } from "../../lib/normalise.ts";

/**
 * Cut-lines whose threshold cannot be located within the captured depth of
 * their ranking (blocked), plus locatable thresholds sitting exactly at the
 * captured depth (zero headroom — the rule breaks on the next standings
 * refresh if the edge team moves down).
 */
/**
 * TOP_PER_NAMED_CONTINENT must declare its continent list on the row
 * (Cut_Lines.continents, comma-separated). Blank falls back to the legacy
 * cricket list — correct for cricket, silently wrong for any federation that
 * groups regions differently (FIBA files Australia and NZ under Asia).
 */
export const namedContinentsDeclared: Rule = ({ ds }) => {
  const out: Finding[] = [];
  for (const c of ds.cuts) {
    if (c.rule !== "TOP_PER_NAMED_CONTINENT") continue;
    if (c.continents == null || String(c.continents).trim() === "")
      out.push(finding("WARN", "coverage/continents-not-declared", ds.sheetNameOf.cuts, idOf.cuts(c),
        `TOP_PER_NAMED_CONTINENT with no continents value — the threshold silently uses the legacy list ` +
        `(Africa, Asia, Europe, Oceania). Declare the continent list on the row; it is part of the rule, and ` +
        `federations group regions differently.`));
  }
  return out;
};

/**
 * Pool preview for TOP_N_OF_POOL cut-lines (INFO). The pool — teams that did
 * NOT reach the World Cup qualifiers' second round — is derived from fixture
 * participation, never stored. This INFO reports the derived exclusion sets so
 * the pool arithmetic surfaces from data (the handoff's 27-vs-28 question):
 * for each competition feeding the cut's ranking that has second-round
 * fixtures, the participant count; and where those competitions advance to a
 * fixed-size field, participants minus field = teams that miss it.
 */
export const poolPreview: Rule = ({ ds }) => {
  const out: Finding[] = [];
  for (const c of ds.cuts) {
    if (c.rule !== "TOP_N_OF_POOL") continue;
    const rid = String(c.ranking_id);
    // Same structural feeder derivation as derivePoolExclusions (shared
    // module) — RANKING_POINTS is "plays for points", not "is the second
    // round", and previewing over the wrong feeders showed the EuroBasket
    // pre-qualifier teams excluded from their own pool.
    const feeders = [...poolFeeders(c as CutLine, ds.links)];
    const parts: Record<string, Set<string>> = {};
    for (const f of ds.fixtures) {
      const comp = String(f.competition_id);
      if (!feeders.includes(comp) || f.team1 == null || f.team2 == null) continue;
      if (!/second round/i.test(String(f.stage ?? ""))) continue;
      (parts[comp] ||= new Set()).add(String(f.team1));
      parts[comp].add(String(f.team2));
    }
    if (!Object.keys(parts).length) continue;
    const counts = Object.entries(parts).map(([k, v]) => `${k}: ${v.size}`).join("; ");
    // Group feeders by the competition they ADVANCE to. Field sizes come
    // from the declared Competitions.teams_count — never parsed out of the
    // format string (the regex this replaces silently dropped Europe, whose
    // format leads "16 European teams"). The "→ N miss it" subtraction is
    // computed ONLY on unconditional edges: an edge carrying an
    // entry_condition (e.g. "only if you missed the World Cup") means the
    // second-round teams are not all candidates for those seats, and the
    // route-entrant count is disputed data recorded on the links — a
    // preview is not the place to settle it.
    const advTarget: Record<string, { srcs: string[]; conditional: boolean }> = {};
    for (const l of ds.links)
      if (l.relationship === "ADVANCE" && feeders.includes(String(l.from_id)) && parts[String(l.from_id)]) {
        const t = (advTarget[String(l.to_id)] ||= { srcs: [], conditional: false });
        t.srcs.push(String(l.from_id));
        if (l.entry_condition != null && String(l.entry_condition).trim() !== "") t.conditional = true;
      }
    let arithmetic = "";
    for (const [tgt, { srcs, conditional }] of Object.entries(advTarget)) {
      const target = ds.comps.find(x => String(x.competition_id) === tgt);
      const fieldN = Number(target?.teams_count) || null;
      if (!fieldN) continue;
      const distinct = new Set(srcs.flatMap(s => [...parts[s]]));
      arithmetic += conditional
        ? ` ${distinct.size} second-round teams feed ${tgt} (${fieldN}-team field) through a conditional edge — entry only on the links' entry_condition — so no miss-count is derived here; route-entrant counts are recorded on those links.`
        : ` ${distinct.size} distinct second-round teams advance toward ${tgt} (${fieldN}-team field) → ${distinct.size - fieldN} of them miss it.`;
    }
    const captured = ds.standings.some(s => String(s.ranking_id) === rid);
    const tail = captured
      ? `The pool for this cut is teams NOT in those second rounds; standings for ${rid} are captured, so pool membership is derivable.`
      : `The pool for this cut is teams NOT in those second rounds; membership resolves once standings for ${rid} are captured.`;
    const blockNote = String(c.computability ?? "").toUpperCase() === "UNSATISFIABLE"
      ? ` ALLOCATION DECLARED UNSATISFIABLE on the row — no top-N is computed or displayed anywhere; the recorded evidence is in the cut's notes.`
      : "";
    out.push(finding("INFO", "coverage/pool-preview", ds.sheetNameOf.cuts, idOf.cuts(c),
      `TOP_N_OF_POOL pool derivation preview — second-round participants per feeding competition: ${counts}.${arithmetic} ` +
      `${tail}${blockNote}`));
  }
  return out;
};

export const cutLineDepth: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const standBy: Record<string, StandingRow[]> = {};
  for (const s of ds.standings)
    if (s.ranking_id != null) (standBy[String(s.ranking_id)] ||= []).push(s as unknown as StandingRow);
  const cutsBy: Record<string, CutLine[]> = {};
  for (const c of ds.cuts)
    if (c.ranking_id != null) (cutsBy[String(c.ranking_id)] ||= []).push(c as unknown as CutLine);
  const poolExclusions = derivePoolExclusions(ds.cuts as unknown as CutLine[], ds.links, ds.fixtures, teamKey);
  const { thresholds, blocked, capturedDepth } = computeThresholds(cutsBy, standBy, poolExclusions, teamKey);

  for (const [rid, bs] of Object.entries(blocked)) {
    for (const b of bs) {
      const depth = capturedDepth[rid] || 0;
      // "basis" and "depth" blocks need different fixes — naming the wrong
      // one sends the user to extend Standings when the gap is in Fixtures.
      const why = b.reason === "unsatisfiable"
        ? `the row declares computability=UNSATISFIABLE — the pool derives, but the allocation has no satisfiable reading (no reading of the rule seats its result); the recorded evidence is in the cut's notes and nothing is computed or displayed until the reading is resolved`
        : b.reason === "basis"
        ? `TOP_N_OF_POOL has no derivation basis — no second-round participation is captured for this ranking's feeders, so the exclusion set is underivable and the cut blocks rather than guesses. The gap is in Fixtures, not standings depth`
        : depth === 0
          ? `its ranking has zero standings rows captured`
          : `the ranking is captured to rank ${depth} and the threshold falls deeper than that, or the rows the rule needs (continent leaders, provisional holder, eligible pool) are missing`;
      const fix = b.reason === "unsatisfiable"
        ? `Resolve the reading (FIBA's LA28 entry document) and clear computability to unblock it.`
        : b.reason === "basis"
        ? `Capture second-round fixtures for the feeding competitions to unblock it.`
        : `Extend the Standings capture for ${rid} to unblock it.`;
      // "blocked", not "unlocatable": the rule covers three reasons (depth,
      // basis, unsatisfiable) and only the first is about locating a rank.
      out.push(finding("WARN", "coverage/cut-line-blocked", ds.sheetNameOf.cuts, String(b.cut.cut_line_id),
        `threshold for "${b.cut.name}" (${b.cut.rule}) cannot be located: ${why}. ${fix}`));
    }
  }
  for (const [rid, ts] of Object.entries(thresholds)) {
    for (const t of ts) {
      if (t.atRank === capturedDepth[rid])
        out.push(finding("WARN", "coverage/cut-line-zero-headroom", ds.sheetNameOf.cuts, String(t.cut.cut_line_id),
          `threshold for "${t.cut.name}" resolves at rank ${t.atRank} — exactly the captured depth of ${rid}. ` +
          `Zero headroom: the next standings refresh that moves the edge team down will make this cut unlocatable. Capture more rows now.`));
    }
  }
  return out;
};

/**
 * Staleness, per ranking. Two regimes:
 *  - `next_refresh_expected` declared on the Ranking_Systems row: the date
 *    past which ABSENCE of a refresh is suspicious — NOT the date the source
 *    will publish. Sources publish event anchors, not dates; the declared
 *    value is anchor + observed-lag margin, with the derivation recorded in
 *    decay_notes. Before it: silent. Past it with standings still older:
 *    stale. Past it with standings refreshed but no new date declared:
 *    refresh-undeclared (own key — granular suppression). And a declaration
 *    more than HORIZON_DAYS past the newest as_of is itself suspect — a
 *    fat-fingered far-future date would silence this check for years with
 *    nothing reporting it: refresh-horizon.
 *  - column blank: the global 30-day clock (continuous rankings like
 *    cricket have no declarable "next refresh").
 * Rankings with no standings are silent everywhere — absent isn't old.
 */
export const staleStandings: Rule = ({ ds, refDate }) => {
  const out: Finding[] = [];
  const byRanking: Record<string, string[]> = {};
  for (const s of ds.standings) {
    if (s.ranking_id == null) continue;
    const d = dayOf(s.as_of);
    if (d) (byRanking[String(s.ranking_id)] ||= []).push(d);
  }
  // Obviously arbitrary and visible on purpose: wider than FIBA's longest
  // observed snapshot gap (132 days), narrow enough that a two-year typo
  // cannot silence the check. One global number — a per-ranking horizon
  // would reintroduce the exact fat-finger surface this bounds.
  const HORIZON_DAYS = 180;
  const ref = new Date(refDate + "T00:00:00Z").getTime();
  const daysBetween = (a: string, b: string) =>
    Math.floor((new Date(a + "T00:00:00Z").getTime() - new Date(b + "T00:00:00Z").getTime()) / 86400000);
  for (const [rid, dates] of Object.entries(byRanking)) {
    const newest = dates.sort().at(-1)!;
    const age = Math.floor((ref - new Date(newest + "T00:00:00Z").getTime()) / 86400000);
    const row = ds.rank.find(r => String(r.ranking_id) === rid);
    const nre = dayOf(row?.next_refresh_expected);
    if (nre) {
      if (daysBetween(nre, newest) > HORIZON_DAYS)
        out.push(finding("WARN", "coverage/refresh-horizon", ds.sheetNameOf.rank, rid,
          `next_refresh_expected ${nre} is ${daysBetween(nre, newest)} days past the newest as_of (${newest}) — beyond the ` +
          `${HORIZON_DAYS}-day horizon. A mis-declared far-future date silences the staleness check with nothing reporting it, ` +
          `so the declaration itself is suspect. Check the source's calendar and decay_notes.`));
      if (refDate > nre) {
        if (newest < nre)
          out.push(finding("WARN", "coverage/stale-standings", ds.sheetNameOf.standings, rid,
            `standings as_of ${newest}; the declared refresh threshold (next_refresh_expected ${nre}) is ` +
            `${daysBetween(refDate, nre)} day(s) past. Either the source has not published or the capture is missing — ` +
            `check the source before publishing verdicts on this table.`));
        else
          out.push(finding("WARN", "coverage/refresh-undeclared", ds.sheetNameOf.rank, rid,
            `standings refreshed (as_of ${newest}) past next_refresh_expected (${nre}), but no new expected date is ` +
            `declared. Declare the next one from the source's calendar — an undeclared future silently disables this check.`));
      }
      continue;
    }
    if (age > 30)
      out.push(finding("WARN", "coverage/stale-standings", ds.sheetNameOf.standings, rid,
        `standings as_of ${newest} — ${age} days old at ${refDate}. Refresh from the source before publishing verdicts on them.`));
  }
  return out;
};

/**
 * Past fixtures with no result. Aggregate ratio above 5 missing; at 5 or
 * fewer the fixtures are named — "3 of 19" is true and useless when what's
 * needed is which three.
 */
export const pastFixturesNoResult: Rule = ({ ds, refDate }) => {
  const past = ds.fixtures.filter(f => { const d = dayOf(f.date); return d && d < refDate; });
  const noResult = past.filter(f => f.result == null);
  if (!noResult.length) return [];
  const header = `${noResult.length} of ${past.length} past fixtures have no result recorded ` +
    `(${Math.round(100 * noResult.length / past.length)}%).`;
  if (noResult.length > 5)
    return [finding("WARN", "coverage/past-fixtures-no-result", ds.sheetNameOf.fixtures, "(aggregate)",
      `${header} Backfill results or the app shows played games as pending.`)];
  const lines = noResult.map(f =>
    `${f.fixture_id} · ${f.competition_id} · ${dayOf(f.date)} · ${f.team1 ?? "TBD"} v ${f.team2 ?? "TBD"}`);
  return [finding("WARN", "coverage/past-fixtures-no-result", ds.sheetNameOf.fixtures, "(aggregate)",
    `${header} Missing:\n      ${lines.join("\n      ")}`)];
};

/**
 * Fixtures with no date at all. Legitimate for unscheduled knockouts and
 * unconfirmed legs — but every date-keyed rule skips them and the app can
 * only show them as "date unconfirmed", so they must be visible as a list,
 * never silently absent from date views. WARN: incomplete, not wrong.
 */
export const undatedFixtures: Rule = ({ ds }) => {
  const undated = ds.fixtures.filter(f => f.date == null);
  if (!undated.length) return [];
  const lines = undated.map(f =>
    `${f.fixture_id} · ${f.competition_id} · ${f.stage ?? "stage?"} · ${f.team1 ?? "TBD"} v ${f.team2 ?? "TBD"}`);
  return [finding("WARN", "coverage/undated-fixtures", ds.sheetNameOf.fixtures, "(aggregate)",
    `${undated.length} of ${ds.fixtures.length} fixtures have no date. Date-keyed rules skip them and the app lists them under "date unconfirmed". Fill dates as the organiser publishes them:\n      ${lines.join("\n      ")}`)];
};

/**
 * Fixtures carrying a genuine kickoff time but no declared zone
 * (Fixtures.tz, IANA name — docs/timezones.md option B, adopted 3 Aug
 * 2026). Stored times are LOCAL match times; tz declares which zone they
 * are local to, and is populated lazily, only from sources. A displayed
 * time with no zone invites "correction" from a source rendering the same
 * kickoff in another zone — the 5-vs-6 Aug failure re-entering through
 * the UI. WARN, aggregate: blank is incomplete, not false. A declared
 * zone Intl rejects is flagged per row — a typo'd zone claims precision
 * the data does not have.
 */
export const tzUndeclared: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const T = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/;
  const timed = (f: { date: unknown }) => {
    const m = String(f.date ?? "").trim().match(T);
    return !!m && !(Number(m[2]) === 0 && m[3] === "00");
  };
  const bare = ds.fixtures.filter(f => timed(f) && f.tz == null);
  if (bare.length) {
    const byComp: Record<string, number> = {};
    for (const f of bare) byComp[String(f.competition_id)] = (byComp[String(f.competition_id)] || 0) + 1;
    const lines = Object.entries(byComp).map(([c, n]) => `${c} (${n})`);
    out.push(finding("WARN", "coverage/tz-undeclared", ds.sheetNameOf.fixtures, "(aggregate)",
      `${bare.length} fixtures carry a kickoff time but no declared zone (Fixtures.tz). Stored times are as ` +
      `displayed by each row's ENTRY SOURCE, not venue-local match times (measured 3 Aug 2026: every timed row ` +
      `is consistent with America/New_York and several are impossible as venue-local or UTC — docs/timezones.md). ` +
      `The pattern is not per-row proof: blank tz means the zone is UNVERIFIED for that row, the app labels it ` +
      `"zone?", and a bare time invites re-entry from a source in another zone. Populate tz (IANA name) only ` +
      `from sources where the time is load-bearing — declare, never convert:\n      ${lines.join("\n      ")}`));
  }
  for (const f of ds.fixtures) {
    if (f.tz == null) continue;
    try { new Intl.DateTimeFormat("en-US", { timeZone: String(f.tz) }); }
    catch {
      out.push(finding("WARN", "coverage/tz-invalid", ds.sheetNameOf.fixtures, String(f.fixture_id),
        `declared zone "${f.tz}" is not a recognised IANA zone — a typo'd zone claims a precision the data ` +
        `does not have, which is worse than blank. Fix it or blank it.`));
    }
  }
  return out;
};

export const unlinkedCompetitions: Rule = ({ ds }) => {
  const linked = new Set(ds.links.flatMap(l => [l.from_id, l.to_id]).filter(v => v != null));
  return ds.comps
    .filter(c => !linked.has(c.competition_id))
    .map(c => finding("WARN", "coverage/unlinked-competition", ds.sheetNameOf.comps, idOf.comps(c),
      `referenced by no Link — nothing downstream reaches it and no pathway includes it. Link it or note it as out of scope.`));
};

/**
 * Regional competition with blank confederation. "Regional" is derived from
 * the graph, not from name keywords: a competition with at least one outbound
 * link whose relationship is NOT RANKING_POINTS participates in traversal, and
 * traversal region-gates on confederation — blank produces impossible pathways
 * (handoff PART 8 #7). GLOBAL counts as populated.
 */
export const blankConfederation: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const outbound: Record<string, string[]> = {};
  for (const l of ds.links)
    if (l.from_id != null) (outbound[String(l.from_id)] ||= []).push(String(l.relationship ?? ""));
  for (const c of ds.comps) {
    if (c.confederation != null) continue;
    const rels = outbound[String(c.competition_id)] || [];
    if (rels.some(r => r !== "RANKING_POINTS"))
      out.push(finding("WARN", "coverage/blank-confederation", ds.sheetNameOf.comps, idOf.comps(c),
        `sits on the qualification graph (outbound: ${[...new Set(rels)].join(", ")}) but has no confederation. ` +
        `Traversal cannot region-gate routes through it, which produces impossible pathways. Set confederation (GLOBAL if truly worldwide).`));
  }
  return out;
};

/**
 * Fixture-versus-start_date coherence. Convention: start_date is the
 * competition's TRUE start; captured fixtures may begin later (the captured
 * segment's start is derivable as the earliest fixture date and is never
 * stored). Two smells, both WARN:
 *  - a fixture earlier than start_date (the stored start is wrong), and
 *  - fixture stages implying earlier rounds that are absent ("Second round"
 *    with no first-round fixtures, or Window/Matchday numbering starting
 *    above 1) while start_date equals the first CAPTURED fixture — the error
 *    that had five World Cup qualifiers "starting" at Window 4.
 */
export const fixturesBeforeStart: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const earliest: Record<string, string> = {};
  for (const f of ds.fixtures) {
    const d = dayOf(f.date);
    if (!d || f.competition_id == null) continue;
    const k = String(f.competition_id);
    if (!earliest[k] || d < earliest[k]) earliest[k] = d;
  }
  for (const c of ds.comps) {
    const start = dayOf(c.start_date);
    const first = earliest[String(c.competition_id)];
    if (start && first && first < start)
      out.push(finding("WARN", "coverage/fixtures-before-start", ds.sheetNameOf.comps, idOf.comps(c),
        `earliest fixture is ${first} but start_date is ${start}. start_date must be the competition's true start; fix it or the fixture date.`));
  }
  return out;
};

/**
 * Stages reference a second round but no first-round fixtures are captured.
 * Says nothing about fixture COUNTS — completeness is roundRobinIncomplete's
 * job (carry-over formats make count inference from round names wrong).
 */
export const missingEarlierRounds: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const stagesByComp: Record<string, Set<string>> = {};
  for (const f of ds.fixtures)
    if (f.competition_id != null && f.stage != null)
      (stagesByComp[String(f.competition_id)] ||= new Set()).add(String(f.stage));
  for (const [compId, set] of Object.entries(stagesByComp)) {
    const stages = [...set];
    if (stages.some(s => /second round/i.test(s)) && !stages.some(s => /first round/i.test(s)))
      out.push(finding("WARN", "coverage/missing-earlier-rounds", ds.sheetNameOf.comps, compId,
        `stages reference a second round but no first-round fixtures are captured. ` +
        `If start_date equals the first captured fixture it is the start of the captured segment, not of the competition — ` +
        `check start_date, and note the uncaptured round. (This flags the missing round only; it implies nothing about how many fixtures the captured round should have.)`));
  }
  return out;
};

/**
 * Round-robin completeness, from structure rather than naive pair counting.
 * Where format parses as "N teams · [double] round-robin", check:
 *   - declared N vs teams observed in group-stage fixtures,
 *   - no pair appears MORE often than the format allows (the duplicate bug),
 *   - in a double round-robin, no pair appears only once (a missing return leg),
 *   - single round-robin: everyone in a group plays everyone (opponents = size-1),
 *   - double round-robin: the group is REGULAR — every team has the same game
 *     and opponent count. Full within-group round-robin is deliberately NOT
 *     required: FIBA's carry-over format (second-round groups of 6 where each
 *     team meets only the 3 from the other first-round half) is regular and
 *     complete at half the naive pair count. Capture gaps are ragged; real
 *     formats are regular.
 */
export const roundRobinIncomplete: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const KO = /quarter|semi|final|knockout|play-?off|not yet drawn/i;
  for (const c of ds.comps) {
    const fmt = String(c.format ?? "");
    if (!/round-robin/i.test(fmt)) continue;
    const compId = idOf.comps(c);
    const declared = Number(fmt.match(/^(\d+)\s+teams/)?.[1]) || null;
    const expApp = /double round-robin|home and away/i.test(fmt) ? 2 : 1;

    const fx = ds.fixtures.filter(f => String(f.competition_id) === compId &&
      f.team1 != null && f.team2 != null && !KO.test(String(f.stage ?? "")));
    if (!fx.length) continue;   // no fixtures yet is the no-fixtures case, not incompleteness

    const pairs: Record<string, number> = {};
    const teams = new Set<string>();
    for (const f of fx) {
      teams.add(String(f.team1)); teams.add(String(f.team2));
      const k = [String(f.team1), String(f.team2)].sort().join(" ~ ");
      pairs[k] = (pairs[k] || 0) + 1;
    }

    const problems: string[] = [];
    if (declared && teams.size !== declared)
      problems.push(`format declares ${declared} teams but ${teams.size} appear in group-stage fixtures`);

    const over = Object.entries(pairs).filter(([, n]) => n > expApp);
    if (over.length)
      problems.push(`${over.length} pair(s) appear more often than the format allows (max ${expApp}): ${over.slice(0, 4).map(([k, n]) => `${k} ×${n}`).join("; ")}${over.length > 4 ? "; …" : ""}`);
    const under = expApp === 2 ? Object.entries(pairs).filter(([, n]) => n < expApp) : [];
    if (under.length)
      problems.push(`${under.length} pair(s) appear only once in a home-and-away format (missing return leg): ${under.slice(0, 4).map(([k]) => k).join("; ")}${under.length > 4 ? "; …" : ""}`);

    // group structure = connected components of the pair graph
    const parent: Record<string, string> = {};
    const find = (x: string): string => parent[x] === x ? x : (parent[x] = find(parent[x]));
    teams.forEach(t => parent[t] = t);
    Object.keys(pairs).forEach(k => { const [a, b] = k.split(" ~ "); parent[find(a)] = find(b); });
    const groups: Record<string, string[]> = {};
    teams.forEach(t => (groups[find(t)] ||= []).push(t));
    const opponents: Record<string, Set<string>> = {};
    const games: Record<string, number> = {};
    Object.entries(pairs).forEach(([k, n]) => {
      const [a, b] = k.split(" ~ ");
      (opponents[a] ||= new Set()).add(b); (opponents[b] ||= new Set()).add(a);
      games[a] = (games[a] || 0) + n; games[b] = (games[b] || 0) + n;
    });
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      if (expApp === 1) {
        const short = g.filter(t => (opponents[t]?.size ?? 0) < g.length - 1);
        if (short.length)
          problems.push(`single round-robin group of ${g.length} where ${short.length} team(s) do not meet every groupmate ` +
            `(e.g. ${short[0]}: ${opponents[short[0]]?.size ?? 0} of ${g.length - 1} opponents) — fixtures are missing`);
      } else {
        const oppCounts = new Set(g.map(t => opponents[t]?.size ?? 0));
        const gameCounts = new Set(g.map(t => games[t] || 0));
        if (oppCounts.size > 1 || gameCounts.size > 1)
          problems.push(`group of ${g.length} is irregular: opponent counts {${[...oppCounts].join(",")}}, game counts {${[...gameCounts].join(",")}} — ` +
            `a real format schedules every team equally, so some fixtures are missing`);
      }
    }

    if (problems.length)
      out.push(finding("WARN", "coverage/round-robin-incomplete", ds.sheetNameOf.comps, compId,
        `${problems.join(". ")}.`));
  }
  return out;
};

/**
 * A fixture whose stage says the draw has not happened is a placeholder — an
 * undrawn competition should have zero fixtures (status carries "not drawn",
 * Fixtures does not). Left in place, each becomes a permanent past-fixture-
 * without-result once its placeholder date passes.
 */
export const placeholderFixtures: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const byComp: Record<string, string[]> = {};
  for (const f of ds.fixtures)
    if (f.stage != null && /not yet drawn/i.test(String(f.stage)))
      (byComp[String(f.competition_id)] ||= []).push(idOf.fixtures(f));
  for (const [compId, fids] of Object.entries(byComp))
    out.push(finding("WARN", "coverage/placeholder-fixtures", ds.sheetNameOf.fixtures, compId,
      `${fids.length} placeholder fixture(s) with stage "Not yet drawn" (${fids.join(", ")}). Delete ${fids.length === 1 ? "it" : "them"} — ` +
      `an undrawn competition should have zero fixtures, and after the placeholder date passes ${fids.length === 1 ? "it" : "each"} counts forever as a past fixture with no result.`));
  return out;
};

/** Same competition, same date, same team pair in either order. */
export const duplicateFixtures: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const seen: Record<string, string> = {};
  for (const f of ds.fixtures) {
    const day = dayOf(f.date);
    if (!day || f.team1 == null || f.team2 == null) continue;
    const pair = [String(f.team1), String(f.team2)].sort().join(" ~ ");
    const k = `${f.competition_id}|${day}|${pair}`;
    if (seen[k])
      out.push(finding("WARN", "coverage/duplicate-fixture", ds.sheetNameOf.fixtures, idOf.fixtures(f),
        `duplicates ${seen[k]}: same competition (${f.competition_id}), same date (${day}), same teams (${pair}). Delete one.`));
    else seen[k] = idOf.fixtures(f);
  }
  return out;
};
