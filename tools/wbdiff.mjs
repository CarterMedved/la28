/**
 * Shared workbook snapshot + diff, keyed by row identity (primary key, never
 * row number). Extracted from tools/diff-workbooks.mjs so the pull gate
 * (tools/pull-gate.mjs) and the edit verifier read workbooks through ONE
 * implementation — two diff engines would be a fork in a control.
 *
 * dateRender: "day" (diff-workbooks' historical behaviour — Date cells render
 * date-only) or "full" (the gate's — a time-of-day change on a gated cell
 * must not be invisible).
 */
import ExcelJS from "exceljs";

export const KEY = {
  Olympic_Events: r => r["olympic_event_id"],
  Competitions: r => r["competition_id"],
  Links: r => r["link_id"],
  Ranking_Systems: r => r["ranking_id"],
  Standings: r => `${r["ranking_id"]}|${r["team"]}`,
  Cut_Lines: r => r["cut_line_id"],
  Fixtures: r => r["fixture_id"],
  Qualified: r => `${r["olympic_event_id"]}#${r["team"]}`,
  README: (r, n) => `(line ${n})`,
};

export const cellStr = (v, dateRender = "day") => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && v.richText) return v.richText.map(t => t.text).join("");
  if (v instanceof Date) {
    if (dateRender === "full" && (v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds()))
      return v.toISOString().slice(0, 16).replace("T", " ");
    return v.toISOString().slice(0, 10);
  }
  const s = String(v);
  return s === "" ? null : s;
};

export async function snapshot(path, { dateRender = "day" } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out = {};
  for (const ws of wb.worksheets) {
    const head = ws.getRow(1).values.map(v => cellStr(v, dateRender));
    const rows = {};
    ws.eachRow((r, n) => {
      if (n === 1 && ws.name !== "README") return;
      const obj = {};
      for (let c = 1; c < head.length; c++) obj[head[c] ?? `col${c}`] = cellStr(r.getCell(c).value, dateRender);
      if (ws.name === "README") { rows[`(line ${n})`] = { _raw: cellStr(r.getCell(1).value, dateRender) }; return; }
      const key = KEY[ws.name]?.(obj, n) ?? `row${n}`;
      rows[String(key)] = obj;
    });
    out[ws.name] = { head: head.slice(1).filter(Boolean), rows };
  }
  return out;
}

/**
 * A → B change list: {sheet, key, col, kind, old, new}. Kinds: tab-add,
 * tab-del, col-add, col-del, row-add, row-del, cell. Row add/del carry the
 * whole row as JSON in new/old; values in an added column on existing rows
 * appear as cell edits (old null), matching diff-workbooks' historical
 * accounting.
 */
/**
 * tz↔tz_source coupling (README "Fixtures.tz"): a change to a row's tz
 * WITHOUT a same-pass change to that row's tz_source means an old provenance
 * marker now describes a value it was never written about — the exact
 * failure the marker exists to prevent. Enforced here, in the shared diff
 * engine, so BOTH write paths refuse it: diff-workbooks (every local edit
 * pass) and pull-gate (every CI pull) — a convention, not one script's
 * guard. The reverse (tz_source changing alone) is legitimate: that is the
 * DERIVED→RESEARCHED confirm flow. Static coherence of any single workbook
 * (tz without tz_source at all) is the validator's state/tz-* family.
 */
export function tzCouplingViolations(changes) {
  const srcChanged = new Set(changes
    .filter(c => c.sheet === "Fixtures" && c.col === "tz_source" && c.kind === "cell")
    .map(c => c.key));
  return changes
    .filter(c => c.sheet === "Fixtures" && c.col === "tz" && c.kind === "cell" && !srcChanged.has(c.key))
    .map(c => `${c.key}: tz changed${c.old !== undefined ? ` (${JSON.stringify(c.old)} → ${JSON.stringify(c.new)})` : ""} with tz_source untouched — the marker no longer describes this value`);
}

export function diffSnapshots(A, B) {
  const out = [];
  for (const t of Object.keys(B)) if (!A[t]) out.push({ sheet: t, key: "(tab)", col: null, kind: "tab-add", old: null, new: null });
  for (const t of Object.keys(A)) if (!B[t]) out.push({ sheet: t, key: "(tab)", col: null, kind: "tab-del", old: null, new: null });

  for (const t of Object.keys(A)) {
    if (!B[t]) continue;
    for (const c of B[t].head) if (!A[t].head.includes(c)) out.push({ sheet: t, key: "(header)", col: c, kind: "col-add", old: null, new: null });
    for (const c of A[t].head) if (!B[t].head.includes(c)) out.push({ sheet: t, key: "(header)", col: c, kind: "col-del", old: null, new: null });

    const aKeys = new Set(Object.keys(A[t].rows)), bKeys = new Set(Object.keys(B[t].rows));
    for (const k of aKeys) if (!bKeys.has(k)) out.push({ sheet: t, key: k, col: null, kind: "row-del", old: JSON.stringify(A[t].rows[k]), new: null });
    for (const k of bKeys) if (!aKeys.has(k)) out.push({ sheet: t, key: k, col: null, kind: "row-add", old: null, new: JSON.stringify(B[t].rows[k]) });

    for (const k of aKeys) {
      if (!bKeys.has(k)) continue;
      const ra = A[t].rows[k], rb = B[t].rows[k];
      const cols = new Set([...Object.keys(ra), ...Object.keys(rb)]);
      for (const c of cols) {
        const va = ra[c] ?? null, vb = rb[c] ?? null;
        if (va !== vb) out.push({ sheet: t, key: k, col: c === "_raw" ? null : c, kind: "cell", old: va, new: vb });
      }
    }
  }
  return out;
}
