/**
 * State consistency — a status that contradicts the calendar, or a standings
 * row in two mutually exclusive states, would publish something false.
 *
 * Status/window family (all against the injected reference date; rows with
 * blank or unparseable dates are skipped — that is the UNANNOUNCED case and
 * is legitimate):
 *   COMPLETE     with end_date   >  ref → ERROR
 *   SCHEDULED    with end_date   <  ref → ERROR
 *   IN_PROGRESS  with start_date >  ref or end_date < ref → ERROR
 */
import type { Rule, Finding } from "../types.ts";
import { finding, idOf } from "../types.ts";
import { dayOf, RAW } from "../../lib/load.ts";
import { teamKey } from "../../lib/normalise.ts";
import { computeThresholds, derivePoolExclusions, type CutLine, type StandingRow } from "../../lib/thresholds.ts";
import { feedsMap } from "../../lib/qualified.ts";

export const statusWindow: Rule = ({ ds, refDate }) => {
  const out: Finding[] = [];
  for (const c of ds.comps) {
    const id = idOf.comps(c);
    const status = c.status == null ? null : String(c.status);
    const start = dayOf(c.start_date);
    const end = dayOf(c.end_date);
    const tab = ds.sheetNameOf.comps;
    if (status === "COMPLETE" && end && end > refDate)
      out.push(finding("ERROR", "state/complete-but-future", tab, id,
        `status COMPLETE but end_date ${end} is after ${refDate}. It cannot have concluded; set status to SCHEDULED or fix the dates.`));
    if (status === "SCHEDULED" && end && end < refDate)
      out.push(finding("ERROR", "state/scheduled-but-past", tab, id,
        `status SCHEDULED but end_date ${end} is before ${refDate}. It has finished; set status to COMPLETE and record results.`));
    if (status === "IN_PROGRESS" && start && start > refDate)
      out.push(finding("ERROR", "state/in-progress-not-started", tab, id,
        `status IN_PROGRESS but start_date ${start} is after ${refDate}. It has not begun; set status to SCHEDULED.`));
    if (status === "IN_PROGRESS" && end && end < refDate)
      out.push(finding("ERROR", "state/in-progress-but-ended", tab, id,
        `status IN_PROGRESS but end_date ${end} is before ${refDate}. It has finished; set status to COMPLETE.`));
    // A competition cannot be finished and undated — COMPLETE asserts an event
    // happened, which requires knowing when.
    if (status === "COMPLETE" && (!start || !end))
      out.push(finding("ERROR", "state/complete-missing-dates", tab, id,
        `status COMPLETE but ${!start && !end ? "start_date and end_date are" : !start ? "start_date is" : "end_date is"} blank or unparseable. ` +
        `A concluded competition has known dates; fill them in.`));
  }
  return out;
};

/**
 * CONFIRMED date_confidence on dates that carry placeholder signatures.
 * date_confidence is about the DATES, not the field — a championship with
 * fixed dates and an undrawn field is normal and must not fire. Signatures:
 *   - start_date equals end_date (a real multi-day window collapsed to a stamp)
 *   - a MONTH-SPAN window (first-of-month start AND last-day-of-month end)
 *     with no real fixture inside — "real" excludes "Not yet drawn" rows.
 * First-of-month starts alone are NOT a signature: real windows can start on
 * the 1st (caf-w-oqt-2028-r1's FIFA window is 1–9 June 2026). What marks a
 * placeholder is a window drawn along calendar-month boundaries at both ends.
 */
export const confirmedPlaceholderDates: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const realFxDays: Record<string, string[]> = {};
  const anyFx = new Set<string>();
  for (const f of ds.fixtures) {
    if (f.competition_id == null) continue;
    anyFx.add(String(f.competition_id));
    if (f.stage != null && /not yet drawn/i.test(String(f.stage))) continue;
    const d = dayOf(f.date);
    if (d) (realFxDays[String(f.competition_id)] ||= []).push(d);
  }
  for (const c of ds.comps) {
    if (c.date_confidence !== "CONFIRMED") continue;
    const s = dayOf(c.start_date), e = dayOf(c.end_date);
    if (!s) continue;
    const sigs: string[] = [];
    if (e && s === e) sigs.push(`start_date equals end_date (${s})`);
    const realInWindow = (realFxDays[String(c.competition_id)] || []).filter(d => d >= s && (!e || d <= e));
    const isLastOfMonth = (d: string) => {
      const [y, m, day] = d.split("-").map(Number);
      return new Date(Date.UTC(y, m, 0)).getUTCDate() === day;
    };
    if (/-01$/.test(s) && e && isLastOfMonth(e) && realInWindow.length === 0)
      sigs.push(`the window ${s} → ${e} runs along calendar-month boundaries at both ends and no real fixture falls inside it` +
        (anyFx.has(String(c.competition_id)) ? " (its only fixtures are placeholders or fall outside it)" : ""));
    if (sigs.length)
      out.push(finding("ERROR", "state/confirmed-placeholder-dates", ds.sheetNameOf.comps, idOf.comps(c),
        `date_confidence is CONFIRMED but the dates look like placeholders: ${sigs.join("; ")}. ` +
        `Set date_confidence to TBD or APPROXIMATE, or replace the dates with the real schedule.`));
  }
  return out;
};

