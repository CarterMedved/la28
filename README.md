# LA28 Qualification Validator

The gate between the workbook and anything published. Reads
`LA28_Qualification_Database.xlsx`, reports whether it is fit to publish.
Exit 1 only on unsuppressed ERROR; WARN and INFO never block.

**Canonical source (after cutover — docs/provisioning.md):** once the
Google Sheet exists, THE SHEET is the workbook; every data change is made
there and reaches the site only through pull → gate → validator →
publish. `data/*.xlsx` here is history: the v5–v21 lineage + edit scripts
are the provenance record, and the unversioned file is the harnesses'
pinned fixture. Editing a repo workbook changes nothing on the site.
During an outage there is no local publish path by design — stage a local
edit pass with the usual diff-proof, then apply the same edit to the
Sheet when service returns.

```
node src/validate/cli.ts data/LA28_Qualification_Database.xlsx \
  [--reference-date YYYY-MM-DD]      # the clock for every time-dependent rule (default: today)
  [--json report.json]               # machine-readable report for CI
  [--known-issues known-issues.json] # suppressions by stable key; every entry needs a note
  [--sentinels sentinels.json]       # non-competition berth sources (HOST_USA, TRIPARTITE)
```

Shared modules — the app imports these too, so validator and app cannot drift:

- `src/lib/normalise.ts` — `teamKey` + `ALIAS` (squad names ↔ nation names)
- `src/lib/thresholds.ts` — cut-line threshold computation
- `src/lib/qualified.ts` — settled-berth derivation (see below)
- `src/lib/load.ts` — workbook → typed dataset, nan-coercion at the boundary

**Verification searches — read before claiming "repo-wide grep found
nothing":** agent-session shells alias `grep` to ugrep with
`--ignore-files`, which silently skips every `.gitignore`d path during
recursive search — including `test/mutants/` and `test/.build/`, where the
harness fixtures live. A post-rename "no stale references" check run with
the default grep would skip exactly the fixtures pinning the old name and
report clean (this happened: a full-tree scan for personal paths returned
zero on 3 Aug 2026 while 74 ignored files contained them). Any
verification claim must use the real binary explicitly:

```
/usr/bin/grep -rn --exclude-dir=node_modules --exclude-dir=.git <pattern> .
```

Tests (all must pass before trusting a change):

- `node test/render-app.mjs` — renders the real app against the real workbook
- `node test/negative.mjs` — every rule proven to fire on a mutated copy
- `node test/qualified-roundtrip.mjs` — Qualified derivation moves no cut-line
- `node test/data-roundtrip.mjs` — the data.json path and the workbook path
  produce identical app outcomes (stage-four anti-fork; in CI it runs
  between emit and publish against the pulled workbook)
- `node test/bundle-invariant.mjs` — "no data compiled into the app",
  both directions: the real bundle carries no sentinel, and a deliberate
  tree-shaken `import { data }` violation leaks it and is caught
- `node test/ci-gate.mjs` — the pull gate (stage-four step 3): routine
  changes flow, gated changes block without an ack in `pull-acks.json`,
  acks match on old+new values only, deletions gated on every tab, and
  the pull fails closed without credentials

## Sheet conventions (paste-ready for the workbook's README tab)

> **The counted order** (defined term — use it wherever prose describes a
> field-setting ranking): a ranking's rows with `olympic_eligible = Y` OR
> `counts_in_field = Y`, in rank order. This is the set the code uses
> (src/lib/thresholds.ts). The two POOLED rules (NEXT_N_NOT_QUALIFIED,
> TOP_N_OF_POOL) then remove, with one identical filter, two states that
> are NOT the same thing: already-qualified teams (settled — no line
> anywhere contests them) and the provisional holder (out of pools it
> sits above, but still LIVE — a PROVISIONAL_HOLDER cut-line targets
> exactly that team and its hold stays contested until the deadline;
> HANDOFF PART 3). RANK_AT_OR_ABOVE and TOP_PER_NAMED_CONTINENT remove
> neither.
> `counts_in_field` is an OVERRIDE that adds a team which cannot hold a
> place — never a selector: on its own it matches exactly one team (West
> Indies), so a one-column definition is wrong in either direction.
> Discriminating test, chosen so a wrong definition FAILS it: Pakistan
> (eligible, no override) is in via eligibility — any definition that
> drops it is wrong; West Indies (ineligible, override) is in via the
> override; Scotland (ineligible, no override) is out on both. NB the
> continental-places route uses plain `olympic_eligible = Y` WITHOUT the
> override — West Indies counts toward a field but never toward the
> continental allocation (thresholds.ts splits these).

