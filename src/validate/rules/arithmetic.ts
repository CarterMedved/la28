/**
 * Berth arithmetic. The sum of Links.berths into each Olympic event must equal
 * quota_total exactly (ERROR — a wrong total states a false quota). Berths on
 * an edge whose target is not an Olympic event are suspicious but not wrong
 * (WARN — advancing edges use `qualifiers`).
 */
import type { Rule, Finding } from "../types.ts";
import { finding, idOf } from "../types.ts";
import { RAW } from "../../lib/load.ts";
import { isProvisional, type QualifiedRowShape } from "../../lib/qualified.ts";

export const arithmetic: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const eventIds = new Set(ds.events.map(e => e.olympic_event_id));

  const inboundBerths: Record<string, number> = {};
  for (const l of ds.links) {
    if (l.to_id != null && eventIds.has(l.to_id))
      inboundBerths[String(l.to_id)] = (inboundBerths[String(l.to_id)] || 0) + (Number(l.berths) || 0);
    if (l.berths != null && (l.to_id == null || !eventIds.has(l.to_id)))
      out.push(finding("WARN", "arithmetic/berths-on-non-event", ds.sheetNameOf.links, idOf.links(l),
        `berths=${l.berths} but to_id "${l.to_id}" is not an Olympic event. Berths are quota places only; ` +
        `if this edge advances teams, move the count to qualifiers.`));
  }

  for (const e of ds.events) {
    const id = idOf.events(e);
    const sum = inboundBerths[id] || 0;
    // The loader coerces non-numeric quota_total to null, so read the RAW cell:
    // a non-blank raw value that cleaned to null is an unreadable number, not a
    // blank — and must not fall through to a misleading berth-sum error.
    const rawQuota = e[RAW]?.quota_total;
    const quota = Number(e.quota_total);
    if (e.quota_total == null || !Number.isFinite(quota))
      out.push(finding("ERROR", "arithmetic/quota-unreadable", ds.sheetNameOf.events, id,
        `quota_total ${rawQuota == null ? "is blank" : `"${rawQuota}" is not a number`}`));
    else if (sum !== quota)
      out.push(finding("ERROR", "arithmetic/berth-sum", ds.sheetNameOf.events, id,
        `inbound berths total ${sum}, quota_total is ${quota}. Every quota place must be accounted for by exactly one link.`));
  }

  return out;
};

/**
 * Settled places must fit inside the structure that awards them:
 *   - per link: Qualified rows citing a link's from_id as qualified_via, for
 *     that link's target event, never exceed the link's berths;
 *   - per event: total Qualified rows never exceed quota_total.
 * Overfill states a false allocation — ERROR, same family as berth sums.
 * hold_status = PROVISIONAL rows are not counted: a contestable hold is not
 * a filled place.
 */
export const qualifiedFill: Rule = ({ ds }) => {
  const out: Finding[] = [];
  if (!ds.qualified.length) return out;
  const eventIds = new Set(ds.events.map(e => e.olympic_event_id));

  // per-link: berth capacity by (source id, event id), summed across parallel links
  const capacity: Record<string, number> = {};
  const hasBerths: Record<string, boolean> = {};
  for (const l of ds.links) {
    if (l.from_id == null || l.to_id == null || !eventIds.has(l.to_id)) continue;
    const k = `${l.from_id}|${l.to_id}`;
    if (l.berths != null) { capacity[k] = (capacity[k] || 0) + Number(l.berths); hasBerths[k] = true; }
  }
  const filled: Record<string, string[]> = {};
  const perEvent: Record<string, number> = {};
  for (const q of ds.qualified) {
    if (q.olympic_event_id == null) continue;
    if (isProvisional(q as QualifiedRowShape)) continue;
    perEvent[String(q.olympic_event_id)] = (perEvent[String(q.olympic_event_id)] || 0) + 1;
    if (q.qualified_via != null)
      (filled[`${q.qualified_via}|${q.olympic_event_id}`] ||= []).push(String(q.team));
  }
  for (const [k, teams] of Object.entries(filled)) {
    if (!hasBerths[k]) continue;   // berth-less edge (e.g. REALLOCATION) — nothing to overfill
    if (teams.length > capacity[k]) {
      const [via, ev] = k.split("|");
      out.push(finding("ERROR", "arithmetic/qualified-overfill-link", ds.sheetNameOf.qualified, k,
        `${teams.length} settled places cite ${via} for ${ev} (${teams.join(", ")}) but the link(s) award only ${capacity[k]} berth(s). ` +
        `Either a Qualified row is wrong or the link's berth count is.`));
    }
  }
  for (const e of ds.events) {
    const id = String(e.olympic_event_id);
    const n = perEvent[id] || 0;
    const quota = Number(e.quota_total);
    if (Number.isFinite(quota) && n > quota)
      out.push(finding("ERROR", "arithmetic/qualified-overfill-event", ds.sheetNameOf.qualified, id,
        `${n} settled places recorded for ${id} but quota_total is ${quota}. More teams cannot hold places than the event has.`));
  }
  return out;
};
