/**
 * Cut-line threshold computation shared by the app and the validator.
 * Extracted verbatim from qualification-app.jsx. A threshold is the rank a
 * cut-line falls at on the captured table; a cut deeper than the captured
 * depth is "blocked" — reported, never guessed.
 */

export interface StandingRow {
  ranking_id: string; rank: number; team: string;
  continent?: string | null; rating?: number | null;
  olympic_eligible?: string | null; counts_in_field?: string | null;
  already_qualified?: string | null; provisional?: string | null;
  [k: string]: unknown;
}
export interface CutLine {
  cut_line_id: string; ranking_id: string; name?: string | null;
  rule?: string | null; n?: number | string | null; offset?: number | string | null;
  applies_to?: string | null; leads_to?: string | null;
  continents?: string | null;
  [k: string]: unknown;
}

// Inline-or-fold threshold for text shown on a route step (the app's
// recorded-rule display, and the cap a Links.count_gloss must fit in —
// hygiene/count-gloss-length WARNs above it). ONE number: 134 characters,
// the length of the longest signpost sentence the inline display replaced.
// Shared here so the validator's cap and the app's display cannot drift.
export const INLINE_RULE_MAX = 134;

// Legacy fallback for workbooks predating the Cut_Lines.continents column.
// The list is part of the RULE, so it belongs on the cut-line row (cricket's
// four exclude the Americas because the host holds that berth; FIBA files
// Australia and NZ under Asia) — a hardcoded list here is PART 8 #5 verbatim.
const LEGACY_CONTINENTS = ["Africa", "Asia", "Europe", "Oceania"];
export const continentsOf = (c: CutLine): string[] =>
  c.continents != null && String(c.continents).trim() !== ""
    ? String(c.continents).split(",").map(s => s.trim()).filter(Boolean)
    : LEGACY_CONTINENTS;
export interface Threshold { cut: CutLine; atRank: number; appliesTo: string | null }
/** Why a cut-line could not be located: "depth" — the threshold falls beyond
 *  the captured standings (or the rows the rule needs are missing); "basis" —
 *  a TOP_N_OF_POOL cut whose exclusion set could not be derived at all (no
 *  second-round participation captured); "unsatisfiable" — the row declares
 *  computability=UNSATISFIABLE: the pool derives fine, but no reading of the
 *  allocation seats its result (e.g. a global top-7 needing six European
 *  seats where four exist), so nothing is computed until the reading is
 *  resolved and the marker cleared. The three need different fixes and must
 *  not share an explanation. */
export interface Blocked { cut: CutLine; depth: number; reason: "depth" | "basis" | "unsatisfiable" }

/**
 * Feeder competitions whose second-round participation defines a
 * TOP_N_OF_POOL exclusion set. Derived structurally: the cut's leads_to fans
 * out to target competitions (links FROM leads_to); the links INTO those
 * targets that carry an entry_condition are the tournament-route edges, and
 * their from_ids are the qualifying competitions. Keying on RANKING_POINTS
 * was the bug this replaces — that relationship means "plays for ranking
 * points", which the EuroBasket pre-qualifiers also do, and their
 * "Pre-qualifiers second round" stage then wrongly excluded the exact teams
 * the pool consists of. The /second round/i stage match survives, but ONLY
 * inside these declared feeders: it is the pool's literal definition ("did
 * not reach the second round"), not a competition selector. Do not widen it
 * back out.
 */
export function poolFeeders(
  c: CutLine,
  links: { from_id?: unknown; to_id?: unknown; entry_condition?: unknown }[],
): Set<string> {
  const fan = links.filter(l => String(l.from_id) === String(c.leads_to ?? "")).map(l => String(l.to_id));
  const targets = new Set(fan.length ? fan : [String(c.leads_to ?? "")]);
  return new Set(links
    .filter(l => l.entry_condition != null && String(l.entry_condition).trim() !== "" && targets.has(String(l.to_id)))
    .map(l => String(l.from_id)));
}