/**
 * status COMPLETE but the competition's outcome is recorded nowhere the graph
 * can read — a played round whose result the pathway never learned. Four
 * capture channels, any one suffices:
 *   1. a fixture of this competition with a result;
 *   2. a Standings row citing it in qualified_via (free text on unmanaged
 *      rankings, so the match is by canonicalised name-substring);
 *   3. its outcome materialised downstream: an outbound ADVANCE-style link
 *      whose target holds real fixtures naming teams;
 *   4. a Qualified row with qualified_via = this competition_id — the settled-
 *      berth register knows who came through it.
 */
export const completedWithoutOutcome: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const canon = (s: unknown) => String(s ?? "").toLowerCase()
    .replace(/[’‘]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

  const resultsByComp = new Set<string>();
  const realFxByComp = new Set<string>();
  for (const f of ds.fixtures) {
    if (f.competition_id == null) continue;
    const k = String(f.competition_id);
    if (f.result != null) resultsByComp.add(k);
    if (f.team1 != null && f.team2 != null && !/not yet drawn/i.test(String(f.stage ?? ""))) realFxByComp.add(k);
  }
  const vias = ds.standings.map(s => canon(s.qualified_via)).filter(Boolean);
  const qualifiedVia = new Set(ds.qualified.map(q => q.qualified_via == null ? null : String(q.qualified_via)).filter(Boolean));
  const outbound: Record<string, string[]> = {};
  for (const l of ds.links)
    if (l.from_id != null && l.to_id != null) (outbound[String(l.from_id)] ||= []).push(String(l.to_id));

  for (const c of ds.comps) {
    if (c.status !== "COMPLETE") continue;
    const id = String(c.competition_id);
    if (resultsByComp.has(id)) continue;
    if (qualifiedVia.has(id)) continue;
    // strip org prefixes and leading years so "ICC Women's T20 World Cup 2026"
    // meets "Direct place, Women's T20 World Cup 2026"
    const bare = canon(c.name).replace(/^(the |icc |fiba |fifa |fie |\d{4} )+/g, "");
    if (bare && vias.some(v => v.includes(bare))) continue;
    if ((outbound[id] || []).some(t => realFxByComp.has(t))) continue;
    out.push(finding("ERROR", "state/completed-without-outcome", ds.sheetNameOf.comps, id,
      `status COMPLETE but the outcome is recorded nowhere: no fixture has a result, no Qualified row cites it, no ` +
      `Standings row names it in qualified_via, and no downstream competition it feeds has a materialised field. The graph ` +
      `never learned who won — every pathway through this node is blocked. Add Qualified rows, record results, or fixture the downstream field.`));
  }
  return out;
};

/**
 * Single-source enforcement for settled berths. Once an event is managed by
 * Qualified, stored already_qualified / qualified_via values in Standings are
 * dead cells: the loader overwrites them with derived values, so an editor
 * updating the stored cell would see no effect — or worse, believe a state
 * that the app no longer reads. ERROR each stored cell on a managed event
 * (promoted from WARN after the migration completed — a stored shadow is now
 * a bug, not a transition state). Reads RAW because the derivation has already
 * replaced the visible values. Covers provisional too — it derives from
 * hold_status = PROVISIONAL. Explicit "N" cells are exempt: "N" means the
 * same as the derived null, and flagging it would demand 75 no-op clears.
 */