> **Contention bands** (app policy, `CONTENTION` in qualification-app.jsx):
> a team is "in contention" within 25 rating points of a line, or 3 places
> where no rating exists; beyond that the card says "too far back".
> 25 is a CHOSEN coarse number, not a derived one. Its entire evidence
> base: five margins, three rankings, one sport (cricket T20I), one date
> (3 Aug 2026) — 3, 3, 11 and 19 were treated as live, 39 as settled — plus
> the same 25 used as the continental-contention precedent in
> fixtureVerdict. Those five readings came from prose judgments the Aug
> 2026 sweep then DELETED because typed judgments go stale, so they cannot
> justify the threshold — they only locate where one observer once drew it.
> UNTESTED for fencing, football, basketball and every unmapped sport;
> rating scales differ by sport, so 25 may be meaningless elsewhere.
> Evidence that would justify changing it: captured rating-volatility
> history (how far teams actually move between table snapshots), or a
> per-sport scale statement from the source — either arriving makes the
> band per-ranking, not global. Never adjust it by feel: a number that
> looks derived is worse than one that admits it was chosen.

> **Links.condition_trigger / condition_recipient** (structured conditional
> recipients — the fbl-005 class): when a berth edge's recipient depends on
> a condition, these two columns state it structurally so the card sentence
> renders it without parsing prose. Vocabulary the code knows
> (`conditionState` in qualification-app.jsx): triggers `HOST_WINS`,
> `HOST_IN_SEMIS`; recipients `RUNNER_UP`, `NEXT_ELIGIBLE`,
> `OTHER_SEMIFINALISTS` (deliberately non-definite — the draw decides, so
> it renders the marker form even when filled). FAIL-CLOSED: blank,
> half-filled or unrecognised values render "who receives it is
> conditional", never a flattened sentence — the rule itself renders on
> the conditional step, inline or opening in place (INLINE_RULE_MAX); the
> unconditional sentence is reachable only when eligibility_note,
> entry_condition and conditional-shaped criterion language are ALL absent
> and both columns are blank (test/sentence.mjs pins every state). Grow
> the enum in code first, then use the value in the Sheet — an untaught
> value degrades safely but says less than it could.
> TWO prose guards with opposite fail directions, because the two errors
> differ: the FLATTEN guard is aggressive (any prose blocks the
> unconditional sentence — under-detection would flatten a conditional);
> the LABEL guard is anchored (CONDITIONAL:, NOT GUARANTEED, NOT
> automatic, Only (live) if, Reduced by N if, sentence-initial If —
> over-detection would falsely assert "this can change" about a
> descriptive note, the fbl-013 class). Prose that is present but not
> asserting renders QUIET: no unconditional sentence, no condition label,
> the note quoted verbatim in the sheet-text layer. A bare mid-sentence
> "if" never asserts — explanatory prose uses it too (bkb-002).
> **Condition TYPE is a fact of the edge, not a reading of its note**:
> `berths` and `qualifiers` partition the Links tab (no row fills both), so
> a condition on a `qualifiers` edge is a ROUTE condition (how many, or
> which, advance through the step — bkb-032–035, cri-004/009) and a
> condition on a `berths` edge is a RECIPIENT condition (who receives the
> place — fbl-005, fbl-012, bkb-001, bkb-027/028). The card's "How it
> works" derives its label from those columns; ADVANCE rows with neither
> filled get the untyped "a condition applies" line because the graph
> cannot prove the type.

> **start_date / end_date** — always the competition's *true* start and end,
> from the official schedule, even when earlier rounds' fixtures aren't
> captured in Fixtures. The start of the captured segment is never stored: it
> is derivable as the earliest fixture date, and the validator warns when
> stored dates and fixtures disagree (`fixtures-before-start`,
> `missing-earlier-rounds`). If only later rounds are captured, say so in
> `notes`.

> **Qualified** — the single source for settled berths, for any sport, ranking
> or not. Columns: `olympic_event_id · team · qualified_via (competition_id) ·
> date · confidence · notes`. `team` is the NOC (Great Britain, not England —
> note why in `notes`). Once an event has any Qualified row, the loader
> derives `Standings.already_qualified` and `.qualified_via` from this tab for
> every ranking feeding that event, and stored values in those Standings
> columns are dead cells the validator flags. Do not store both.

> **Ranking_Systems.next_refresh_expected** — the date past which the
> *absence* of a standings refresh is suspicious, NOT the date the source
> will publish (sources publish event anchors, not dates — the value is
> anchor + observed-lag margin, derivation recorded in `decay_notes`); blank
> means the global 30-day clock applies.

