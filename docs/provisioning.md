# Provisioning runbook: Sheets → CI → Pages (stage four goes live)

*Written 3 Aug 2026. The workflow stays `.github/workflows/publish.yml.disabled`
until every step here is done and the owner deliberately renames it — the
rename is the switch, and the file's header says what happens the moment it
flips. Constraints that govern everything below: secret-holding workflows
trigger on `schedule`/`workflow_dispatch` ONLY; no required PRs on any
ruleset; see docs/stage-four.md.*

## A. Google side

1. console.cloud.google.com → project picker → **New project** → name
   `la28-pull`, no organisation.
2. APIs & Services → Library → **Google Drive API** → Enable.
3. IAM & Admin → Service accounts → **Create service account** → name
   `la28-pull` → **skip both "grant access" steps** — the account must hold
   NO roles; its only power will be the one file shared with it.
4. Open the account → Keys → Add key → Create new key → **JSON**. The
   downloaded file IS the credential: it lives in Downloads only until step
   C-1 pastes it into the secret store, and never enters the repo tree.
5. Copy the account email: `la28-pull@<project>.iam.gserviceaccount.com`.
6. Upload `data/LA28_Qualification_Database_v22.xlsx` to Drive → open →
   **File → Save as Google Sheets**. This new Sheet is about to become the
   canonical workbook (see CUTOVER below) — but not before the preflight.

## B. PREFLIGHT — BLOCKING. No GitHub wiring until all four pass.

From the new Sheet: **File → Download → Microsoft Excel (.xlsx)**, save as
`preflight-1.xlsx`. Then:

1. **Validator**: `node src/validate/cli.ts preflight-1.xlsx
   --reference-date <today> --known-issues known-issues.json --sentinels
   sentinels.json` → must be 0 ERROR with the same WARN/INFO composition
   as a local run of the SAME validator version on the same workbook
   (counts move when rules ship — compare like with like, never a pinned
   number from a doc).
2. **Round-trip**: `node test/data-roundtrip.mjs preflight-1.xlsx --ci` →
   all checks pass.
3. **Cell-exact diff** — the check the first two cannot make (both pass on
   a workbook whose date FORMATS silently changed, which is exactly the
   toStamp failure class):
   `node tools/diff-workbooks.mjs data/LA28_Qualification_Database_v22.xlsx
   preflight-1.xlsx tools/expected-none.json`
   → must print **EXACT MATCH** with 0 observed changes. Anything else:
   STOP and enumerate every listed difference to the owner — the list, not
   a verdict. Import fidelity problems get fixed before CI exists.
4. **Double-export comparison — CELL VALUES and NUMBER FORMATS, never
   zip structure.** Without touching the Sheet, download the xlsx a
   SECOND time as `preflight-2.xlsx`. Then:
   `node tools/compare-exports.mjs preflight-1.xlsx preflight-2.xlsx`
   — compares the two exports at the level that matters: **every cell
   value identical across all nine tabs, and every number format
   identical** (Fixtures.date must read `yyyy-mm-dd h:mm:ss` in both,
   on date-typed cells — the toStamp bug came from a number format, so
   formats ARE content here). It prints both file sha256s for the
   record and exits 1 with a full enumeration on any difference.
   **MEASURED 3 Aug 2026, and the byte delta is NOT compression or
   mtimes:** Google RE-SERIALISES the sheet XML between exports — 11 zip
   entries had different CRC-32s and 9 had different uncompressed XML
   sizes (deltas both directions, net −45 bytes) with zero differing
   cells and zero differing formats. **A future session must not read
   differing CRCs or raw XML sizes as corruption — they differ by
   design.** The two file sha256s differing is what makes the dual-hash
   NECESSARY (content_sha256 drives skip/archive-key/bootstrap; raw
   workbook_sha256 keeps only baseline integrity — implemented, proven
   in `test/ci-gate.mjs`); the sha256s are the trigger for that design,
   never the diagnosis of a problem. Stop and investigate only if the
   CELL-VALUE or NUMBER-FORMAT comparison differs.