export const storedQualificationShadowed: Rule = ({ ds }) => {
  const out: Finding[] = [];
  if (!ds.qualified.length) return out;
  const eventIds = new Set(ds.events.map(e => String(e.olympic_event_id)));
  const feeds = feedsMap(ds.rank, eventIds);
  const managed = new Set(ds.qualified.map(q => String(q.olympic_event_id)));
  for (const s of ds.standings) {
    const ev = s.ranking_id == null ? undefined : feeds[String(s.ranking_id)];
    if (!ev || !managed.has(ev)) continue;
    const stored: string[] = [];
    for (const col of ["already_qualified", "qualified_via", "provisional"] as const) {
      const raw = s[RAW]?.[col];
      if (raw == null || String(raw).trim() === "") continue;
      if ((col === "already_qualified" || col === "provisional") && String(raw).trim() === "N") continue;
      stored.push(`${col}="${String(raw).trim()}"`);
    }
    if (stored.length)
      out.push(finding("ERROR", "state/stored-qualification-shadowed", ds.sheetNameOf.standings, idOf.standings(s),
        `${stored.join(" and ")} stored in Standings, but ${ev} is managed by the Qualified tab and the loader derives these ` +
        `columns from it — the stored value is never read and can silently disagree. Clear the cell(s); Qualified is the single source.`));
  }
  return out;
};

export const standingsStates: Rule = ({ ds }) => {
  const out: Finding[] = [];
  for (const s of ds.standings) {
    if (s.already_qualified === "Y" && s.provisional === "Y")
      out.push(finding("ERROR", "state/qualified-and-provisional", ds.sheetNameOf.standings, idOf.standings(s),
        `already_qualified and provisional are both Y. They are mutually exclusive: settled places are excluded from ` +
        `cut-line maths, provisional places are what the cut-line decides. Pick one.`));
  }
  return out;
};

/**
 * Duplicate rank within a ranking. Different ratings at one rank is a data
 * error. Identical ratings is a genuine tie: INFO normally, WARN prominently
 * when the tie sits at or adjacent to a computed threshold — NEXT_N_NOT_QUALIFIED
 * selects a single row, so an unbroken tie at that index makes the app pick
 * arbitrarily and no tiebreak rule is in the sources.
 */
export const duplicateRanks: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const tab = ds.sheetNameOf.standings;

  const standBy: Record<string, StandingRow[]> = {};
  for (const s of ds.standings)
    if (s.ranking_id != null) (standBy[String(s.ranking_id)] ||= []).push(s as unknown as StandingRow);
  const cutsBy: Record<string, CutLine[]> = {};
  for (const c of ds.cuts)
    if (c.ranking_id != null) (cutsBy[String(c.ranking_id)] ||= []).push(c as unknown as CutLine);
  const poolExclusions = derivePoolExclusions(ds.cuts as unknown as CutLine[], ds.links, ds.fixtures, teamKey);
  const { thresholds } = computeThresholds(cutsBy, standBy, poolExclusions, teamKey);

  for (const [rid, rows] of Object.entries(standBy)) {
    const byRank: Record<string, StandingRow[]> = {};
    for (const r of rows) if (r.rank != null) (byRank[String(r.rank)] ||= []).push(r);
    for (const [rank, group] of Object.entries(byRank)) {
      if (group.length < 2) continue;
      const teams = group.map(r => r.team).join(", ");
      const rowId = `${rid}#rank${rank}`;
      const ratings = new Set(group.map(r => r.rating == null ? "" : String(r.rating)));
      if (ratings.size > 1) {
        out.push(finding("ERROR", "state/duplicate-rank-diff-rating", tab, rowId,
          `${group.length} teams share rank ${rank} with different ratings (${group.map(r => `${r.team}:${r.rating ?? "—"}`).join(", ")}). ` +
          `Same rank must mean same rating; one of these rows is wrong.`));
        continue;
      }
      const near = (thresholds[rid] || []).filter(t => Math.abs(t.atRank - Number(rank)) <= 1);
      if (near.length)
        out.push(finding("WARN", "state/tie-at-threshold", tab, rowId,
          `Unbroken tie at rank ${rank} (${teams}) sits at or adjacent to ${near.map(t => `"${t.cut.name}" (rank ${t.atRank})`).join(" and ")}. ` +
          `The threshold selects a single row, so the app picks between tied teams arbitrarily — and the tiebreak rule is not in the sources. Resolve the tie or document the tiebreak.`));
      else
        out.push(finding("INFO", "state/tie", tab, rowId,
          `${group.length} teams tied at rank ${rank} on rating ${group[0].rating ?? "—"} (${teams}). Away from every cut-line; no action needed.`));
    }
  }
  return out;
};

