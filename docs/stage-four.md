# Design note: stage four — Sheets pull → validator in CI → versioned data.json → static site

*Status: steps 1–4 implemented (3 Aug 2026) — emit + round-trip harness
(now carrying the silent-time-loss relation guard, active in CI mode); app
fetch branch + bundle invariant; CI skeleton (`tools/pull-workbook.mjs`
with per-run reach logging, `tools/pull-gate.mjs`, `tools/ci-publish.mjs`,
`.github/workflows/publish.yml`, proven by `test/ci-gate.mjs`); provenance
strip + audit artefact block (proven in `test/render-app.mjs`). Repo is
PUBLIC on GitHub (CarterMedved/la28, decision 3 Aug 2026 — see PLAN
BOUNDARY in §2); archive job built 3 Aug 2026 (two-job split in
`publish.yml.disabled`, branch-baseline preference in `ci-publish.mjs`,
proven in `test/ci-gate.mjs`). OPEN: provisioning and the first real
run — runbook with BLOCKING Sheets preflight in `docs/provisioning.md`;
the workflow stays `.disabled` until deliberately renamed; no CI has ever
run.*

## 1. The invariant that must survive

**"No data compiled into the app" distinguishes two things that look alike:**
`data.json` **fetched at runtime** keeps the founding decision — the bundle
is pure logic, the data arrives as data, and editing the sheet changes the
site without a rebuild. `data.json` **imported at build time** breaks it —
the dataset is baked into the bundle, and the app has data compiled in with
extra steps.

What enforces it (not memory):

- **Bundle sentinel test — sentinel keyed to the payload, not the meta.**
  A meta-level sentinel is tree-shakeable: bundlers support named imports
  from JSON with top-level-key shaking, so `import { data } from
  "./data.json"` drops `meta` (and its sentinel, and the version label)
  while compiling the entire payload in — the exact violation, passing the
  naive test. Therefore the sentinel lives **inside the data block**:
  `data._sentinel = "LA28-DATA-MUST-NOT-BE-BUNDLED"`. Top-level shaking
  cannot separate a key from within the `data` object, so any import that
  carries the payload carries the sentinel; `normalise()` reads known tab
  keys and ignores `_sentinel` (proven in the round-trip harness).
  `meta.runtime_fetch_only` stays as human documentation only — the test
  keys on `data._sentinel`. The harness must prove BOTH directions: the
  real app bundle contains no sentinel, and a deliberate violation fixture
  that does `import { data }` (meta-less, tree-shaken) DOES leak the
  sentinel into its bundle — i.e. the detector is proven against the
  disguised import, not just the whole-file one.
- **Import lint.** The same harness greps the app source for any import
  path matching `data.json` / the artefact directory. Cheap, zero false
  positives, catches the mistake before the bundle test does.
- **File-location convention.** data.json lives in the published artefact
  tree (`site/data/`), never under `src/` — conventions don't hold on their
  own, which is why the two tests above exist, but the location makes the
  wrong import look wrong in review.

## 2. The pull

- **Where the workbook lives:** Google Sheets becomes the editing surface;
  CI pulls the xlsx export of a pinned spreadsheet ID (service account, no
  interactive auth). The pulled bytes are hashed (sha256) and archived per
  run.
- **Failed pull publishes nothing.** The last good data.json stands. Same
  for pull-succeeded-but-gate-failed: the publish step only replaces the
  artefact after the full chain succeeds. Agreed with the framing — with
  one refinement below on what the site displays.
