/**
 * Sixteenth edit pass: v19 → v20. The tz column (docs/timezones.md, option B
 * adopted 3 Aug 2026): Fixtures gains a `tz` column (IANA zone of the LOCAL
 * match time already stored — declaration, never conversion), populated for
 * exactly the twelve FWOPQT group games, whose Eastern reading is verified
 * against FIBA's published listing (consistent −4h across all twelve, no
 * date rollovers — the worked case in the doc). Every other row stays blank
 * until sourced: blank is incomplete, not false (coverage/tz-undeclared
 * WARNs on it). NO stored time is touched — the column states what zone the
 * stored local times are in; converting them is the 5-vs-6 Aug error class.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v19.xlsx";
const OUT = "data/LA28_Qualification_Database_v20.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];

const fx = wb.getWorksheet("Fixtures");
const head = fx.getRow(1);
if (head.values.includes("tz")) throw new Error("Fixtures already has a tz column — aborting");
const iId = head.values.findIndex(v => v === "fixture_id");
const iDate = head.values.findIndex(v => v === "date");
const iTz = head.values.length;            // values is 1-based sparse; length = next free column
head.getCell(iTz).value = "tz";
expected.push({ sheet: "Fixtures", key: "(header)", col: "tz", kind: "col-add" });

// The twelve FWOPQT group games, by id — fx-0404/0405/0406 (SF1/SF2/Final)
// have no dates and stay blank.
const FWOPQT = ["fx-0086", "fx-0087", "fx-0088", "fx-0089", "fx-0090", "fx-0091",
                "fx-0092", "fx-0093", "fx-0094", "fx-0095", "fx-0096", "fx-0097"];
const ZONE = "America/New_York";
let done = 0;
fx.eachRow((r, n) => {
  if (n === 1) return;
  const id = String(r.getCell(iId).value ?? "");
  if (!FWOPQT.includes(id)) return;
  // Defensive: the row must be a dated August-2026 group game with a real time.
  const d = r.getCell(iDate).value;
  if (!(d instanceof Date) || d.toISOString().slice(0, 7) !== "2026-08")
    throw new Error(`${id}: date is not an Aug-2026 datetime (${d}) — aborting`);
  if (r.getCell(iTz).value != null) throw new Error(`${id}: tz not blank — aborting`);
  r.getCell(iTz).value = ZONE;
  expected.push({ sheet: "Fixtures", key: id, col: "tz", kind: "cell" });
  done++;
});
if (done !== 12) throw new Error(`expected 12 tz fills, made ${done}`);

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v20.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes (1 col-add + 12 cells)`);
