# Design note: placement-fixture verdicts

*Status: tiers 1–2 IMPLEMENTED 2 Aug 2026 (`src/lib/placement.ts`, shared;
harnesses `test/placement-probe.mjs`, `test/placement-negative.mjs`). Tier 3
(dead-rubber detection) explicitly deferred — it is the only tier that
consumes results. One design correction against this note: the example
sentences below ("winner takes an Olympic berth", "3 wins from a berth")
predate the confirmed fbl-005 conditional and are NOT what was built. The
implementation derives sentences only from structured fields (stage names,
berth/qualifier counts, hop counts) and quotes criterion / eligibility_note /
entry_condition verbatim — it never names a berth recipient in its own
voice, so a conditional recipient can never be flattened into "the winner
qualifies". Ranking edges are not traversed (qualification by table stays
the ranking verdict's domain); the two verdicts coexist per fixture as
proposed below. Written 2 Aug 2026 after the CONCACAF U-20 case.*

## The gap

`fixtureVerdict` answers one question: "how close is a participant to a
ranking cut-line?" It returns `null` for any fixture whose competition has no
`RANKING_POINTS` outbound link. That made it blind to the two most material
games in the sheet on 1 Aug 2026 — U-20 Matchday 3 games that set the
quarter-final bracket of a tournament whose **winner takes an Olympic berth**
(fbl-005) — while rating a bilateral cricket game "live" on a technicality.
Cricket and fencing qualify via rankings; football, basketball, baseball and
most of the remaining ~46 sports qualify via tournaments. The verdict system
currently speaks only about the minority case. The user's materiality
judgment lived entirely outside the tool — the exact failure handoff PART 8
#10 describes.

## What a placement verdict would need

All of it is already in the graph; no new columns required for the base tier:

1. **Berth distance** — from the fixture's competition, `routesToBerth`
   already enumerates paths to an Olympic event. For a knockout fixture, the
   number of wins between this game and the berth is: rounds remaining in
   this tournament (derivable from stage names: QF → SF → F) plus advancing
   hops on the route. A QF-shaping group game in a winner-takes-berth
   tournament is "3 wins from a berth."
2. **Stage semantics** — a parser from `stage` strings to round depth
   (Group/Matchday n → pre-knockout; Quarter-final → 3 from title;
   Semi-final → 2; Final → 1). The sheet's stage vocabulary is already
   near-uniform; the validator's stage regexes cover most of it.
3. **Elimination stakes** — whether the game is single-elimination (loser
   out), a group game feeding a bracket (loser seeded worse, not out), or a
   dead rubber (both teams' progression already fixed). The first two are
   derivable from stage + format; the third needs group standings, which
   requires **results** — this is where the `result` column stops being
   decorative.

## What it would say

For fx-0062 (Canada v Jamaica, Matchday 3, U-20):
> "Shapes the quarter-final bracket of a tournament whose winner takes an
> Olympic berth. Winner is 3 wins from LA28; loser faces a harder bracket
> path, not elimination."

For a QF itself:
> "Single elimination. Winner is 3 wins from an Olympic berth; loser is out
> of this route (consolation route exists via X / no other route)." — the
> consolation clause reads `entry_condition` edges from the same graph.

## What it cannot know

- **Seeding arithmetic** ("Canada needs a draw to top the group") requires
  computing live group tables from results — a football-specific points
  model (3/1/0) the sheet deliberately doesn't encode. Recommend: don't.
  State bracket-shaping without resolving it.
- **Strength asymmetry** — "3 wins from a berth" treats beating Haiti and
  beating Mexico as equal. The tool should say distance, not probability.
  No simulation, no ratings — consistent with the Rankings view's "everything
  here is arithmetic on the captured table" stance.
- **Third-place/repechage variants** whose berth path skips rounds — these
  exist (Olympic football's bronze); the route enumeration handles them only
  if the Links rows model them.

## Interaction with the existing verdict

Placement and ranking verdicts can coexist on one fixture (an Asian Games
game both feeds the T20I ranking and advances a knockout). Render both, or
rank placement first when a berth is ≤ N wins away. The `live/low/none/
unknown` vocabulary transfers: `live` = winner/loser berth-distance differs
and the berth is near; `low` = distance long or stakes symmetric; `none` =
dead rubber (needs results); `unknown` = stage unparseable.

## Cost estimate

Stage parser + berth-distance walk: modest, reuses `routesToBerth` and the
existing stage vocabulary. Dead-rubber detection: requires group-table
computation from results — significantly more, sport-specific, and the only
tier that *consumes* results. Recommend building tier 1 (distance + stakes
statement) and explicitly deferring dead-rubber detection.