- **Idempotence — corrected, it contradicted the gate as first written.**
  Skip-on-unchanged-workbook-hash alone means a run whose advancing
  reference date turns a SCHEDULED competition into an ERROR never reaches
  the site, which keeps serving `fit_to_publish: true` from an older run.
  **Publish is skipped only when the workbook CONTENT hash AND the
  validator summary are both unchanged** — and "summary unchanged" means
  **the rules map compares equal** (`{rule_key: count}`, deep), never the
  E/W/I totals: 9 WARN → 9 WARN with one key cleared and another appeared
  is a composition change and must publish. Same reasoning that made the
  composition delta the reporting signal — totals are noise, keys are
  signal. (The summary also moves when validator code or suppressions
  change — same workbook, same date, different verdict must publish.)
  **DUAL-HASH (measured 3 Aug 2026, implemented same day):** Google's
  xlsx export is byte-UNSTABLE on unchanged content — two exports of an
  untouched Sheet differed in sha256 and size (120,570 vs 120,615 bytes)
  with zero differing cells — so raw-bytes identity would republish daily
  and write a pointless archive commit every run. `content_sha256`
  (sha256 of the normalised data block, exactly what data.json carries)
  drives the SKIP decision, the ARCHIVE KEY and the BOOTSTRAP digest;
  `workbook_sha256` (raw bytes) keeps its one job, the baseline INTEGRITY
  check, whose two sides come from the same stored bytes at seed time and
  never cross an export boundary. Proven in `test/ci-gate.mjs` against a
  genuine byte-variant container.
  Consequence for the archive key: it is a digest of
  `sha256(content_sha + reference_date + rules_map_json)`, truncated.
  **Precisely stated:** the key is unique per published artefact — it is
  NOT the skip condition. The skip condition compares workbook + rules
  map against the *last published* run and ignores reference_date; the
  key includes reference_date so that when the same workbook+summary
  publishes on a later date (because the composition changed and then
  changed back, or after a code change), the archive keeps both. A key
  that "collides exactly when skip fires" was a nice sentence and a false
  one — skip prevents the second write, so published keys simply never
  collide in practice, and the reference_date component makes that true
  by construction rather than by luck.