export function capturedDepthOf(standBy: Record<string, StandingRow[]>): Record<string, number> {
  const capturedDepth: Record<string, number> = {};
  Object.entries(standBy).forEach(([rid, rows]) =>
    capturedDepth[rid] = Math.max(...rows.map(r => r.rank || 0)));
  return capturedDepth;
}

/**
 * FOPQT ranking pool derivation (README: "FOPQT ranking pool" vs "FOPQT
 * tournament route"). For each TOP_N_OF_POOL cut-line, the EXCLUSION set is
 * every team that reached a second round of a competition feeding the cut's
 * ranking via RANKING_POINTS — derived from fixture participation, never
 * stored. Keys are teamKey so ranking spellings and fixture spellings meet.
 */
export function derivePoolExclusions(
  cuts: CutLine[],
  links: { from_id?: unknown; to_id?: unknown; entry_condition?: unknown }[],
  fixtures: { competition_id?: unknown; team1?: unknown; team2?: unknown; stage?: unknown }[],
  keyOf: (t: unknown) => string,
): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const c of cuts) {
    if (c.rule !== "TOP_N_OF_POOL") continue;
    const feeders = poolFeeders(c, links);
    const excl = new Set<string>();
    for (const f of fixtures) {
      if (!feeders.has(String(f.competition_id))) continue;
      if (!/second round/i.test(String(f.stage ?? ""))) continue;
      if (f.team1 != null) excl.add(keyOf(f.team1));
      if (f.team2 != null) excl.add(keyOf(f.team2));
    }
    // An empty set means the derivation basis is missing (no second-round
    // fixtures captured), which is indistinguishable from "not captured" —
    // omit the key so the cut BLOCKS rather than computing over an
    // unexcluded pool, which would silently hand the places to WC teams.
    if (excl.size > 0) out[c.cut_line_id] = excl;
  }
  return out;
}

export function computeThresholds(
  cutsBy: Record<string, CutLine[]>,
  standBy: Record<string, StandingRow[]>,
  poolExclusions?: Record<string, Set<string>>,
  keyOf?: (t: unknown) => string,
): { thresholds: Record<string, Threshold[]>; blocked: Record<string, Blocked[]>; capturedDepth: Record<string, number> } {
  const capturedDepth = capturedDepthOf(standBy);
  const thresholds: Record<string, Threshold[]> = {};
  const blocked: Record<string, Blocked[]> = {};
  Object.entries(cutsBy).forEach(([rid, cs]) => {
    const rows = (standBy[rid] || []).slice().sort((a, b) => a.rank - b.rank);
    const depth = capturedDepth[rid] || 0;
    thresholds[rid] = []; blocked[rid] = [];
    cs.forEach(c => {
      // A declared unsatisfiable allocation blocks before any computation:
      // displaying a top-N that no reading can seat would be worse than
      // displaying nothing. Cleared by blanking Cut_Lines.computability.
      if (String(c.computability ?? "").toUpperCase() === "UNSATISFIABLE") {
        blocked[rid].push({ cut: c, depth, reason: "unsatisfiable" });
        return;
      }
      let atRank: number | null = null;
      if (c.rule === "RANK_AT_OR_ABOVE") atRank = Number(c.n);
      else if (c.rule === "TOP_PER_NAMED_CONTINENT") {
        // The line sits at the worst-placed continental leader: below that you cannot take one of these places.
        const conts = continentsOf(c);
        const leaders = conts.map(k => rows.find(r => r.continent === k && r.olympic_eligible === "Y")).filter(Boolean) as StandingRow[];
        atRank = leaders.length === conts.length ? Math.max(...leaders.map(l => l.rank)) : null;
      }
      else if (c.rule === "NEXT_N_NOT_QUALIFIED") {
        // Who is actually competing for these places: eligible (or counting toward the field),
        // not already qualified, and not the team provisionally holding a place above.
        const pool = rows.filter(r =>
          (r.olympic_eligible === "Y" || r.counts_in_field === "Y") &&
          r.already_qualified !== "Y" && r.provisional !== "Y");
        const off = Number(c.offset) || 0;
        const edge = pool[off + Number(c.n) - 1];
        atRank = edge ? edge.rank : null;
      }
      else if (c.rule === "PROVISIONAL_HOLDER") {
        const holder = rows.find(r => r.provisional === "Y");
        atRank = holder ? holder.rank : null;
      }
      else if (c.rule === "TOP_N_OF_POOL") {
        // The pool: eligible, not already qualified, and NOT excluded (the
        // exclusion set — e.g. teams that reached the WC qualifiers' second
        // round — comes from derivePoolExclusions). The line sits at the
        // last of the n places, exactly like NEXT_N_NOT_QUALIFIED but over
        // the derived pool. No exclusion set → blocked, never guessed.
        const excl = poolExclusions?.[c.cut_line_id];
        if (excl && keyOf) {
          const pool = rows.filter(r =>
            (r.olympic_eligible === "Y" || r.counts_in_field === "Y") &&
            r.already_qualified !== "Y" && r.provisional !== "Y" &&
            !excl.has(keyOf(r.team)));
          const off = Number(c.offset) || 0;
          const edge = pool[off + Number(c.n) - 1];
          atRank = edge ? edge.rank : null;
        }
      }
      if (atRank && atRank <= depth) thresholds[rid].push({ cut: c, atRank, appliesTo: c.applies_to || null });
      else blocked[rid].push({ cut: c, depth,
        reason: c.rule === "TOP_N_OF_POOL" && !(poolExclusions?.[String(c.cut_line_id)] && keyOf) ? "basis" : "depth" });
    });
  });
  return { thresholds, blocked, capturedDepth };
}

