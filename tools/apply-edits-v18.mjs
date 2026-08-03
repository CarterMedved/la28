/**
 * Fourteenth edit pass: v17 → v18. Per-ranking staleness, Option A.
 *
 * New Ranking_Systems column `next_refresh_expected`: the date past which
 * ABSENCE of a refresh is suspicious — NOT the date the source will publish.
 * fiba-mens-world-ranking = 2026-09-07: Window 4 closes 1 Sep 2026 (the
 * anchor, CONFIRMED — FIBA states the next update follows its conclusion)
 * plus 6 days, the widest observed close→publication lag. The +6 is our
 * margin, derived from observations, not FIBA's statement. ICC rows stay
 * blank (continuous updates → 30-day fallback); stubs are silent by
 * construction (the rule builds from Standings rows).
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v17.xlsx";
const OUT = "data/LA28_Qualification_Database_v18.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);

const rs = wb.getWorksheet("Ranking_Systems");
{
  if (colIdx(rs, "next_refresh_expected") !== -1) throw new Error("next_refresh_expected already exists");
  const head = rs.getRow(1);
  const next = head.values.length;
  head.getCell(next).value = "next_refresh_expected";
  expected.push({ sheet: "Ranking_Systems", key: "(header)", col: "next_refresh_expected", kind: "col-add" });

  const iR = colIdx(rs, "ranking_id"), iD = colIdx(rs, "decay_notes");
  let hit = null;
  rs.eachRow((r, n) => { if (n > 1 && r.getCell(iR).value === "fiba-mens-world-ranking") hit = r; });
  if (!hit) throw new Error("no fiba-mens-world-ranking row");
  hit.getCell(next).value = "2026-09-07";
  expected.push({ sheet: "Ranking_Systems", key: "fiba-mens-world-ranking", col: "next_refresh_expected", kind: "cell" });

  const cur = String(hit.getCell(iD).value ?? "");
  if (/next_refresh_expected/.test(cur)) throw new Error("decay_notes already documents the column");
  hit.getCell(iD).value = cur +
    " next_refresh_expected 2026-09-07 = Window 4 close (1 Sep 2026; anchor CONFIRMED — FIBA states the next update " +
    "follows the conclusion of Window 4) + 6 days, the widest observed close→publication lag (0, 0 and 6 days for " +
    "Windows 1-3 → 2 Dec 2025, 3 Mar 2026, 13 Jul 2026). The +6 margin is ours, derived from those observations — " +
    "not published by FIBA. The column means 'date past which absence of a refresh is suspicious', not 'date FIBA " +
    "will publish'.";
  expected.push({ sheet: "Ranking_Systems", key: "fiba-mens-world-ranking", col: "decay_notes", kind: "cell" });
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v18.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes ` +
  `(${expected.filter(e => e.kind === "cell").length} cell, 0 row-adds, ${expected.filter(e => e.kind === "col-add").length} col-add)`);
