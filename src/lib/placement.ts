/**
 * Placement verdicts — tiers 1 and 2 of docs/placement-verdict.md.
 *
 * Structural only: derived from the link graph and stage labels, consuming
 * NO results and NO standings. That constraint is what makes the verdict
 * robust — it works on an undrawn bracket and cannot go stale.
 *
 * The one rule that matters: derived sentences use only structured fields
 * (berth counts, qualifier counts, ids, stage labels, hop counts). All rule
 * text — criterion, eligibility_note, entry_condition — is QUOTED verbatim,
 * never paraphrased. A conditional recipient (fbl-005: the USA winning
 * passes the berth to the runner-up) therefore surfaces because the quoted
 * text carries it, not because this module understood it. The module never
 * writes "the winner qualifies" in its own voice.
 *
 * What it refuses to know: probability, seeding arithmetic, who reaches the
 * final, dead rubbers (tier 3 — needs results, deferred). Where structure
 * cannot resolve, it returns level "unresolved" with the reason — not null,
 * not a guess. Null means only one thing: no placement route exists at all.
 *
 * Rankings are deliberately NOT traversed: a RANKING edge is qualification
 * by table, the ranking verdict's domain (and for e.g. a FIBA WC-qualifier
 * second-round fixture, the ranking-pool route structurally cannot apply to
 * the teams playing it). The two verdicts coexist on one fixture.
 */

type Row = Record<string, any>;

export interface StageInfo {
  kind: "knockout" | "group" | "leg" | "window" | "series" | "unknown";
  winsToTitle: number | null;   // named knockout rounds only — the name fixes the count
  label: string;
}

/** Stage label → structural meaning. Named knockout rounds carry their own
 *  distance; everything else is a shape, not a number. */
export function parseStage(stage: unknown): StageInfo {
  const s = String(stage ?? "").trim();
  if (!s) return { kind: "unknown", winsToTitle: null, label: "" };
  if (/quarter[\s-]?final/i.test(s)) return { kind: "knockout", winsToTitle: 3, label: s };
  if (/semi[\s-]?final/i.test(s))    return { kind: "knockout", winsToTitle: 2, label: s };
  if (/round of 16/i.test(s))        return { kind: "knockout", winsToTitle: 4, label: s };
  if (/round of 32/i.test(s))        return { kind: "knockout", winsToTitle: 5, label: s };
  if (/\bfinal\b/i.test(s))          return { kind: "knockout", winsToTitle: 1, label: s };
  if (/\bleg\s*\d|\btie\s*\d/i.test(s)) return { kind: "leg", winsToTitle: null, label: s };
  if (/group|matchday/i.test(s))     return { kind: "group", winsToTitle: null, label: s };
  if (/window/i.test(s))             return { kind: "window", winsToTitle: null, label: s };
  if (/series/i.test(s))             return { kind: "series", winsToTitle: null, label: s };
  return { kind: "unknown", winsToTitle: null, label: s };
}

export interface PlacementCtx {
  outbound: Map<string, Row[]>;               // from_id -> links
  regionOf: (id: string) => string | null;    // confederation, GLOBAL/absent -> null
  nameOf: (id: string) => string;
  ladderDepth: Map<string, number>;           // compId -> deepest captured knockout round
}

export function buildPlacementContext(
  links: Row[], comps: Row[], events: Row[],
  fixtures: { competition_id: unknown; stage: unknown }[],
): PlacementCtx {
  const outbound = new Map<string, Row[]>();
  for (const l of links) {
    const k = String(l.from_id ?? "");
    if (!outbound.has(k)) outbound.set(k, []);
    outbound.get(k)!.push(l);
  }
  const conf = new Map<string, string | null>();
  const names = new Map<string, string>();
  for (const c of comps) {
    const id = String(c.competition_id ?? "");
    const cf = c.confederation == null || c.confederation === "GLOBAL" ? null : String(c.confederation);
    conf.set(id, cf);
    if (c.name) names.set(id, String(c.name));
  }
  for (const e of events) {
    const id = String(e.olympic_event_id ?? "");
    if (e.name) names.set(id, String(e.name));
  }
  const ladderDepth = new Map<string, number>();
  for (const f of fixtures) {
    const cid = String(f.competition_id ?? "");
    const st = parseStage(f.stage);
    if (st.kind === "knockout" && st.winsToTitle != null)
      ladderDepth.set(cid, Math.max(ladderDepth.get(cid) ?? 0, st.winsToTitle));
  }
  return {
    outbound,
    regionOf: id => conf.get(id) ?? null,
    nameOf: id => names.get(id) ?? id,
    ladderDepth,
  };
}

/** All acyclic paths from a competition to a berth-bearing OLYMPIC_EVENT
 *  edge, following competition edges only (no rankings), region-gated the
 *  same way the app's Pathway traversal is. */
export function berthRoutes(compId: string, ctx: PlacementCtx): Row[][] {
  const walk = (id: string, home: string | null, depth: number, seen: Set<string>): Row[][] => {
    if (depth > 7) return [];
    const res: Row[][] = [];
    for (const l of ctx.outbound.get(id) ?? []) {
      const to = String(l.to_id ?? "");
      if (l.to_type === "OLYMPIC_EVENT") {
        if (Number(l.berths) > 0) res.push([l]);
        continue;
      }
      if (l.to_type !== "COMPETITION") continue;      // rankings et al: not a placement route
      const r = ctx.regionOf(to);
      if (home && r && r !== home) continue;          // region gate
      if (seen.has(to)) continue;
      for (const rest of walk(to, home, depth + 1, new Set([...seen, to])))
        res.push([l, ...rest]);
    }
    return res;
  };
  return walk(compId, ctx.regionOf(compId), 0, new Set([compId]))
    .sort((a, b) => a.length - b.length);
}