> **Fixtures.tz** — the IANA zone (e.g. `America/New_York`) that the stored
> kickoff time is in. A declaration, never a conversion: stored times are
> transcribed exactly as each row's ENTRY SOURCE displayed them and must not
> be shifted. **They are NOT venue-local match times** (measured 3 Aug 2026:
> every timed row is consistent with US Eastern — the sources were US-facing
> listings, cf. the Willow/Fubo/Sling broadcast column — and several are
> impossible as venue-local, e.g. a Colombo match stored 00:30, Asian Games
> in Japan stored 01:00). The pattern is not per-row proof: blank tz means
> "zone UNVERIFIED for this row" and the validator WARNs on timed rows
> (`coverage/tz-undeclared`) while the app shows "zone?" so a bare time can
> never be mistaken for a zone the viewer assumes. Populate lazily, only
> from sources, where the time is load-bearing.
> **tz_source is REQUIRED whenever tz is filled** (`state/tz-unsourced`,
> ERROR — an unsourced zone is unauditable, indistinguishable from a
> guess). It leads with stage_source's enum: `RESEARCHED` (the organiser's
> published local-time schedule was read — cite it) or `DERIVED` (inferred
> from offset arithmetic, venue geography, anything short of the schedule
> — with the premise stated in the same cell; a bare DERIVED is rejected,
> `state/tz-source-invalid`). Blank tz with blank tz_source is silent: no
> value, nothing to source. **A tz value may never change without
> tz_source being re-established in the same edit** — the local diff pass
> and the CI pull gate both refuse the change outright (tz coupling,
> `tools/wbdiff.mjs`), so a stale marker cannot attach to a value it was
> never written about. tz_source changing alone is the legitimate
> DERIVED→RESEARCHED confirm flow.

> **Standings.represents_noc** — set when a ranked team holds a berth on
> behalf of a different NOC (England → Great Britain in both ICC tables).
> Directional and per-row: the Qualified join matches on `team` OR
> `represents_noc`, so a Qualified row naming Great Britain reaches England's
> standings row without teaching the global name normaliser that GB and
> England are the same team — in football they are not. Leave blank for
> Scotland (already `olympic_eligible = N`) and West Indies (no NOC; the
> Caribbean Qualifier exists precisely because of that).

## FIBA terminology (adopt before any standings land)

The handoff's PART 7 arithmetic never reconciled because one phrase — "the
FOPQT pool" — was covering two disjoint sets. The fixture data (eurobasket-2029
pre-qualifiers 2R roster vs WC-Europe 2R roster: zero overlap) separates them.
Use these names everywhere; never "the FOPQT pool" unqualified:

- **FOPQT tournament route** — teams that reached the World Cup qualifiers'
  second round but miss the 32-team World Cup: 28 across the four regions
  (Africa 7, Americas 5, Asia 4, Europe 12 — 60 distinct second-round teams
  against the 32-team field, which includes host Qatar; WC allocation
  Africa 5, Americas 7, Asia 7, Europe 12 confirmed via olympics.com).
  They enter the regional FOPQTs by right. FIBA's document states 27 route
  entrants, which closes the 34 seats exactly (27 + 7); the one-team
  difference is African — see the ARITHMETIC GAP note on bkb-013/016/019.
- **FOPQT ranking pool** — teams that did NOT reach the second round,
  contesting the 7 places awarded on the March 2027 FIBA ranking
  (cut-line fiba-m-fopqt-7, TOP_N_OF_POOL). In Europe this is the 8
  first-round-eliminated teams plus the 4 pre-qualifier R1 entrants who were
  never in the WC qualifiers at all.

A team is in exactly one of these. The 6/6/6/16 regional table is **seat
capacity** (34 seats), filled by both sources — route entrants plus the 7
ranking places, which occupy seats inside the 34, not on top of it. The
ranking pool is derived from second-round fixture non-participation (see
pool-preview in the validator).

**Pool feeders are structural, not regex-selected** (`poolFeeders`,
`src/lib/thresholds.ts`, shared by app, exclusion derivation and
pool-preview): the cut's `leads_to` fans out to the regional FOPQTs, and the
links *into* those targets carrying an `entry_condition` name the qualifying
competitions — currently bkb-013/016/019/022, i.e. the four WC qualifiers.
The old derivation keyed on RANKING_POINTS ("plays for ranking points"),
which the EuroBasket pre-qualifiers also do, and their "Pre-qualifiers
second round" stage then excluded the exact twelve teams the ranking pool
consists of. The `/second round/i` stage match survives **only inside the
declared feeders** — it is the pool's literal definition ("did not reach the
second round"), not a competition selector. Do not widen it back out.

*Correction note (2 Aug 2026): a previous revision of this section gave the
route split as "Africa 6, Americas 6, Asia 6, Europe 12" — which does not sum
to 28 and matches no single derivation. It is consistent with reading the
pool-preview's per-FOPQT lines (12 minus each 6-seat field) for three regions
and the World Cup subtraction (24 − 12) for Europe — two different
subtractions mixed. The original handoff's split was correct; treat that
revision as a transcription corruption, not a source disagreement.*
