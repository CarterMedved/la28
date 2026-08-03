/**
 * Eleventh edit pass: v14 → v15. Verification-turn data fixes.
 *
 * 1. Qualified · New Zealand (la28-cricket-w): the note said the fallback is
 *    held "on the 31 Dec 2026 women's T20I ranking". Wrong cut-line's date —
 *    31 Dec 2026 is the USA top-15 test (icc-w-host-top15); cri-020 and
 *    icc-w-host-fallback both say 1 March 2027. One cell.
 * 2. stage_source on the nine blank rows, from in-sheet precedent:
 *    - "Tie N · Leg N" is a composite house label (same family as
 *      "Series match 1 of 3", which the sheet marks DERIVED on fx-0026) →
 *      fx-0391..0396 DERIVED. For 0393-0396 the whole structure is
 *      scaffolding from the round format (notes say the blanks are honest
 *      gaps); for 0391/0392 dates and scores are sourced but the tie/leg
 *      numbering is the sheet's own.
 *    - fx-0401/0402: "Semi-final 1/2" where the pairings themselves are the
 *      unsourced PART 7 item — the 1/2 assignment cannot come from a source
 *      → DERIVED (matches fx-0397..0400, the AFC QFs, already DERIVED).
 *    - fx-0403: "Final" is the source's own name for a fully sourced game
 *      (Japan v Australia, 21 Mar 2026) → RESEARCHED (precedent: fx-0084,
 *      the CONCACAF final, RESEARCHED).
 * 3. Verification items from FOPQT precedent research (UNCONFIRMED against
 *    FIBA's LA28 entry document) appended to bkb-013 and fiba-m-fopqt-7.
 *    No berths, qualifiers or rule values change.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v14.xlsx";
const OUT = "data/LA28_Qualification_Database_v15.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);

const fx = wb.getWorksheet("Fixtures");
const lk = wb.getWorksheet("Links");
const cl = wb.getWorksheet("Cut_Lines");
const qd = wb.getWorksheet("Qualified");

// ---- 1. Qualified: NZ fallback date ----
{
  const iE = colIdx(qd, "olympic_event_id"), iT = colIdx(qd, "team"), iN = colIdx(qd, "notes");
  let hit = null;
  qd.eachRow((r, n) => {
    if (n > 1 && r.getCell(iE).value === "la28-cricket-w" && r.getCell(iT).value === "New Zealand") hit = r;
  });
  if (!hit) throw new Error("no NZ row on la28-cricket-w in Qualified");
  const cur = String(hit.getCell(iN).value ?? "");
  if (!cur.includes("31 Dec 2026")) throw new Error("NZ note does not contain '31 Dec 2026' — aborting: " + cur);
  const next = cur.replace("31 Dec 2026", "1 March 2027");
  if ((cur.match(/31 Dec 2026/g) || []).length !== 1) throw new Error("expected exactly one '31 Dec 2026' in the NZ note");
  hit.getCell(iN).value = next;
  expected.push({ sheet: "Qualified", key: "la28-cricket-w#New Zealand", col: "notes", kind: "cell" });
}

// ---- 2. stage_source fills ----
{
  const iF = colIdx(fx, "fixture_id"), iS = colIdx(fx, "stage_source");
  const VALUES = {
    "fx-0391": "DERIVED", "fx-0392": "DERIVED", "fx-0393": "DERIVED",
    "fx-0394": "DERIVED", "fx-0395": "DERIVED", "fx-0396": "DERIVED",
    "fx-0401": "DERIVED", "fx-0402": "DERIVED",
    "fx-0403": "RESEARCHED",
  };
  let done = 0;
  fx.eachRow((r, n) => {
    if (n === 1) return;
    const id = String(r.getCell(iF).value ?? "");
    if (!(id in VALUES)) return;
    if (r.getCell(iS).value != null && String(r.getCell(iS).value) !== "")
      throw new Error(`${id}: stage_source is not blank — aborting`);
    r.getCell(iS).value = VALUES[id];
    expected.push({ sheet: "Fixtures", key: id, col: "stage_source", kind: "cell" });
    done++;
  });
  if (done !== 9) throw new Error(`expected 9 stage_source fills, made ${done}`);
}

// ---- 3. verification items (research prose, UNCONFIRMED — recorded, not applied) ----
{
  const iL = colIdx(lk, "link_id"), iN = colIdx(lk, "eligibility_note");
  let hit = null;
  lk.eachRow((r, n) => { if (n > 1 && r.getCell(iL).value === "bkb-013") hit = r; });
  if (!hit) throw new Error("no bkb-013");
  const cur = String(hit.getCell(iN).value ?? "");
  if (/VERIFICATION ITEM/.test(cur)) throw new Error("bkb-013 already carries a VERIFICATION ITEM");
  hit.getCell(iN).value = cur +
    " | VERIFICATION ITEM (2 Aug 2026, UNCONFIRMED — precedent research, not FIBA's LA28 entry document): " +
    "the 2023 cycle seated ALL 28 second-round non-qualifiers and used the ranking only to fill the remaining 12 of 40 seats; " +
    "Africa that cycle had 7 non-qualifiers and all 7 entered an 8-team field. The 2027 Africa second round " +
    "(two groups of six; top two per group plus best third qualify, 5 of 12) also produces 7 non-qualifiers against a stated 6-team field. " +
    "Supports the fixtures' 28 over FIBA's stated 27 and locates the tension inside FIBA's own numbers rather than in this sheet. " +
    "Verify against FIBA's LA28 entry document.";
  expected.push({ sheet: "Links", key: "bkb-013", col: "eligibility_note", kind: "cell" });
}
{
  const iC = colIdx(cl, "cut_line_id"), iN = colIdx(cl, "notes");
  let hit = null;
  cl.eachRow((r, n) => { if (n > 1 && r.getCell(iC).value === "fiba-m-fopqt-7") hit = r; });
  if (!hit) throw new Error("no fiba-m-fopqt-7");
  const cur = String(hit.getCell(iN).value ?? "");
  if (/VERIFICATION ITEM/.test(cur)) throw new Error("fiba-m-fopqt-7 already carries a VERIFICATION ITEM");
  hit.getCell(iN).value = cur +
    " | VERIFICATION ITEM (2 Aug 2026, UNCONFIRMED — precedent research): the 2024 Africa pre-qualifier's ranking place was drawn from " +
    "'FIBA World Rankings — Africa', a regional list, not a global cut. Evidence AGAINST the global TOP_N_OF_POOL reading recorded here. " +
    "Rule value unchanged; check FIBA's LA28 entry document before remodelling.";
  expected.push({ sheet: "Cut_Lines", key: "fiba-m-fopqt-7", col: "notes", kind: "cell" });
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v15.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes ` +
  `(${expected.filter(e => e.kind === "cell").length} cell, 0 row-adds, 0 row-dels)`);
