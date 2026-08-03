# Options note: fixture times and timezones

*Status: DECIDED — option B, applied lazily, implemented 3 Aug 2026 (workbook
v20). `Fixtures.tz` (IANA name) declares which zone the stored LOCAL time is
in; populated only from sources (the twelve FWOPQT group games, verified
Eastern → `America/New_York`); no stored time was converted. The app renders
declared zones as a short name ("22:30 EDT"), undeclared real times as
"22:30 zone?" — a bare kickoff time no longer exists in the UI — and no-time
rows stay "TBC". The validator WARNs, aggregate, on timed rows with blank tz
(`coverage/tz-undeclared` — incomplete, not false) and per-row on zones Intl
rejects (`coverage/tz-invalid` — a typo'd zone claims precision the data
doesn't have). Originally written 2 Aug 2026 after the first non-cosmetic
failure: a 5 Aug evening kickoff (CONCACAF U-20 QF) entered as 6 Aug because
a source rendered it in UTC — a wrong DATE, not a wrong hour, which shifted
the fixture across a day boundary and misdated the bracket.*

## The problem

`Fixtures.date` stores "exactly as entered with no zone" (handoff PART 7). A
zoneless timestamp is ambiguous the moment two sources render the same kickoff
in different zones. Every rule keyed on dates (past-fixture detection, window
membership, status/window consistency) reads the stored day, so a zone slip
becomes a data error, not a display quirk.

## Options

**A. Store UTC + a display offset column.**
Unambiguous and sortable; comparisons need no zone database. But entry
requires converting every source time to UTC by hand (error-prone — the exact
mistake that just happened, in reverse), and the stored day often differs from
the local match day, which is what fans, schedules and sources all use.

**B. Store local time + an IANA zone column (e.g. `America/Port_of_Spain`).**
Matches how every source publishes kickoffs, so entry is transcription, not
conversion. Correct UTC is derivable when needed. Cost: a zone column to
populate per venue, and any consumer doing cross-zone comparison needs a zone
library (the app currently does none — its comparisons are all date-level).

**C. Date-only for anything that is not a live fixture; local time + zone
only where hours matter.**
Recognises that the database's actual queries are date-level: windows,
past/future, staleness. Hours exist today mostly as decoration ("21:00" on a
group game changes no rule outcome). Smallest change; defers the zone
question until something genuinely consumes kickoff hours (e.g. a "today's
matches" view).

## Worked case: FWOPQT group fixtures (added 2 Aug 2026)

The 12 group games of `2026-fiba-women-s-olympic-pre-qualifying-tournament`
(17–23 Aug 2026) are stored with times running **exactly four hours behind
FIBA's published listing, consistently, with no date rollovers** — the
offset pattern of US Eastern daylight time against a UTC display. Nothing in
the sheet declares which zone the stored times are in; a reader comparing
the sheet against FIBA's site sees every kickoff "wrong" by four hours and
has no way to tell transcription error from zone convention.

Why this matters for the options above: the stored times are internally
consistent and match *some* single zone — exactly the situation option B
formalises with one `tz` cell per venue, and exactly the situation option A
would have forced twelve hand-conversions on (the error class that produced
the 5-vs-6 August CONCACAF mistake). No rule outcome currently depends on
these hours (no rollover crosses a date boundary), so this is evidence, not
an incident — but the same four-hour offset applied to a 01:00 UTC kickoff
would shift the stored *day*, and that is a data error. Recorded here as the
concrete case for adopting B before one lands.

## Rendering incident: stored times invisible until 3 Aug 2026

Until the toStamp fix of 3 Aug 2026, the app's date parser required a
two-digit hour while the loader renders single-digit hours unpadded
("2026-08-27 8:00:00"), so **47 stored kickoff times — every fixture with an
hour of 0–9 — displayed as "no time recorded"**. These 47 are precisely the
times the timezone decision rests on: the 00:30 cricket starts, the
08:00/08:30 Africa-window games, the FWOPQT early slots. The hazard is not
display: a time shown as absent invites being refilled from a source
rendering the kickoff in another zone — the 5-vs-6 August failure re-entering
through the UI instead of through entry. The stored values were always intact
(both data paths dropped them identically); the round-trip harness now
asserts every derived stamp is a padded `YYYY-MM-DD HH:MM` so a parser/format
mismatch of this shape cannot silently return.

**B, applied lazily: add a `tz` column now, populate it only for rows where
the time is load-bearing, and treat time-less dates as local match days.**
Rationale: A converts at entry time, which is where this failure happened; C
is where the sheet already de facto is, but codifying "date-only" discards
hours already captured and makes a future live view need re-sourcing. B keeps
entry as transcription (the least error-prone act), makes every stored day
the local match day (matching sources, so discrepancies like 5-vs-6 Aug are
visible at entry instead of latent), and costs nothing until a consumer needs
real instants. The validator gains a cheap rule when adopted: a fixture with
an hour but no tz on a competition whose venue spans zones → WARN.