- **The diff has teeth, not just a log.** Enumerating changes into a report
  is observability; the old control *failed the run* when observed ≠
  declared, and enumeration fails at nothing. Replacement control, split by
  what history says is dangerous:
  - **Routine, flows through:** Standings, Fixtures, Qualified — data
    refreshes. Plus, within Competitions, the operational columns:
    `start_date`, `end_date`, `date_confidence`, `status`, `notes` (dates
    firm up, statuses flip as windows pass, notes are prose that
    precedence rules already subordinate).
  - **Gated, requires acknowledgment:** Links, Cut_Lines, Olympic_Events,
    Ranking_Systems in full — and Competitions' rule-adjacent columns
    (`format`, `confederation`, `teams_count`, and any column addition).
    Every multi-week error in PART 8 came from these; `confederation`
    silently reroutes graph traversal, `teams_count` now feeds preview
    arithmetic. So: the tab-level split is *slightly wrong* — Competitions
    is genuinely mixed and the diff is already column-keyed, so the split
    goes to column grain there and stays tab-grain everywhere else.
  - **Row deletions are gated on EVERY tab, including the routine ones.**
    The edit/addition split reasons about what a change *states*; a
    deletion removes *evidence*, and absence is invisible to most rules
    except where fail-closed was specifically engineered. Concretely:
    deleting second-round Fixtures rows silently empties the
    TOP_N_OF_POOL derivation basis (negative.mjs proves the blast radius
    by doing exactly that to block fiba-m-fopqt-7); deleting Standings
    rows moves captured depth, and icc-m-host-top15 sits at zero headroom
    today; deleting a Qualified row un-settles a berth. Additions on
    routine tabs stay flow-through, and the asymmetry is principled, not
    lenient: an added row is *validated presence* — referential rules,
    berth sums, duplicate checks, the round-trip harness all see it — but
    a deleted row is *unvalidated absence*; no rule can inspect what is no
    longer there. (Additions on gated tabs are already gated — a new
    Links row IS a rule change.)
  - **Mechanism (lightest that cannot complete on its own):** an
    **acknowledgment file in the repo, keyed by content digest**. CI
    computes the pull diff; if any gated change exists, it digests the
    sorted gated-change signatures — **sheet·key·col·kind + OLD value +
    new value** — to a sha256 and looks it up in `pull-acks.json`. The old
    value is part of the signature deliberately: with new-value-only, a
    cell going A→B (acked) and later C→B produces the same digest and the
    C→B change rides the A→B ack. With old+new, only the literal
    re-application of an already-reviewed transition (A→B, reverted, A→B
    again) can ever match — rare, and visible because the run report names
    which ack matched. Absent digest → the publish step fails, printing
    the digest and the enumerated gated changes; a human reviews, commits
    the digest with a one-line note and date, and the next run publishes.
    **Acks persist** (append-only; consuming them would require CI to
    write commits back to the repo — machinery and credentials this
    design avoids). **No expiry**: with old-values in the digest, expiry
    would only guard the reviewed-transition-replay case above, which the
    matched-ack line in the report already surfaces; an expiring ack adds
    a recurring human chore to re-approve changes nobody made. This is
    the old discipline inverted: intent was declared before; content is
    acknowledged after — same property, the run fails until a human has
    seen the rule change. (Platform approval gates approve a *run*, not a
    *change-set*, which is why they're not enough.)

## 3. The gate

- Validator runs in CI with `--reference-date <run date>`, known-issues and
  sentinels from the repo. **Exit 1 on unsuppressed ERROR only — the
  existing boundary, unchanged. WARN never fails a build.**
- WARN counts drift by themselves as the reference date advances
  (past-fixtures-no-result grows every time a captured fixture passes
  without a result; a SCHEDULED competition whose window passes becomes a
  *legitimate* new ERROR — that block is the system working, not flaking).
  **No CI check may pin a WARN count.**
- How the run is reported without being gated on: (a) the full report.json
  is a CI artefact of every run; (b) the validator summary is embedded in
  data.json meta (see §4) so the site's audit view can show it; (c) a
  non-gating step reports the WARN **composition delta** versus the
  previous published run — rule keys that appeared or cleared, never
  counts. New-key appearance is signal; count drift is noise.

## 4. The artefact

data.json carries **cleaned rows, not derived values.** Derivation
(thresholds, verdicts, already_qualified, placement) stays at runtime in the
shared modules — PART 4's "never type" list is also a "never publish as
data" list, or the site would ship stored copies of computed claims.

```
{
  "meta": {
    "schema_version": 1,
    "generated_at":   "<ISO instant of the run>",
    "reference_date": "<validator clock>",
    "runtime_fetch_only": "documentation only — the tested sentinel is data._sentinel",
    "workbook": { "spreadsheet_id": "…", "sha256": "…", "version_label": "v19",
                  "pulled_at": "<ISO>" },
    "validator": { "error": 0, "warn": 9, "info": 2, "suppressed": 0,
                   "fit_to_publish": true, "rules": { "<key>": <count>, … } }
  },
  "data": { "_sentinel": "LA28-DATA-MUST-NOT-BE-BUNDLED",
            "events": […], "comps": […], "links": […], "rank": […],
            "standings": […], "cuts": […], "fixtures": […], "qualified": […] }
}
```

**fit_to_publish** is only meaningful because failed runs are archived too:
a gate-failing run archives its meta + report (no data block) under the
same key scheme, so the archive corpus contains both values and the field
distinguishes them. In the LIVE artefact it is an assertion, not
information — the publisher refuses to write a live file carrying `false`,
and a consumer may treat `fit_to_publish !== true` in the live file as
corruption. Kept, with that semantics stated; dropping it would leave
archived failures indistinguishable from successes without re-reading the
embedded report.

**Publish is atomic**: the artefact is written to a temp path on the same
filesystem and renamed over `data/data.json` — a fetch can see the old
file or the new file, never a partial one. The archive copy is written
(and fsynced) before the rename, so the live pointer never leads the
archive.

**Archive durability (recommended 3 Aug 2026, NOT implemented — awaiting
pick):** the permissions model gives the archive nowhere durable to live:
`contents: read` can't commit, the Pages tree is replaced wholesale per
deploy, CI artifacts expire (≤90 days), and the actions cache is evictable
at any time. The same hole covers the GATE BASELINE: `.ci-state` rides the
cache, and an evicted cache silently re-runs "first run, no baseline" —
one unacked gated change could publish. Options weighed:
- *Carry the archive forward in each Pages deploy* — self-referential
  durability: every deploy must re-copy the whole set from the live site,
  and one deploy that fails to (bug, manifest 404) erases all history.
  Pages IS the thing being replaced; it can't also be the backup.
- *Separate store (S3/GCS, write-only key)* — genuinely durable and
  isolated, but a second credential + external infra + billing for a
  project whose model is one read-only SA and a repo.
- *Drop archiving* — guts fit_to_publish (§4: archived failures are what
  make it information rather than assertion).
- **APPROVED (3 Aug 2026): a dedicated `archive` branch, pushed by a
  SEPARATE job with per-job `permissions: contents: write`** (the publish
  job keeps `contents: read`). The branch carries `data/archive/*` (live +
  failed runs) AND the gate baseline (last-published workbook + meta),
  fixing both durability holes with one scoped credential. Costs, stated:
  (1) a repo-write token exists in CI for that job — its blast radius is
  every unprotected branch; (2) the ack design's "CI never writes to the
  repo" gains one exception — an append-only data branch the publish
  chain never reads (no self-influence loop; acks stay human-committed);
  (3) run history bloats the branch (small JSONs; the pulled xlsx stays a
  CI artefact, not a branch file).

  **Account setting warning (3 Aug 2026): do NOT suggest GitHub's "Block
  command line pushes that expose my email" for this project.** It is
  account-wide; the owner has six other private repos whose commits use
  the Gmail identity, and enabling it would fail their next push. Safe
  sequence if ever wanted: set repo-local noreply identity in every other
  repo first, then enable the block.

  **PLAN BOUNDARY — RESOLVED (3 Aug 2026): la28 is PUBLIC.** Rulesets and
  branch protection require a public repo or a paid plan on GitHub Free,
  and so does Pages — the boundary governed both halves of stage four.
  Decision: public (option a). **Pro was rejected because its security
  delta over public was zero** — identical ruleset semantics, and the
  "privacy" it bought was a source tree whose most sensitive contents the
  Pages site publishes anyway. Unlimited Actions minutes come free with
  public. Treat publication as irreversible: flipping back to private
  later does not unpublish cached/forked history.

  **PRECONDITION — verify before provisioning, not after:**
  `main` gets a ruleset with **block force pushes + restrict deletions
  only, bypass list empty. Required pull requests are deliberately OFF —
  do not reintroduce them as a "best practice."** Recorded why (4 Aug
  2026): this is a solo project whose commits are made locally with the
  agent; a PR requirement blocks every push for zero security gain,
  because the protection PRs would notionally provide against CI is
  already delivered by the publish job holding `contents: read` — it
  cannot push code regardless. The archive job's `contents: write` CAN
  push to main; force-push-blocking makes any such push a permanent,
  attributable commit, which is this design's tamper-evidence model on
  every branch. These are repo *settings*, invisible to every harness —
  a human must verify them on the repo's Rules page and re-verify if the
  repo is migrated or forked.

  **HARD CONSTRAINT — public repo + secrets (3 Aug 2026): any workflow
  that can read secrets uses ONLY `schedule` and `workflow_dispatch`
  triggers. NEVER `pull_request`, and NEVER `pull_request_target`.** On a
  public repo, a fork's pull request runs foreign code; `pull_request` on
  a secret-holding workflow (or `pull_request_target` anywhere near a
  checkout of PR code) hands the fork the service-account key. A future
  session adding a "convenient" trigger to publish.yml is the exact
  failure this paragraph exists to stop — the workflow file carries the
  same constraint in its own header comment, and any trigger change to a
  secret-holding workflow is a rule change requiring the same scrutiny
  as a gated workbook edit.

  Independent of the branch: **a missing baseline fails closed**
  (implemented 3 Aug 2026 in `tools/ci-publish.mjs`, proven both
  directions in `test/ci-gate.mjs`). No baseline — evicted cache,
  unreachable branch, genuine first run — exits non-zero and publishes
  nothing, printing the bootstrap recipe; a genuine first publish is an
  explicit acked bootstrap whose digest (`sha256("BOOTSTRAP·<content
  sha256>")`) authorises exactly that DATA — a byte-unstable re-export of
  unchanged content still matches; any data change does not. The archive
  branch is therefore a durability improvement, not the thing holding
  the invariant up.

  **NO FORMULAS IN THE PUBLISHED WORKBOOK (general rule, 3 Aug 2026).** A
  Google Sheet RECALCULATES on import: any formula becomes live data the
  pipeline pulls, mutating outside the gate. Measured on v21's upload:
  461 formula cells across three self-check columns, 288 of them with
  silently drifted row references — 238 evaluated "OK" while validating
  the WRONG row, some referencing rows past the sheet's end. The
  architecture is that the sheet stores declared facts and code derives
  everything else; self-checks belong in the validator, where every one
  of these formulas' intents already has a tested rule
  (`referential/fixtures-competition_id`, `referential/links-from_id`/
  `-to_id`, `arithmetic/berth-sum`). Enforcement: a validator rule
  (`hygiene/formula-cells`, ERROR) fails on any formula cell — SheetJS
  retains `cell.f` even though the loader consumes values, so load.ts
  surfaces a `formulaCells` list for the rule; it lands together with the
  formula-column deletion pass so the battery never sees 461 spurious
  errors.

  **The archive branch is NOT unprotected — it gets its own ruleset**,
  because it carries the gate baseline: a token that can force-push it
  can rewrite what the gate compares against. Ruleset (GitHub → Settings
  → Rules → Rulesets → New branch ruleset): name `archive-append-only`;
  enforcement Active; target branch pattern `archive`; enable **Block
  force pushes** and **Restrict deletions**; everything else (PR
  requirement, status checks) OFF so the CI job can push fast-forward
  commits; **bypass list empty** — history rewrites are never routine,
  and a genuine need is an audited ruleset edit, not a standing
  permission. Honest reach: this preserves *history*, not *content* — a
  writer can still overwrite baseline files in a new fast-forward
  commit. Three compensating controls: (1) `ci-publish` verifies
  baseline integrity every run — the stored workbook must hash to the
  sha its meta recorded at publish time, and half a baseline counts as
  failure, **exit 3, a distinct path from "no baseline" whose message
  forbids bootstrapping over it** (a bootstrap ack there would launder
  the tampering); (2) any content rewrite is a preserved, attributable
  commit on the branch; (3) rewriting workbook AND meta *consistently*
  survives (1) — that residual is detectable only against the live
  artefact's `meta.workbook.sha256`, recorded here as a known limit
  until a live-artefact cross-check is added.

The site states its own provenance from this without a second request.
**Refinement to the framing on staleness display:** show the source's as-of
prominently, agreed — but the provenance strip must show **both** the
source as-of AND generated_at. As-of alone cannot distinguish "the sheet
hasn't changed" from "the pipeline died three weeks ago"; the pair makes
either failure visible. Archived copies published alongside
(`data/archive/data-<sha256-prefix>.json`) give "versioned data.json" real
meaning.

**Source precedence, recorded for step 4 (noted 3 Aug 2026, before the
strip is built):** App() prefers a stored dataset over the fetch. Harmless
on the public site, but in a browser that has ever drag-dropped a workbook,
the stored copy outranks the published artefact indefinitely — and it
carries no `meta.artefact` for the strip to read. The provenance strip must
therefore state **which source supplied the data** — fetched artefact,
stored file, or drag-drop — as a fact the app knows about its own load
path, not only what the artefact says about itself. A strip that renders
nothing (or stale claims) on the stored-file path is the discovery this
note pre-empts.

## 5. What this breaks, and the anti-fork

The app today parses xlsx via XLSX/Papa in `parseWorkbook`, then feeds
`normalise()`. The key fact: **the data.json contract already exists and is
tested daily** — every harness does `loadWorkbook(xlsx)` → strip RAW →
`normalise(raw)`. data.json's `data` block is exactly that stripped shape.
Stage four promotes the harness path to production; it does not invent a
second loader.

- **Generator** (`tools/emit-data.mjs`): `loadWorkbook` → strip RAW → rows
  + meta. Uses `src/lib/load.ts` — no new cleaning code.
- **App:** two ingestion paths, one `normalise()`: (dev) drag-drop workbook
  through the existing XLSX path, unchanged; (site) `fetch("data/data.json")`
  → `normalise(json.data)`. The fork risk is two *cleaners*, not two
  *transports* — both transports end at the same normalise, and cleaning
  happens once, in CI, through load.ts.
- **Validator:** unchanged, and it never reads data.json — it validates the
  workbook (it needs the RAW cell view for hygiene rules), upstream of the
  artefact. data.json is downstream of the gate by construction.
- **load.ts:** approximately nothing changes. Possibly an exported
  `stripForPublish(ds)` so the generator and the harnesses share the
  strip-RAW step rather than each writing `delete o[RAW]`.
- **The anti-fork test:** a round-trip harness — generate data.json from
  the workbook, feed `normalise(json.data)`, and assert the resulting idx
  outcomes (thresholds, berth sums, verdict samples) are identical to the
  direct-workbook path. Same spirit as qualified-roundtrip: the two paths
  are proven equivalent on every run, so they cannot drift silently.

## Build order

1. **Generator + round-trip harness.** `tools/emit-data.mjs` and the
   equivalence test. Local only; no CI, no app changes. Proves the artefact
   shape before anything consumes it.
2. **App fetch branch + invariant enforcement.** The fetch path into
   normalise, dev drag-drop kept; the bundle-sentinel and import-lint tests
   land in the SAME change — the invariant test ships with the first code
   that could violate it, not after.
3. **CI skeleton.** Pull (hash, archive, diff-vs-previous) → **ack check on
   gated tabs/columns** → validator gate → emit → **round-trip harness, in
   the chain, against the pulled workbook and the just-emitted artefact —
   not a committed fixture** → atomic publish. The round-trip's position is
   load-bearing: the validator gates the workbook upstream on RAW, so a
   generator bug would otherwise ship a wrong site under a green gate; the
   harness between emit and publish is the only guard on the artefact
   itself, and it must therefore run on every publish, in CI, on the real
   inputs. Last-good semantics come free from ordering: the artefact is
   replaced last, atomically.
4. **Site provenance strip.** as-of + generated_at + validator summary from
   meta, plus the audit view reading `meta.validator`.

Each step is independently verifiable with the existing harness style, and
nothing before step 3 touches credentials or infrastructure.
