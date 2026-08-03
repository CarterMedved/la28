/**
 * Referential integrity — every id-valued cell resolves to a real record or a
 * declared sentinel. All ERROR: an unresolvable reference makes the graph lie.
 */
import type { Rule, Finding } from "../types.ts";
import { finding, idOf } from "../types.ts";

export const referential: Rule = ({ ds, sentinels }) => {
  const out: Finding[] = [];
  const compIds = new Set(ds.comps.map(c => c.competition_id));
  const eventIds = new Set(ds.events.map(e => e.olympic_event_id));
  const rankIds = new Set(ds.rank.map(r => r.ranking_id));
  const cutIds = new Set(ds.cuts.map(c => c.cut_line_id));
  const nodeIds = new Set([...compIds, ...eventIds, ...rankIds]);

  // Links.from_id / to_id — enumerate every unresolved value; sentinels come
  // from config, nothing is assumed.
  for (const l of ds.links) {
    const id = idOf.links(l);
    for (const col of ["from_id", "to_id"] as const) {
      const v = l[col];
      if (v == null) { out.push(finding("ERROR", `referential/links-${col}`, ds.sheetNameOf.links, id, `${col} is blank`)); continue; }
      if (!nodeIds.has(v) && !sentinels.has(String(v)))
        out.push(finding("ERROR", `referential/links-${col}`, ds.sheetNameOf.links, id,
          `${col} "${v}" resolves to no competition, Olympic event or ranking, and is not a declared sentinel. ` +
          `Fix the id, or add it to sentinels.json if it is a legitimate allocation source.`, `/${col}`));
    }
    if (l.cut_line_id != null && !cutIds.has(l.cut_line_id))
      out.push(finding("ERROR", "referential/links-cut_line_id", ds.sheetNameOf.links, id,
        `cut_line_id "${l.cut_line_id}" is not in Cut_Lines`));
    if (l.gate_ranking_id != null && !rankIds.has(l.gate_ranking_id))
      out.push(finding("ERROR", "referential/links-gate_ranking_id", ds.sheetNameOf.links, id,
        `gate_ranking_id "${l.gate_ranking_id}" is not in Ranking_Systems`));
  }

  for (const c of ds.cuts) {
    const id = idOf.cuts(c);
    if (c.ranking_id == null || !rankIds.has(c.ranking_id))
      out.push(finding("ERROR", "referential/cuts-ranking_id", ds.sheetNameOf.cuts, id,
        `ranking_id "${c.ranking_id}" is not in Ranking_Systems`));
    // leads_to must be a competition or Olympic event id — a display label here
    // means the cut-line's destination cannot be resolved by the app.
    if (c.leads_to != null && !compIds.has(c.leads_to) && !eventIds.has(c.leads_to))
      out.push(finding("ERROR", "referential/cuts-leads_to", ds.sheetNameOf.cuts, id,
        `leads_to "${c.leads_to}" is not a competition_id or olympic_event_id — it looks like a display label. ` +
        `Replace it with the id of the competition or event this cut-line feeds.`));
  }

  for (const s of ds.standings) {
    if (s.ranking_id == null || !rankIds.has(s.ranking_id))
      out.push(finding("ERROR", "referential/standings-ranking_id", ds.sheetNameOf.standings, idOf.standings(s),
        `ranking_id "${s.ranking_id}" is not in Ranking_Systems`));
  }

  for (const f of ds.fixtures) {
    if (f.competition_id == null || !compIds.has(f.competition_id))
      out.push(finding("ERROR", "referential/fixtures-competition_id", ds.sheetNameOf.fixtures, idOf.fixtures(f),
        `competition_id "${f.competition_id}" is not in Competitions`));
  }

  // Qualified — the settled-berth register must point at real events, and its
  // qualified_via must be a machine-readable id (competition, ranking, or
  // declared sentinel — the same id space Links.from_id draws berth sources
  // from), never a display label.
  const seenQ = new Set<string>();
  for (const q of ds.qualified) {
    const id = idOf.qualified(q);
    if (q.olympic_event_id == null || !eventIds.has(q.olympic_event_id))
      out.push(finding("ERROR", "referential/qualified-olympic_event_id", ds.sheetNameOf.qualified, id,
        `olympic_event_id "${q.olympic_event_id}" is not in Olympic_Events`));
    if (q.qualified_via != null && !compIds.has(q.qualified_via) && !rankIds.has(q.qualified_via) && !sentinels.has(String(q.qualified_via)))
      out.push(finding("ERROR", "referential/qualified-via", ds.sheetNameOf.qualified, id,
        `qualified_via "${q.qualified_via}" is not a competition_id, ranking_id or declared sentinel. ` +
        `This column is a machine-readable pointer to the berth's source, not a label.`));
    if (q.team == null)
      out.push(finding("ERROR", "referential/qualified-team", ds.sheetNameOf.qualified, id, `team is blank`));
    if (q.hold_status != null && !["SETTLED", "PROVISIONAL"].includes(String(q.hold_status).trim().toUpperCase()))
      out.push(finding("ERROR", "referential/qualified-hold_status", ds.sheetNameOf.qualified, id,
        `hold_status "${q.hold_status}" is not SETTLED or PROVISIONAL (blank means SETTLED)`));
    if (seenQ.has(id))
      out.push(finding("ERROR", "referential/qualified-duplicate", ds.sheetNameOf.qualified, id,
        `duplicate row: this event/team pair appears more than once`));
    seenQ.add(id);
  }

  return out;
};