/**
 * Per-team reading against ONE cut-line, measured by THE RULE'S OWN LOGIC
 * — the 9 Aug 2026 audit fix. The scalar threshold above answers "where
 * does the line sit on the table"; it must NOT be used to measure a
 * team's distance, because two rules break that arithmetic:
 *  - TOP_PER_NAMED_CONTINENT: a challenger is measured within its OWN
 *    continent (Bangladesh chases India's Asia place, 50 points, past
 *    Pakistan — not South Africa's Africa place at 19), and a team from
 *    an unnamed continent, or ineligible, cannot take the place at all.
 *  - The pooled rules: a team outside the pool (ineligible, excluded,
 *    already qualified) is not "N places from the line" — it is not in
 *    the contest, and place-gaps count POOL positions, not table rows.
 * States: "ineligible" (cannot take this cut's place — reason attached),
 * "already_qualified" (settled — nothing here contests them), "holds"
 * (provisional holder of this line), "leader" (tops its continent),
 * "inside"/"chasing" with gaps. `settled` marks a continental line whose
 * leader is recorded already_qualified: the data treats the place as
 * settled, so a challenger's reading must say so rather than imply a
 * live chase.
 */
export interface TeamLineReading {
  state: "ineligible" | "already_qualified" | "holds" | "leader" | "inside" | "chasing";
  reason?: string;
  edgeTeam: string | null; edgeRank: number | null;
  gapRating: number | null; gapPlaces: number | null;
  settled?: boolean;
}
export function teamLineFacts(
  cut: CutLine, atRank: number, rows: StandingRow[], r: StandingRow,
  opts?: { exclusions?: Set<string>; keyOf?: (t: unknown) => string; awardsPlaces?: boolean },
): TeamLineReading | null {
  const sorted = rows.slice().sort((a, b) => a.rank - b.rank);
  const gaps = (edge: StandingRow | undefined | null) => ({
    edgeTeam: edge?.team ?? null, edgeRank: edge?.rank ?? null,
    gapRating: edge && r.rating != null && edge.rating != null ? Math.abs(Number(r.rating) - Number(edge.rating)) : null,
  });

  if (cut.rule === "TOP_PER_NAMED_CONTINENT") {
    // Continental route uses PLAIN olympic_eligible — counts_in_field never
    // counts toward a continental allocation (README, counted order).
    const conts = continentsOf(cut);
    if (r.olympic_eligible !== "Y")
      return { state: "ineligible", reason: "not eligible to hold an Olympic place", ...gaps(null), gapPlaces: null };
    if (!conts.includes(String(r.continent ?? "")))
      return { state: "ineligible", reason: `${r.continent ?? "its region"} is not among this route's continents`, ...gaps(null), gapPlaces: null };
    const mine = sorted.filter(x => x.continent === r.continent && x.olympic_eligible === "Y");
    const leader = mine[0];
    const settled = leader?.already_qualified === "Y";
    if (r.already_qualified === "Y") return { state: "already_qualified", ...gaps(null), gapPlaces: null, settled };
    if (leader && leader.rank === r.rank) return { state: "leader", ...gaps(leader), gapPlaces: 0, settled };
    const above = mine.filter(x => x.rank < r.rank).length;
    return { state: "chasing", ...gaps(leader), gapPlaces: above, settled };
  }

  if (r.already_qualified === "Y") return { state: "already_qualified", ...gaps(null), gapPlaces: null };

  if (cut.rule === "PROVISIONAL_HOLDER") {
    if (r.provisional === "Y" && r.rank === atRank) return { state: "holds", ...gaps(null), gapPlaces: null };
    // Challengers must be able to HOLD the place: plain eligibility.
    if (r.olympic_eligible !== "Y")
      return { state: "ineligible", reason: "not eligible to hold an Olympic place", ...gaps(null), gapPlaces: null };
    const holder = sorted.find(x => x.rank === atRank) ?? null;
    return { state: r.rank <= atRank ? "inside" : "chasing", ...gaps(holder), gapPlaces: Math.abs(r.rank - atRank) };
  }

  if (cut.rule === "NEXT_N_NOT_QUALIFIED" || cut.rule === "TOP_N_OF_POOL") {
    const excl = cut.rule === "TOP_N_OF_POOL" ? opts?.exclusions : undefined;
    if (cut.rule === "TOP_N_OF_POOL" && !excl) return null;   // no basis → no reading, never a guess
    // counts_in_field is a FIELD override (README, counted order): it puts
    // a team that cannot hold an Olympic place into a tournament field. A
    // cut that leads to an OLYMPIC EVENT awards places, so there the
    // ladder is eligible nations only — West Indies is 14 points off the
    // men's host-fallback line and must never read as chasing it. The
    // caller derives awardsPlaces from the cut's leads_to.
    const placeCut = opts?.awardsPlaces === true;
    if (placeCut && r.olympic_eligible !== "Y")
      return { state: "ineligible", reason: "counts toward tournament fields but cannot hold an Olympic place", edgeTeam: null, edgeRank: null, gapRating: null, gapPlaces: null };
    const pool = sorted.filter(x =>
      (x.olympic_eligible === "Y" || (!placeCut && x.counts_in_field === "Y")) &&
      x.already_qualified !== "Y" && x.provisional !== "Y" &&
      !(excl && opts?.keyOf && excl.has(opts.keyOf(x.team))));
    const i = pool.findIndex(x => x.rank === r.rank);
    if (i < 0) {
      const why = r.provisional === "Y" ? "holds a place above this pool"
        : excl && opts?.keyOf && excl.has(opts.keyOf(r.team)) ? "not in this pool (tournament-route entrant)"
        : "not eligible to hold an Olympic place";
      return { state: "ineligible", reason: why, ...gaps(null), gapPlaces: null };
    }
    const off = Number(cut.offset) || 0;
    const edgeIdx = off + Number(cut.n) - 1;
    const edge = pool[edgeIdx] ?? null;
    // Place-gaps in POOL positions — the rule's own ladder, not table rows.
    return { state: i <= edgeIdx ? "inside" : "chasing", ...gaps(edge), gapPlaces: Math.abs(i - edgeIdx) };
  }

  if (cut.rule === "RANK_AT_OR_ABOVE") {
    const edge = sorted.find(x => x.rank === atRank) ?? null;
    return { state: r.rank <= atRank ? "inside" : "chasing", ...gaps(edge), gapPlaces: Math.abs(r.rank - atRank) };
  }

  return null;   // unknown rule: no reading, never a generic guess
}
