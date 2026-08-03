# Provisioning runbook: Sheets → CI → Pages (stage four goes live)

*Written 4 Aug 2026. The workflow stays `.github/workflows/publish.yml.disabled`
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
6. Upload `data/LA28_Qualification_Database_v21.xlsx` to Drive → open →
   **File → Save as Google Sheets**. This new Sheet is about to become the
   canonical workbook (see CUTOVER below) — but not before the preflight.

## B. PREFLIGHT — BLOCKING. No GitHub wiring until all four pass.

From the new Sheet: **File → Download → Microsoft Excel (.xlsx)**, save as
`preflight-1.xlsx`. Then:

1. **Validator**: `node src/validate/cli.ts preflight-1.xlsx
   --reference-date <today> --known-issues known-issues.json --sentinels
   sentinels.json` → must be 0 ERROR with the same WARN/INFO composition
   as v21.
2. **Round-trip**: `node test/data-roundtrip.mjs preflight-1.xlsx --ci` →
   all checks pass.
3. **Cell-exact diff** — the check the first two cannot make (both pass on
   a workbook whose date FORMATS silently changed, which is exactly the
   toStamp failure class):
   `node tools/diff-workbooks.mjs data/LA28_Qualification_Database_v21.xlsx
   preflight-1.xlsx tools/expected-none.json`
   → must print **EXACT MATCH** with 0 observed changes. Anything else:
   STOP and enumerate every listed difference to the owner — the list, not
   a verdict. Import fidelity problems get fixed before CI exists.
4. **Export byte-stability**: without touching the Sheet, download the
   xlsx a SECOND time as `preflight-2.xlsx`, then
   `shasum -a 256 preflight-1.xlsx preflight-2.xlsx`.
   - **Identical** → Google's export is byte-stable; the raw-bytes skip
     identity in ci-publish stands; proceed.
   - **Different** → the skip-publish idempotence is broken by
     construction (it keys on the workbook hash): an untouched sheet would
     publish daily and write a pointless archive commit every run. STOP
     and implement the dual-hash fix before wiring:
     **meta gains `content_sha256`** = sha256 of the normalised data block
     (the loadWorkbook→strip rows, exactly what data.json carries), used
     for the SKIP decision and the archive key; **`workbook_sha256` (raw
     bytes) stays** and keeps its one job: the baseline integrity check,
     which compares the STORED baseline workbook against the sha recorded
     when that same file was seeded — self-consistent bytes, so export
     instability costs it nothing. Two hashes, two labelled jobs; the
     bootstrap digest moves to content_sha256 too (it must survive a
     byte-unstable re-export of unchanged data).

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

## CUTOVER — what is canonical after step A6

**The Google Sheet is the workbook.** From the moment it exists and the
preflight passes:

- **Canonical**: the Sheet. Every data change is made THERE and reaches
  the site only through pull → gate → validator → publish.
- **`data/*.xlsx` in the repo is history**: the v5–v21 lineage plus the
  edit scripts document how every value got its provenance, and
  `data/LA28_Qualification_Database.xlsx` remains the harnesses' pinned
  fixture. **Editing a repo workbook changes NOTHING on the site** — the
  obvious mistake is hand-editing local v21, diff-proving it, and
  wondering why the site never moved. The pipeline reads only the Sheet.
- **Outage procedure (Sheets or the pipeline down)**: there is NO local
  publish path, by design — the last published artefact standing is the
  fail-closed feature, not an emergency. If a data fix cannot wait:
  prepare it as a local edit pass (apply-edits script + diff-proof, the
  v-lineage discipline) so the change and its evidence are ready, then
  apply the SAME edit to the Sheet when service returns and let the
  pipeline ship it. The local pass is a staging note, never a publish.
