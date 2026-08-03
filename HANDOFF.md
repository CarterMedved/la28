# LA28 Qualification Tracker — Handoff

Supersedes the previous handoff entirely. That one described a two-artefact project; there are
now three, and the third is the reason the first two can be trusted.

- **The workbook** (`LA28_Qualification_Database_v14.xlsx`) — eight tabs. All the data.
- **`qualification-app.jsx`** — a React app with **no data compiled in**. Reads the workbook at
  run time and derives everything.
- **`~/la28/`** — the validator repo. Shared modules the app imports, ~30 rule families, five
  test harnesses, and the decision docs.

Edit the sheet, reload the app, everything recomputes. Run the validator, find out whether the
sheet is fit to publish. Don't let a future session bake data into the code or fork the shared
logic — those two separations are the whole design.

---

## PART 0 — Read this before trusting any number below

**Counts in this document will go stale. The validator's INFO coverage block is authoritative.**
The previous handoff asserted fixture counts and a standings depth that were both wrong within
days, and a session acted on them. Run the validator first, compare, and believe the run.

---

## PART 1 — Starting a new session

> Continuing an existing project. Read these first, in this order:
>
> - `README.md` — sheet conventions, resolved PART 7 items, FIBA terminology
> - `known-issues.json` — the suppressed ERROR residue, if any, and why
> - `docs/placement-verdict.md`, `docs/timezones.md` — decisions queued, not made
> - the most recent `final-run*.txt` — current validator state
>
> Then run the validator on the current workbook and confirm you reproduce the latest run
> before touching anything.
>
> Ground rules, all learned expensively:
> - **Structured rows with fixture children outrank prose.** Prose from a prior chat session is
>   a research artefact, not a source. It can raise a verification item; it cannot overwrite.
> - **Never guess.** Set `confidence` to `UNCONFIRMED` or `AMBIGUOUS` and say what needs
>   verifying. A confident wrong number is the worst outcome here.
> - **Berths must sum to `quota_total`.** Check after every change.
> - **Eligibility filters are load-bearing.** West Indies holds ICC ranking positions but can't
>   take a quota place; only England counts for Great Britain; Crown Dependencies aren't NOCs.
> - **Parse-checking is not render-checking.** Execute the component against the real dataset.
> - **Diff-prove every workbook write.** Observed changes must equal intended changes exactly.
> - **You have no network.** If a fact needs a source, ask.
>
> Today's task: [WHAT YOU WANT]

Attach the workbook and the JSX. For a new sport, attach that sport's IOC qualification PDF.

---

## PART 2 — Where things stand