const MAX_ROUTES_SHOWN = 3;
const q = (s: unknown) => `«${String(s)}»`;   // «verbatim»

export interface PlacementVerdict {
  kind: "placement";
  level: "live" | "low" | "unresolved";
  chip: string;                 // short label for a UI chip
  distance: string;             // tier 1 — structural, no invented numbers
  stakes: string[];             // tier 2 — one line per route, counts + quoted criterion
  conditions: string[];         // verbatim quotes, prefixed by link id and field
  routesTotal: number;
  why: string;                  // headline
  footer: string;               // the refusal statement
}

export function placementVerdict(compId: string, stage: unknown, ctx: PlacementCtx): PlacementVerdict | null {
  const routes = berthRoutes(compId, ctx);
  if (!routes.length) return null;                    // no placement route: no verdict, not a wrong one

  const st = parseStage(stage);
  const direct = routes.some(r => r.length === 1);

  // ---- tier 2: stakes, counts + verbatim criterion ----
  const shown = routes.slice(0, MAX_ROUTES_SHOWN);
  const stakes = shown.map(route => {
    const berthEdge = route[route.length - 1];
    const berths = Number(berthEdge.berths);
    const hops = route.slice(0, -1).map(l => {
      const n = Number(l.qualifiers) > 0 ? `${l.qualifiers} advance` : "count unknown";
      const fb = l.entry_condition ? "fallback step — " : "";
      return `${fb}${n} to ${ctx.nameOf(String(l.to_id))}`;
    });
    const via = hops.length ? `via ${hops.join(", then ")}: ` : "";
    const from = route.length > 1 ? ` awarded at ${ctx.nameOf(String(berthEdge.from_id))}` : "";
    return `${via}${berths} berth${berths === 1 ? "" : "s"} in ${ctx.nameOf(String(berthEdge.to_id))}${from}` +
           (berthEdge.criterion ? ` — criterion ${q(berthEdge.criterion)}` : " — no criterion recorded");
  });
  if (routes.length > MAX_ROUTES_SHOWN)
    stakes.push(`(+${routes.length - MAX_ROUTES_SHOWN} more route${routes.length - MAX_ROUTES_SHOWN === 1 ? "" : "s"} not shown)`);

  // ---- conditions: quote, never interpret ----
  const conditions: string[] = [];
  const seenLink = new Set<string>();
  for (const route of shown) for (const l of route) {
    const id = String(l.link_id ?? "?");
    if (seenLink.has(id)) continue;
    seenLink.add(id);
    if (l.entry_condition) conditions.push(`${id} · entry_condition: ${q(l.entry_condition)}`);
    if (l.eligibility_note) conditions.push(`${id} · eligibility_note: ${q(l.eligibility_note)}`);
  }

  // ---- tier 1: distance ----
  const shortest = routes[0].length;                  // competitions between here and the berth edge
  const chain = shortest > 1
    ? ` Berths on the nearest route are awarded ${shortest - 1} round${shortest - 1 === 1 ? "" : "s"} downstream of this competition ` +
      `(round 1 of ${shortest}, berth-awarding round: ${ctx.nameOf(String(routes[0][routes[0].length - 1].from_id))}).`
    : "";

  let level: PlacementVerdict["level"];
  let distance: string;
  let chip: string;

  if (st.kind === "knockout" && st.winsToTitle != null) {
    level = direct ? "live" : "low";
    distance = `${st.winsToTitle} win${st.winsToTitle === 1 ? "" : "s"} from this competition's title.` +
      (direct ? " What the title is worth is quoted below — this verdict does not name a berth recipient." : chain);
    chip = `${st.winsToTitle} win${st.winsToTitle === 1 ? "" : "s"} from title`;
  } else if (st.kind === "group") {
    level = "low";
    const depth = ctx.ladderDepth.get(compId);
    distance = "Group-stage game — it shapes the knockout bracket; no fixed win count exists from here. " +
      (depth ? `The captured ladder in this competition runs ${depth} knockout round${depth === 1 ? "" : "s"} to the title.`
             : "No knockout rounds are captured for this competition yet, so the ladder length is not derivable.") + chain;
    chip = "shapes bracket";
  } else if (st.kind === "leg") {
    level = "low";
    distance = "One leg of a two-legged tie — the tie, not this game alone, decides advancement." + chain;
    chip = shortest > 1 ? `round 1 of ${shortest}` : "two-legged tie";
  } else if (st.kind === "window") {
    level = "low";
    distance = "Windowed round-robin — advancement is decided over the whole round, not this game alone." + chain;
    chip = "round-robin";
  } else if (st.kind === "series") {
    level = "low";
    distance = "Bilateral series game — no knockout structure to measure against." + chain;
    chip = "series";
  } else {
    level = "unresolved";
    distance = st.label
      ? `Stage ${q(st.label)} is not a recognised structure, so no distance can be derived. The stakes below still hold.`
      : "No stage recorded for this fixture, so no distance can be derived. The stakes below still hold.";
    chip = "unresolved";
  }

  const why = level === "unresolved"
    ? `This competition leads to an Olympic berth, but the fixture's place in it cannot be resolved structurally.`
    : direct
      ? `This competition awards Olympic berths directly. ${conditions.length ? "Recipient rules are conditional — read the quoted conditions; the title alone may not equal the berth." : "See the quoted criterion for who takes them."}`
      : `This competition feeds a route that ends in Olympic berths.`;

  return {
    kind: "placement", level, chip, distance, stakes, conditions,
    routesTotal: routes.length, why,
    footer: "Structural verdict from the link graph. No results, seeding or probability consulted. " +
      "Ranking-based routes are excluded here — the ranking verdict covers them.",
  };
}
