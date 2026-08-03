/**
 * Workbook → typed dataset. Mirrors the app's loader: same sheet aliases,
 * same header normalisation, same nan-coercion at the boundary.
 *
 * Each cleaned row also carries the raw cell values under RAW, because the
 * hygiene rules must see what cleaning would otherwise hide (literal "nan",
 * whitespace-padded ids).
 */
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { deriveQualification } from "./qualified.ts";

export const SHEETS = {
  events:    { names: ["Olympic_Events", "olympic_events", "Events"] },
  comps:     { names: ["Competitions", "competitions"] },
  links:     { names: ["Links", "links"] },
  rank:      { names: ["Ranking_Systems", "ranking_systems", "Rankings"] },
  standings: { names: ["Standings", "standings"] },
  cuts:      { names: ["Cut_Lines", "cut_lines", "Cutlines"] },
  fixtures:  { names: ["Fixtures", "fixtures"] },
  qualified: { names: ["Qualified", "qualified"] },
} as const;
export type TabKey = keyof typeof SHEETS;

export const norm = (h: unknown) =>
  String(h ?? "").trim().toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^\w]/g, "");

const NUMERIC = new Set(["berths", "qualifiers", "quota_total", "cascade_order", "rank", "rating",
                         "matches", "points", "n", "teams_count", "offset"]);

const NANISH = new Set(["nan", "nat", "none", "null", "#n/a"]);

export function cleanCell(key: string, v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || NANISH.has(s.toLowerCase())) return null;
  if (NUMERIC.has(key)) { const n = Number(s); return Number.isFinite(n) ? n : null; }
  return s;
}

/** "2026-08-03", "2026-08-03 14:00:00", Excel serials → "YYYY-MM-DD" (or null). */
export function dayOf(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const RAW = Symbol("raw");
export type Row = Record<string, string | number | null> & { [RAW]: Record<string, unknown> };

export interface Dataset {
  events: Row[]; comps: Row[]; links: Row[];
  rank: Row[]; standings: Row[]; cuts: Row[]; fixtures: Row[]; qualified: Row[];
  sheetNameOf: Record<TabKey, string>;
  /**
   * Every formula cell in the workbook, by tab and address. The row values
   * above are RENDERED (raw:false) and cannot see formulas; SheetJS retains
   * cell.f on the parsed sheets, surfaced here for hygiene/formula-cells —
   * a Google Sheet recalculates on import, so a formula is live data
   * mutating outside the gate (docs/stage-four.md). Never serialised into
   * the artefact: emit's dataBlock and contentSha256 read only the tab rows.
   */
  formulaCells: { tab: string; cell: string; formula: string }[];
}

export function loadWorkbook(path: string): Dataset {
  // xlsx's ESM build has no fs binding, so read the buffer ourselves —
  // this is also the same XLSX.read(buffer) path the app uses.
  const wb = XLSX.read(readFileSync(path), { cellDates: false });
  const out = {} as Record<TabKey, Row[]>;
  const sheetNameOf = {} as Record<TabKey, string>;
  for (const [k, spec] of Object.entries(SHEETS) as [TabKey, { names: readonly string[] }][]) {
    const found = wb.SheetNames.find(n => spec.names.some(c => norm(c) === norm(n)));
    if (!found) { out[k] = []; sheetNameOf[k] = spec.names[0]; continue; }
    sheetNameOf[k] = found;
    const rows: unknown[][] = XLSX.utils.sheet_to_json(wb.Sheets[found], { header: 1, raw: false, defval: null });
    const head = (rows[0] || []).map(norm);
    out[k] = rows.slice(1)
      .filter(r => r.some(c => c !== null && c !== undefined && String(c).trim() !== ""))
      .map(r => {
        const o = { [RAW]: {} as Record<string, unknown> } as Row;
        head.forEach((h, i) => { if (h) { o[h] = cleanCell(h, r[i]); o[RAW][h] = r[i]; } });
        return o;
      });
  }
  // Qualified is the single source for settled berths: derive Standings'
  // already_qualified / qualified_via from it (per managed event) rather than
  // trusting stored values. See src/lib/qualified.ts.
  const eventIds = new Set(out.events.map(e => String(e.olympic_event_id)).filter(s => s !== "null"));
  out.standings = deriveQualification(out.standings, out.qualified, out.rank, eventIds);

  const formulaCells: Dataset["formulaCells"] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name] as Record<string, { f?: string }>;
    for (const addr of Object.keys(sheet))
      if (addr[0] !== "!" && sheet[addr].f) formulaCells.push({ tab: name, cell: addr, formula: sheet[addr].f! });
  }

  return { ...out, sheetNameOf, formulaCells };
}