Four sports mapped: fencing, cricket, football, basketball. 19 quota pools, all berths
reconciling. Three rankings carry standings (ICC men's and women's T20I, FIBA men's world);
six are stubs. The validator exits 0.

Roughly 46 sports remain. That is now a data-entry problem with a safety net rather than an
open-ended risk, which is the actual product of the last phase.

---

## PART 3 — The data model

Eight tabs. The obvious columns are obvious; these exist because something broke without them.

### Links — the graph edges

| Column | Why it exists |
|---|---|
| `berths` | Olympic quota places only. Blank on edges that advance teams without awarding places. This is what the sum check validates. |
| `qualifiers` | How many teams pass through an advancing edge. Separate from `berths` so the sums stay clean. |
| `cascade_order` | Resolution sequence. Fencing resolves team ranking → Individual AOR → AOR by zone → zonal events, each excluding NOCs qualified earlier. Order changes the answer. |
| `entry_condition` | Marks a step you only reach by **failing** the previous one. Not the same as a conditional recipient — see `eligibility_note`. |
| `berth_math` | For when the number isn't the obvious reading, and for recording *why* an edge is modelled the way it is. |
| `eligibility_note` | **Load-bearing, and the field most likely to be missed.** Eight links carry conditional rules here that `criterion` does not state. See PART 7. |
| `gate_ranking_id` | A berth conditional on a ranking test. |
| `cut_line_id` | **Declares** which cut-line governs this edge. Inferring it from `leads_to` picked the wrong one of three. |

### Qualified — who already holds a place

Added because `Standings.already_qualified` only worked for sports with ranking tables, which
left football's two settled berths invisible to every consumer. `hold_status` is `SETTLED` or
`PROVISIONAL`; provisional rows derive `Standings.provisional = Y` and **never**
`already_qualified`, because marking a contestable hold as settled erases the cut-line deciding
whether they keep it.

**Qualified is the single source.** `Standings.already_qualified` and `qualified_via` are
derived from it at load time and must not be stored. A stored shadow on a managed event is an
ERROR.

### Standings — four states, not two

`olympic_eligible` (can hold a quota place at all), `counts_in_field` (West Indies counts
toward the eight qualifier slots despite being unable to hold a place), plus the two derived
from Qualified. `represents_noc` declares that one entity's results count for another —
England → Great Britain, directional and per-row. This is **not** an ALIAS entry; a global
symmetric synonym would collide in football, where Great Britain and England are distinct.

### Cut_Lines

`rule` is one of `RANK_AT_OR_ABOVE`, `NEXT_N_NOT_QUALIFIED`, `PROVISIONAL_HOLDER`,
`TOP_PER_NAMED_CONTINENT`, `TOP_N_OF_POOL`. `continents` is declared on the row, not hardcoded
in the module — FIBA merges Oceania into Asia and would break a fixed list. `applies_to` scopes
a line to one nation; a value matching no team after normalisation is an ERROR, because a rule
that binds nothing fails silently.

`TOP_N_OF_POOL` **fails closed**: an empty derivation basis blocks the cut rather than
computing over an unexcluded pool.

### The rest

**Olympic_Events** — `quota_total`, `quota_unit`. **Competitions** — `confederation` gates
region-crossing in traversal; `start_date`/`end_date` are always the competition's true window,
never the captured-fixture window, which is derived from `min(Fixtures.date)`.
**Ranking_Systems** — `points_model_type`, and `selection_rule_type = CONTINGENCY_ONLY` marks a
ranking that never grants entry. **Fixtures** — `stage_source` is `RESEARCHED` or `DERIVED`;
`notes` and `date_confidence` carry per-fixture provenance.

---

## PART 4 — What you type vs what the app derives

**Type once per sport:** quota totals, links with berths and conditions, cut-line rules, ranking
metadata, eligibility exclusions.

**Type recurring:** standings refreshes, `Qualified` rows as results land, fixtures where no
feed exists, confirmations replacing `UNCONFIRMED`.

**Never type:** hop counts, route enumeration, cut-line positions, materiality verdicts,
berth-sum validation, captured-fixture windows, `already_qualified` on managed events.

---

## PART 5 — The validator

`node src/validate/cli.ts <workbook> [--reference-date YYYY-MM-DD] [--json report.json]
[--known-issues …] [--sentinels …]`

Exit 1 on unsuppressed ERROR only. ERROR means publishing this would state something false;
WARN means incomplete but not wrong. That boundary matters more than rule count — a validator
that errors on incomplete data gets disabled within a week.

Rules live in `src/validate/rules/`. `normalise.ts`, `thresholds.ts`, `qualified.ts` and
`load.ts` are imported by **both** the app and the validator so they cannot drift.

Five harnesses: negative (every rule proven to fire, both directions), render (the component
executed against the real dataset), Qualified round-trip, eligibility-render, verdict probe.
Negative tests run against an empty suppression file — otherwise installing a real suppression
silently stops a test from proving anything.

**Suppression discipline:** `known-issues.json` entries need a note saying what would clear
them. Remove entries the moment they resolve; a stale suppression is worse than none.

---

## PART 6 — Calendar

| Date | What happens |
|---|---|
| **4–9 Aug 2026** | CONCACAF U-20 knockouts. **The final awards a men's football berth** — and if the USA win, it passes to the runner-up |
| **17–23 Aug 2026** | FIBA Women's Olympic Pre-Qualifying Tournament |
| **24 Aug – 1 Sep 2026** | FIBA WC qualifier Window 4; EuroBasket 2029 pre-qualifiers R2 opens |
| **4–13 Sep 2026** | FIBA Women's Basketball World Cup |
| **5–13 Oct 2026** | CAF Women's OQT Round 2 |
| **6 Oct / 9–17 Nov 2026** | UEFA U21 group stage closes, then play-offs |
| **23 Nov – 1 Dec 2026** | FIBA WC qualifier Window 5 |
| **27 Nov – 5 Dec 2026** | CONCACAF W Championship — 3 women's football berths |
| **31 Dec 2026** | **Men's cricket ranking window and both host tests close** |
| **22 Feb – 2 Mar 2027** | FIBA WC qualifier Window 6 |
| **1 Mar 2027** | Women's cricket ranking window closes |
| **Mar 2027** | FIBA ranking snapshot — the 7 ranking-based FOPQT places |
| **1 Apr 2028 / Apr 2028** | FIE rankings close, then fencing zonal events |

Re-check the IOC PDFs quarterly. Store the version date and diff the *rules*, not the text.

---

## PART 7 — Open items

**Structural, needs a source:**
- **FOPQT route arithmetic — narrowed to one team (2 Aug 2026), not resolved.** The 6/6/6/16
  = 34 table is **seat capacity**, filled by two disjoint sources: the tournament route (2R
  teams missing the 32-team World Cup — 28 by fixture derivation: Africa 7, Americas 5,
  Asia 4, Europe 12; WC allocation 5/7/7/12 + host Qatar confirmed via olympics.com) plus the
  7 ranking places, which occupy seats **inside** the 34. The earlier "the 7 are additive on
  top of the table — that much is settled" is reversed: the 7 come from outside the route
  *pool* but sit inside the *seats* (umbrella notes, bkb-041–045). FIBA's document states 27
  route entrants, and 27 + 7 = 34 exactly. The surviving question is the one-team difference,
  localised to Africa: 7 route candidates for 6 seats. Verify the Africa FOPQT entry rule —
  all seven 2R non-qualifiers, or a classified subset. The umbrella's "34 teams" format
  string is correct as a seat count; leave it. Related: a global top-7 cut and fixed 6/6/6/16
  fields cannot both be strictly true — AMBIGUOUS note on `fiba-m-fopqt-7`.
- CAF W OQT R1: Madagascar and Mauritius won 2–1 and 3–1 on aggregate, but their opponents
  (South Sudan / Djibouti, in some order) and leg scores are unsourced.
- AFC Women's Asian Cup semi-final pairings — which of China / South Korea each of Japan and
  Australia beat.
- Cricket host test: **three** published readings, one of them from the ICC contradicting
  another ICC page. Recorded on `icc-m-host-top15`. The USA men at 13th satisfy the likeliest
  two. Blast radius is the host place only — the FOGQT cut stays at Ireland/12 either way.

*(Closed 2 Aug 2026: Africa's WC qualifier Window 5. FIBA confirms Africa plays tournament
format rather than home-and-away windows, so the Aug-2026/Feb-2027 blocks are correct as
entered. Recorded on the competition's notes.)*

**Known blind spots:**
- **`eligibility_note` conditionals.** Eight links carry rules there that `criterion` does not
  state: `fbl-005` (USA-wins pass-down), `fbl-012` (semi-finalist substitution), `bkb-001`
  (FIBA Central Board host decision), `bkb-027` (champion-is-host), `bkb-032`–`bkb-035` (FWOQT
  regional reductions). `fbl-005`'s criterion contradicted its own eligibility_note for weeks.
  The Pathway view now renders the field, but **read all eight before touching basketball or
  football.**
- **Host-place conditionals can't appear in Pathway traces at all.** A link sourced at
  `HOST_USA` or `TRIPARTITE` sits on an allocation node no route passes through. `bkb-001` is
  visible only in the event cascade. Don't conclude it's missing.
- **Placement verdicts (closed 2 Aug 2026, tier 3 still open).** The verdict system now covers
  placement fixtures: `src/lib/placement.ts` (shared) derives structural tier-1/2 verdicts —
  berth distance and stakes — from the link graph and stage labels, consuming no results and
  no standings. All rule text is quoted verbatim, never paraphrased, so conditional recipients
  (fbl-005) surface through the quotes. Rankings are not traversed. Dead-rubber detection
  (tier 3, the only tier that consumes results) remains deferred — see the status block in
  `docs/placement-verdict.md`.
- **Stage four: steps 1–4 shipped 3 Aug 2026.** Emit (`tools/emit-data.mjs`), app fetch
  branch, CI skeleton (`tools/pull-workbook.mjs` → `tools/pull-gate.mjs` →
  `tools/ci-publish.mjs`, `.github/workflows/publish.yml`), and the provenance strip + audit
  artefact block — all harness-proven (`test/data-roundtrip.mjs`, `test/bundle-invariant.mjs`,
  `test/ci-gate.mjs`, `test/render-app.mjs`). Still open: **no CI has ever run** (the two
  secrets are not provisioned), and **archive durability** — the recommendation (dedicated
  `archive` branch via a separate `contents: write` job, main branch-protected) is recorded
  in `docs/stage-four.md` §4 and awaits a decision; until then archives and the gate baseline
  ride the evictable actions cache.
- **toStamp single-digit hours (fixed 3 Aug 2026).** Until then the app's date parser dropped
  the time of every fixture with an hour 0–9 (47 rows — the cricket 00:30s and Africa-window
  08:00s), rendering "no time recorded"; `docs/timezones.md` records why that invites re-entry
  in the wrong zone. The stamp format is now asserted padded in `test/data-roundtrip.mjs`,
  which also anchors every datetime cell on its raw Excel serial (numFmt bypassed).
- **Timezones: option B adopted and implemented 3 Aug 2026 (workbook v20; provenance marked
  v21).** `Fixtures.tz` declares the zone of the stored local time; only the twelve FWOPQT
  group games are populated, and their `America/New_York` is a MARKED INFERENCE (`tz_source`,
  v21): derived from a -4h offset against FIBA's displayed listing whose display zone is
  unconfirmed, supported by the Guadalajara venue cross-check — replace or confirm when the
  organiser's local-time listing is sourced. Convention (README): `tz_source` is a REQUIRED
  enum whenever tz is filled — leading RESEARCHED or DERIVED (stage_source's vocabulary),
  DERIVED with its premise (`state/tz-*` rules, ERROR); and tz may never change without
  tz_source in the same edit — diff-workbooks and the pull gate both refuse it (tz coupling,
  `tools/wbdiff.mjs`).
  `coverage/tz-undeclared` WARNs aggregate on the 137 timed rows still blank — populate from
  sources, NEVER convert stored times. The app shows "zone?" on undeclared times by design.

**Product decisions not yet made:**
- Timezone. `docs/timezones.md` recommends local time plus a lazily-populated tz column
  (transcription over conversion — conversion is where a real 5-vs-6 August error came from).
- Per-ranking staleness. The global 30-day clock is too tight for FIBA (quarterly snapshots:
  15 Sep 2025, 2 Dec 2025, 3 Mar 2026, 13 Jul 2026) and arguably too loose for cricket.
- Stage four: Sheets pull → validator in CI → versioned `data.json` → static site. Untouched.
  The validator is already CI-shaped.

---

## PART 8 — Failure modes that keep recurring

Every one shipped at least once. Read before touching the code.

1. **Reasoning from what you already believe instead of re-checking.** Three times in one
   session: Africa "missing a window" (the round-robin was complete, and the fixture count was
   in hand); 45 fixtures misattributed to the wrong competitions; a 34-vs-28 reconciliation
   asserted without noticing both numbers were already available. The tell is a confident
   synthesis that never recomputes.
2. **Prose overwriting structured data.** A prior session's research summary was pasted into
   eight rows and later applied over fixture-backed values. When an instruction's premise turns
   out to be wrong, stop and ask — don't resolve it by preferring the prose.
3. **A field doing two jobs.** `start_date` meaning both "competition start" and "start of
   captured fixtures"; `qualified_via` meaning both derived and hand-typed. If two things need
   saying, two fields say them.
4. **Inferring a relationship instead of declaring it.** Matching cut-lines by `leads_to` picked
   the wrong one of three. Global symmetric aliases for directional, sport-scoped facts.
5. **Applying a rule to entities it doesn't govern.** Scope rules to who they actually bind.
6. **Hardcoded assumptions in derived maths.** A continent list; a threshold formula assuming
   "four teams already qualified". Drive it from the data.
7. **Marking something settled that isn't.** Provisional holders are not `already_qualified`.
8. **Computing over an empty basis.** A cut-line with no exclusion set silently handed seven
   places to the wrong teams. Fail closed.
9. **Graph traversal ignoring real-world constraints.** Region gating depends on
   `confederation` being populated.
10. **A string replacement matching in two places.** Count matches before applying.
11. **Parse-checking instead of render-checking.** Babel accepting the JSX proves nothing.
12. **Stating a rule correctly while omitting where the team in front of you stands.** "8
    advance" is true and useless when the team is 6th and the cut is 14th.
13. **Test infrastructure inheriting production config.** Negative tests running through the
    real suppression file stopped proving what they claimed to prove.
14. **The search tool silently scoping itself.** Session shells alias grep to ugrep with
    --ignore-files: a recursive search launched at the repo root reads .gitignore during
    traversal and skips every ignored path, so a "full-tree" scan returned zero on 74 files
    that contained the pattern. The trap is asymmetric — explicitly-named files are always
    searched, and recursion started inside a subdirectory (no .gitignore on the way down)
    is not scoped — so spot-checks pass while the whole-tree claim silently fails. Any
    verification-grade search uses /usr/bin/grep explicitly (README, "Verification searches").