/**
 * The check that matters most: a cut-line scoped to a nation that is not in
 * that ranking's captured Standings binds nothing and fails silently. Uses the
 * shared teamKey so validator and app can never disagree on what matches.
 * Skipped when the ranking has no standings at all — that is the coverage
 * rule's finding, not a scoping error.
 */
export const appliesToBinds: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const teamsByRanking: Record<string, Set<string>> = {};
  const anyStandings: Set<string> = new Set();
  for (const s of ds.standings) {
    if (s.ranking_id == null) continue;
    anyStandings.add(String(s.ranking_id));
    (teamsByRanking[String(s.ranking_id)] ||= new Set()).add(teamKey(s.team));
  }
  for (const c of ds.cuts) {
    if (c.applies_to == null || c.ranking_id == null) continue;
    const rid = String(c.ranking_id);
    if (!anyStandings.has(rid)) continue;
    const keys = teamsByRanking[rid];
    const missing = String(c.applies_to).split(",").map(x => x.trim()).filter(x => x && !keys.has(teamKey(x)));
    if (missing.length)
      out.push(finding("ERROR", "state/applies-to-binds-nothing", ds.sheetNameOf.cuts, idOf.cuts(c),
        `applies_to "${missing.join('", "')}" matches no team in ${rid}'s standings after alias normalisation. ` +
        `A rule scoped to an absent nation binds nothing and fails silently. Fix the name, add the team to Standings, or extend the ALIAS map.`));
  }
  return out;
};

/**
 * tz provenance (docs/timezones.md; README "Fixtures.tz"). tz_source is a
 * REQUIRED enum whenever tz is non-blank: it must lead with RESEARCHED (the
 * organiser's published local-time schedule was read) or DERIVED (inferred
 * — offset arithmetic, venue geography), reusing stage_source's vocabulary.
 * DERIVED must carry its premise in the same cell — a bare token would be
 * the unmarked-inference problem one level down. ERROR, not WARN: a tz with
 * no declared provenance is an unauditable claim — the reader cannot tell
 * read-the-schedule from guessed, and unauditable is treated as false here,
 * unlike a blank tz (an honest "not yet sourced", which stays the
 * coverage/tz-undeclared WARN). Rows with neither tz nor tz_source are
 * silent — no value, nothing to source. tz_source without tz is a dangling
 * marker (WARN): the value it described is gone.
 */
export const tzProvenance: Rule = ({ ds }) => {
  const out: Finding[] = [];
  for (const f of ds.fixtures) {
    const tz = f.tz == null || String(f.tz).trim() === "" ? null : String(f.tz);
    const src = f.tz_source == null || String(f.tz_source).trim() === "" ? null : String(f.tz_source).trim();
    if (tz == null && src == null) continue;
    const id = String(f.fixture_id);
    if (tz != null && src == null) {
      out.push(finding("ERROR", "state/tz-unsourced", ds.sheetNameOf.fixtures, id,
        `tz "${tz}" has no tz_source. Provenance is required whenever tz is filled: lead with RESEARCHED ` +
        `(organiser's published local-time schedule read) or DERIVED (premise stated). An unsourced zone is ` +
        `unauditable — indistinguishable from a guess.`));
      continue;
    }
    if (src != null) {
      const m = src.match(/^(RESEARCHED|DERIVED)\b/);
      if (tz == null) {
        out.push(finding("WARN", "state/tz-source-orphaned", ds.sheetNameOf.fixtures, id,
          `tz_source is filled but tz is blank — a provenance marker describing no value. If the zone was ` +
          `removed, remove its marker; if it should exist, restore it.`));
        continue;
      }
      if (!m) {
        out.push(finding("ERROR", "state/tz-source-invalid", ds.sheetNameOf.fixtures, id,
          `tz_source "${src.slice(0, 60)}…" does not lead with RESEARCHED or DERIVED (stage_source's enum). ` +
          `The leading token is what makes provenance machine-checkable.`));
      } else if (m[1] === "DERIVED" && src.replace(/^DERIVED\b[\s(:—–-]*/, "").trim().length < 10) {
        out.push(finding("ERROR", "state/tz-source-invalid", ds.sheetNameOf.fixtures, id,
          `tz_source is DERIVED with no premise. A derivation must state what it derives from ` +
          `(offset, venue, listing) — a bare DERIVED is an unmarked inference wearing a marker.`));
      }
    }
  }
  return out;
};
