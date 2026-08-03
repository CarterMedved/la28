/**
 * Thirteenth edit pass: v16 → v17. The fail-closed decision on fiba-m-fopqt-7.
 *
 * 1. New Cut_Lines column `computability` (blank = normal). fiba-m-fopqt-7 =
 *    UNSATISFIABLE: the global reading returns six Europeans against four
 *    European seats (unsatisfiable, not uncertain); the per-region reading
 *    needs leftover seats, which needs the unresolved Africa 27-vs-28 entry
 *    rule. The cut blocks with reason "unsatisfiable"; nothing computes or
 *    displays a top-7 until the marker is cleared.
 * 2. fiba-m-fopqt-7 notes rewritten: pool definition + BLOCKED evidence
 *    (the verbatim global top 7 and the seat arithmetic — readable without
 *    re-running anything) + the VERIFICATION ITEM kept verbatim. The
 *    AMBIGUOUS segment is superseded: its content (global vs regional cannot
 *    both hold) is exactly what BLOCKED now states with real teams, and the
 *    2024-precedent VERIFICATION ITEM it pointed at survives unchanged.
 * 3. Ranking_Systems · fiba-mens-world-ranking: URL discrepancy flagged
 *    UNCONFIRMED — standings_url holds /en/ranking/men; the cut note
 *    formerly cited /en/rankings. Different strings; no network to test
 *    which resolves.
 */
import ExcelJS from "exceljs";
import { writeFileSync } from "node:fs";

const SRC = "data/LA28_Qualification_Database_v16.xlsx";
const OUT = "data/LA28_Qualification_Database_v17.xlsx";

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(SRC);
const expected = [];
const colIdx = (ws, name) => ws.getRow(1).values.findIndex(v => v === name);

const cl = wb.getWorksheet("Cut_Lines");
const rs = wb.getWorksheet("Ranking_Systems");

// ---- 1. computability column + declaration ----
{
  if (colIdx(cl, "computability") !== -1) throw new Error("computability column already exists");
  const head = cl.getRow(1);
  const next = head.values.length;               // 1-based sparse array: length = lastCol + 1
  head.getCell(next).value = "computability";
  expected.push({ sheet: "Cut_Lines", key: "(header)", col: "computability", kind: "col-add" });

  const iC = colIdx(cl, "cut_line_id");
  let hit = null;
  cl.eachRow((r, n) => { if (n > 1 && r.getCell(iC).value === "fiba-m-fopqt-7") hit = r; });
  if (!hit) throw new Error("no fiba-m-fopqt-7");
  hit.getCell(next).value = "UNSATISFIABLE";
  expected.push({ sheet: "Cut_Lines", key: "fiba-m-fopqt-7", col: "computability", kind: "cell" });

  // ---- 2. notes rewrite with the verbatim evidence ----
  const iN = colIdx(cl, "notes");
  const cur = String(hit.getCell(iN).value ?? "");
  const tail = cur.indexOf(" | VERIFICATION ITEM");
  if (tail < 0) throw new Error("expected ' | VERIFICATION ITEM' segment — notes shape changed, aborting");
  if (!cur.startsWith("Pool: teams NOT in the WC qualifiers' second round")) throw new Error("preamble shape changed, aborting");
  const next2 =
    "Pool: teams NOT in the WC qualifiers' second round; ranking applied only within that pool." +
    " | BLOCKED (2 Aug 2026), computability=UNSATISFIABLE — no satisfiable reading: the global top 7 on today's table is " +
    "Czechia 23, Venezuela 27, Belgium 35, GB 46, Bulgaria 55, Denmark 59, Switzerland 61 — six Europeans where Europe's " +
    "leftover seats are four. The per-region reading is coherent but needs leftover seats, which needs the unresolved " +
    "Africa 27-vs-28 entry rule. FIBA's LA28 entry document settles both; until then no top-7 is computed or displayed." +
    cur.slice(tail);
  if (next2.length > 1000) throw new Error(`notes would be ${next2.length} chars (> 1000)`);
  hit.getCell(iN).value = next2;
  expected.push({ sheet: "Cut_Lines", key: "fiba-m-fopqt-7", col: "notes", kind: "cell" });
  console.log(`fopqt-7 notes: ${cur.length} → ${next2.length} chars`);
}

// ---- 3. URL discrepancy flag ----
{
  const iR = colIdx(rs, "ranking_id"), iP = colIdx(rs, "points_notes");
  let hit = null;
  rs.eachRow((r, n) => { if (n > 1 && r.getCell(iR).value === "fiba-mens-world-ranking") hit = r; });
  if (!hit) throw new Error("no fiba-mens-world-ranking row");
  const cur = String(hit.getCell(iP).value ?? "");
  if (/URL UNCONFIRMED/.test(cur)) throw new Error("URL flag already present");
  hit.getCell(iP).value = cur +
    " URL UNCONFIRMED: standings_url holds /en/ranking/men; the fopqt-7 cut note formerly cited /en/rankings — " +
    "different strings, and neither has been resolved from here (no network). Verify which one serves the table.";
  expected.push({ sheet: "Ranking_Systems", key: "fiba-mens-world-ranking", col: "points_notes", kind: "cell" });
}

await wb.xlsx.writeFile(OUT);
writeFileSync("tools/expected-changes-v17.json", JSON.stringify({ expected }, null, 1));
console.log(`written ${OUT} — ${expected.length} intended changes ` +
  `(${expected.filter(e => e.kind === "cell").length} cell, 0 row-adds, ${expected.filter(e => e.kind === "col-add").length} col-add)`);
