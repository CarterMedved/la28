/**
 * Qualified — the single source for settled berths, for ANY sport, ranking or
 * not. Standings.already_qualified and .qualified_via are DERIVED from it at
 * load time; storing both would let them disagree, and already_qualified feeds
 * NEXT_N_NOT_QUALIFIED, so a disagreement moves cut-lines silently.
 *
 * Scope: derivation is per OLYMPIC EVENT. An event with at least one Qualified
 * row is Qualified-managed — every Standings row on a ranking feeding it gets
 * already_qualified/qualified_via/provisional from Qualified (nulled when
 * absent), and any stored values are dead weight the validator flags. An event
 * with no Qualified rows keeps its stored Standings values untouched, so
 * seeding one event never moves another event's cut-lines.
 *
 * hold_status: SETTLED (default when blank) marks a filled place and derives
 * already_qualified = Y. PROVISIONAL marks a contestable hold and derives
 * provisional = Y, NEVER already_qualified — PART 3 is explicit that marking
 * a provisional hold settled erases the very cut-line deciding whether the
 * holder keeps it. qualified_via derives for both.
 *
 * Join: Ranking_Systems.feeds_id names the event a ranking feeds (only where
 * it resolves to a real event id — fencing's "6 team events" does not).
 * A Standings row matches a Qualified row when the Qualified team equals the
 * row's team OR the row's declared represents_noc, both via the shared
 * teamKey. represents_noc is how "England holds Great Britain's berth" is
 * stated: per row, per ranking, directional — never as a global alias, which
 * would wrongly merge GB and England in sports where they are distinct.
 */
import { teamKey } from "./normalise.ts";

export interface QualifiedRowShape {
  olympic_event_id?: string | number | null;
  team?: string | number | null;
  qualified_via?: string | number | null;
  hold_status?: string | number | null;
  [k: string]: unknown;
}

export const isProvisional = (q: QualifiedRowShape): boolean =>
  String(q.hold_status ?? "").trim().toUpperCase() === "PROVISIONAL";

/** ranking_id → olympic_event_id, only where feeds_id resolves to a real event. */
export function feedsMap(
  rankSystems: { ranking_id?: unknown; feeds_id?: unknown }[],
  eventIds: Set<string>,
): Record<string, string> {
  const feeds: Record<string, string> = {};
  for (const r of rankSystems) {
    const f = r.feeds_id == null ? null : String(r.feeds_id);
    if (f && eventIds.has(f) && r.ranking_id != null) feeds[String(r.ranking_id)] = f;
  }
  return feeds;
}

export function deriveQualification<S extends { ranking_id?: unknown; team?: unknown }>(
  standings: S[],
  qualified: QualifiedRowShape[],
  rankSystems: { ranking_id?: unknown; feeds_id?: unknown }[],
  eventIds: Set<string>,
): S[] {
  if (!qualified?.length) return standings;
  const feeds = feedsMap(rankSystems, eventIds);
  const managedEvents = new Set(qualified.map(q => q.olympic_event_id == null ? null : String(q.olympic_event_id)).filter(Boolean));
  const byEventTeam: Record<string, QualifiedRowShape> = {};
  for (const q of qualified)
    if (q.olympic_event_id != null && q.team != null)
      byEventTeam[`${q.olympic_event_id}|${teamKey(q.team)}`] = q;
  return standings.map(s => {
    const ev = s.ranking_id == null ? undefined : feeds[String(s.ranking_id)];
    if (!ev || !managedEvents.has(ev)) return s;
    const rep = (s as { represents_noc?: unknown }).represents_noc;
    const q = byEventTeam[`${ev}|${teamKey(s.team)}`]
           ?? (rep != null ? byEventTeam[`${ev}|${teamKey(rep)}`] : undefined);
    const prov = q ? isProvisional(q) : false;
    return {
      ...s,
      already_qualified: q && !prov ? "Y" : null,
      provisional: prov ? "Y" : null,
      qualified_via: q ? (q.qualified_via == null ? null : String(q.qualified_via)) : null,
    };
  });
}
