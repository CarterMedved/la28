/**
 * Twelfth edit pass: v15 → v16.
 *
 * 1. fiba-m-fopqt-7 notes: the "NOT COMPUTABLE yet" preamble is false — the
 *    cut computes (at rank 78 under the current derivation; wrongly, per the
 *    pool-derivation finding, but it computes). Replaced with a short pool
 *    statement; AMBIGUOUS and VERIFICATION ITEM segments kept verbatim.
 *    Asserts the result is back under the 1000-char notes-essay threshold.
 * 2. Three FWOPQT knockout rows (fx-0404..0406): FIBA has published the 12
 *    group games only — no knockout dates, no bracket. Blank dates, blank
 *    teams, stage_source DERIVED, date_confidence UNCONFIRMED. The Final is
 *    the fixture whose winner takes the FWOQT place (bkb-031) and was absent
 *    from the sheet entirely.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v15.xlsx";
const OUT = "data/LA28_Qualification_Database_v16.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);

// ---- 1. fiba-m-fopqt-7 preamble trim ----
{
  const cl = wb.getWorksheet("Cut_Lines");
  const iC = colIdx(cl, "cut_line_id"), iN = colIdx(cl, "notes");
  let hit = null;
  cl.eachRow((r, n) => { if (n > 1 && r.getCell(iC).value === "fiba-m-fopqt-7") hit = r; });
  if (!hit) throw new Error("no fiba-m-fopqt-7");
  const cur = String(hit.getCell(iN).value ?? "");
  const tail = cur.indexOf(" | AMBIGUOUS");
  if (tail < 0) throw new Error("expected ' | AMBIGUOUS' segment — notes shape changed, aborting");
  if (!cur.startsWith("NOT COMPUTABLE yet.")) throw new Error("preamble is not the 'NOT COMPUTABLE yet' text — aborting");
  // No URL here: it already lives on the Ranking_Systems row (standings_url),
  // and the AMBIGUOUS + VERIFICATION segments alone are 896 chars.
  const next =
    "Pool: teams NOT in the WC qualifiers' second round; ranking applied only within that pool." + cur.slice(tail);
  if (next.length > 1000) throw new Error(`trimmed notes still ${next.length} chars (> 1000) — trim failed`);
  hit.getCell(iN).value = next;
  expected.push({ sheet: "Cut_Lines", key: "fiba-m-fopqt-7", col: "notes", kind: "cell" });
  console.log(`fopqt-7 notes: ${cur.length} → ${next.length} chars`);
}

// ---- 2. FWOPQT knockout rows ----
{
  const fx = wb.getWorksheet("Fixtures");
  const iF = colIdx(fx, "fixture_id");
  fx.eachRow((r, n) => {
    if (n > 1 && /^fx-040[456]$/.test(String(r.getCell(iF).value ?? "")))
      throw new Error("fx-0404..0406 already exist");
  });
  const head = fx.getRow(1).values;
  const NOTE_SF = "FIBA has published the 12 group games only; the knockout schedule is unpublished and the bracket is empty. Row exists so the knockout structure is present; do not add dates until FIBA publishes them.";
  const NOTE_F  = "FIBA has published the 12 group games only; the knockout schedule is unpublished and the bracket is empty. THIS is the fixture that awards the FWOQT place (bkb-031: the FWOPQT winner takes one of the 16 FWOQT places). Do not add dates until FIBA publishes them.";
  const ROWS = [
    ["fx-0404", "Semi-final 1", NOTE_SF],
    ["fx-0405", "Semi-final 2", NOTE_SF],
    ["fx-0406", "Final", NOTE_F],
  ];
  for (const [fid, stage, note] of ROWS) {
    const row = new Array(head.length - 1).fill(null);
    const put = (col, v) => row[head.indexOf(col) - 1] = v;
    put("fixture_id", fid);
    put("competition_id", "2026-fiba-women-s-olympic-pre-qualifying-tournament");
    put("stage", stage);
    put("stage_source", "DERIVED");
    put("date_confidence", "UNCONFIRMED");
    put("notes", note);
    fx.addRow(row);
    expected.push({ sheet: "Fixtures", key: fid, col: null, kind: "row-add" });
  }
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v16.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes ` +
  `(${expected.filter(e => e.kind === "cell").length} cell, ${expected.filter(e => e.kind === "row-add").length} row-adds, 0 row-dels)`);
