/**
 * Seventeenth edit pass: v20 → v21. The twelve FWOPQT tz values were an
 * UNMARKED INFERENCE — America/New_York derives from a -4h offset against
 * FIBA's *displayed* listing, whose display zone was never sourced. In a
 * transcription-over-inference column, the first twelve values set the
 * convention the next 137 follow, so the derivation is now recorded per row
 * in a new `tz_source` column. The VALUES DO NOT CHANGE: the venue
 * cross-check (Guadalajara UTC-6; tip-offs land 12:00-20:30 local under
 * Eastern) makes Eastern much the better reading. When the organiser's
 * published local-time listing is sourced, the marker clears or the values
 * change.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v20.xlsx";
const OUT = "data/LA28_Qualification_Database_v21.xlsx";

const MARKER =
  "DERIVED (2 Aug 2026): -4h offset vs FIBA's displayed listing; FIBA's display zone UNCONFIRMED, " +
  "not a published local-time schedule. Venue cross-check (Guadalajara UTC-6; tip-offs 12:00-20:30 " +
  "local under Eastern) supports the reading. Replace or confirm when the organiser's local-time listing is sourced.";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];

const fx = wb.getWorksheet("Fixtures");
const head = fx.getRow(1);
if (head.values.includes("tz_source")) throw new Error("Fixtures already has tz_source — aborting");
const iId = head.values.findIndex(v => v === "fixture_id");
const iTz = head.values.findIndex(v => v === "tz");
if (iTz < 0) throw new Error("no tz column — aborting");
const iSrc = head.values.length;
head.getCell(iSrc).value = "tz_source";
expected.push({ sheet: "Fixtures", key: "(header)", col: "tz_source", kind: "col-add" });

let done = 0;
fx.eachRow((r, n) => {
  if (n === 1) return;
  const tz = r.getCell(iTz).value;
  if (tz == null || String(tz).trim() === "") return;
  if (String(tz) !== "America/New_York") throw new Error(`${r.getCell(iId).value}: unexpected tz "${tz}" — aborting`);
  r.getCell(iSrc).value = MARKER;
  expected.push({ sheet: "Fixtures", key: String(r.getCell(iId).value), col: "tz_source", kind: "cell" });
  done++;
});
if (done !== 12) throw new Error(`expected 12 tz_source fills, made ${done}`);

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v21.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes (1 col-add + 12 cells, ${MARKER.length}-char marker)`);