5. **No formulas** (general rule, measured the hard way — see
   docs/stage-four.md): a Sheet RECALCULATES on import, so any formula in
   the workbook becomes live data the pipeline pulls. v21 carried 461
   formula cells in three self-check columns, 288 with silently drifted
   row references. The formula columns are deleted before cutover (their
   intents are already tested validator rules), and
   `hygiene/formula-cells` (ERROR) enforces the rule thereafter. If
   preflight (a) ever shows a formula-bearing diff again, the rule was
   bypassed — stop.

## C. GitHub side (repo Settings, CarterMedved/la28)

1. Secrets and variables → Actions → New repository secret:
   **`LA28_SA_KEY`** = entire JSON key file, pasted verbatim;
   **`LA28_SPREADSHEET_ID`** = the id between `/d/` and `/edit` in the
   Sheet URL. Then delete the downloaded key file and empty the trash.
2. Pages → Build and deployment → Source: **GitHub Actions**.
3. Rules → Rulesets → two rulesets, enforcement Active, bypass EMPTY,
   **Block force pushes + Restrict deletions and nothing else** (no PR
   requirement — deliberate, stage-four.md records why):
   - `main-protect`, target branch `main`;
   - `archive-append-only`, target branch `archive` (the branch not
     existing yet is fine).

## D. First real run

Before pushing this or ANY later workflow/pipeline change:
`node test/ci-rehearsal.mjs` — replays the workflow's commands against a
fresh-checkout scratch tree (runs 1–3 plus fail-closed negatives). CI run 1
failed on a fresh-checkout path assumption no local run could see; the
rehearsal exists so that class is caught before a push, not by run 1.

Rename: `git mv .github/workflows/publish.yml.disabled
.github/workflows/publish.yml`, commit, push. Actions tab → publish →
**Run workflow** (don't wait for the 06:17 UTC cron).

- Run 1: pull succeeds — reach log must list **exactly one file** — then
  **NO BASELINE FOUND, exit 1: the run FAILS BY DESIGN**, printing the
  bootstrap digest that binds the pulled bytes.
- Commit that digest to `pull-acks.json` (note + date), push, re-run.
- Run 2: publishes — Pages serves `data/data.json`, provenance strip shows
  the artefact path, and the archive job creates the `archive` branch
  carrying `state/` (baseline pair) + `data/archive/`.
- Run 3 (untouched sheet): `SKIP PUBLISH`, archive job does not run.
- Revocation drill (any time): deleting the key in the Google console
  makes the next pull fail closed at token exchange; the site keeps
  serving the last artefact.

## Preflight-failure fix sequence (established 3 Aug 2026)

When the preflight finds a workbook defect (as it did: the formula
columns), the fix goes **LOCAL FIRST, then re-upload, then full
re-preflight**:

1. Fix in the local workbook as a normal versioned edit pass
   (apply-edits-vN + expected-changes + diff-proof + battery) — the
   lineage stays the record, and cutover has NOT happened yet: the
   preflight is the cutover gate, and canonical transfers to the Sheet
   only when it passes.
2. Replace the Sheet's content from the fixed xlsx (File → Import →
   **Replace spreadsheet** — never delete-and-recreate, which would
   change the spreadsheet ID the pipeline pins).
3. Re-run the ENTIRE preflight (B1–B5) against the new export. Only a
   full pass moves canonical status to the Sheet.

## CUTOVER — what is canonical after step A6

**The Google Sheet is the workbook.** From the moment it exists and the
preflight passes:

- **Canonical**: the Sheet. Every data change is made THERE and reaches
  the site only through pull → gate → validator → publish.
- **`data/*.xlsx` in the repo is history**: the v5–v22 lineage plus the
  edit scripts document how every value got its provenance, and
  `data/LA28_Qualification_Database.xlsx` remains the harnesses' pinned
  fixture. **Editing a repo workbook changes NOTHING on the site** — the
  obvious mistake is hand-editing local v22, diff-proving it, and
  wondering why the site never moved. The pipeline reads only the Sheet.
- **Outage procedure (Sheets or the pipeline down)**: there is NO local
  publish path, by design — the last published artefact standing is the
  fail-closed feature, not an emergency. If a data fix cannot wait:
  prepare it as a local edit pass (apply-edits script + diff-proof, the
  v-lineage discipline) so the change and its evidence are ready, then
  apply the SAME edit to the Sheet when service returns and let the
  pipeline ship it. The local pass is a staging note, never a publish.
