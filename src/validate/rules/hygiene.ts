/**
 * Hygiene — pandas leakage and invisible-character traps. Works on RAW cell
 * values, because the loader's cleaning would otherwise hide exactly what
 * these rules exist to catch.
 */
import type { Rule, Finding } from "../types.ts";
import { finding, idOf } from "../types.ts";
import { RAW, type Row } from "../../lib/load.ts";

const NAN_LITERALS = new Set(["nan", "NaN", "None", "null", "NULL", "NaT"]);
const ID_COL = /(_id|^leads_to)$/;

const eachCell = (ds: Record<string, unknown>, tabs: [keyof typeof idOf, Row[]][], fn: (tab: keyof typeof idOf, row: Row, col: string, raw: unknown) => void) => {
  for (const [tab, rows] of tabs)
    for (const row of rows)
      for (const [col, raw] of Object.entries(row[RAW]))
        fn(tab, row, col, raw);
};

/**
 * Pasted-essay detection. Eight rows carried the same multi-thousand-char
 * research summaries and nothing caught it. Two smells, both WARN:
 *   - a notes cell over 1000 chars (a note is a note; an essay is a document
 *     that belongs elsewhere and goes stale where nothing re-derives it);
 *   - identical notes text (>300 chars) appearing on more than one row.
 *     Short shared boilerplate (fencing's six identical event explanations)
 *     is doing its job; only long duplicated prose is a paste.
 */
export const notesSmell: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const tabs: [keyof typeof idOf, Row[]][] = [
    ["events", ds.events], ["comps", ds.comps], ["links", ds.links], ["rank", ds.rank],
    ["standings", ds.standings], ["cuts", ds.cuts], ["fixtures", ds.fixtures], ["qualified", ds.qualified],
  ];
  const byText: Record<string, { tab: string; rowId: string }[]> = {};
  for (const [tab, rows] of tabs) {
    for (const row of rows) {
      const v = row.notes;
      if (v == null) continue;
      const s = String(v);
      const rowId = idOf[tab](row);
      if (s.length > 1000)
        out.push(finding("WARN", "hygiene/notes-essay", ds.sheetNameOf[tab], rowId,
          `notes is ${s.length} chars — that is a document, not a note. Move rules to the modelled columns, ` +
          `derived claims nowhere (the app computes them), and keep notes to sourcing and verification items.`));
      if (s.length > 300) (byText[s] ||= []).push({ tab: ds.sheetNameOf[tab], rowId });
    }
  }
  for (const [text, rows] of Object.entries(byText)) {
    if (rows.length < 2) continue;
    out.push(finding("WARN", "hygiene/notes-duplicated", rows[0].tab, rows.map(r => r.rowId).join(" & "),
      `identical notes text (${text.length} chars) on ${rows.length} rows: ${rows.map(r => `${r.tab}·${r.rowId}`).join("; ")}. ` +
      `Duplicated prose is a paste — keep it on one row (or nowhere) and reference it from the others.`));
  }
  return out;
};

export const hygiene: Rule = ({ ds }) => {
  const out: Finding[] = [];
  const tabs: [keyof typeof idOf, Row[]][] = [
    ["events", ds.events], ["comps", ds.comps], ["links", ds.links], ["rank", ds.rank],
    ["standings", ds.standings], ["cuts", ds.cuts], ["fixtures", ds.fixtures],
  ];

  eachCell(ds, tabs, (tab, row, col, raw) => {
    if (raw == null) return;
    const s = String(raw);
    const rowId = idOf[tab](row);
    const sheet = ds.sheetNameOf[tab];

    // Literal "nan"/"None"/… — the loader coerces these to null so joins
    // survive, but the cell itself is pandas leakage and should be cleared.
    if (NAN_LITERALS.has(s.trim()))
      out.push(finding("WARN", "hygiene/nan-literal", sheet, rowId,
        `${col} contains the literal string "${s.trim()}" — pandas leakage. Clear the cell.`, `/${col}`));

    if (ID_COL.test(col)) {
      // Whitespace on an id silently breaks joins — ERROR.
      if (s !== s.trim())
        out.push(finding("ERROR", "hygiene/id-whitespace", sheet, rowId,
          `${col} has leading/trailing whitespace: ${JSON.stringify(s)}. This silently breaks joins; trim it.`, `/${col}`));
      // Curly quotes / unicode dashes inside ids — they look identical to the
      // straight forms and make two ids that never match.
      if (/[‘’“”–— ]/.test(s))
        out.push(finding("WARN", "hygiene/id-unicode", sheet, rowId,
          `${col} contains a curly quote, unicode dash or non-breaking space: ${JSON.stringify(s)}. ` +
          `It will not match its straight-character twin; normalise to ASCII.`, `/${col}`));
    }
  });

  // Ids that differ only after unicode normalisation (curly vs straight
  // apostrophe, en-dash vs hyphen) — each such pair is one real record and one
  // orphan that joins to nothing.
  const canon = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/ /g, " ");
  const keyCols: [keyof typeof idOf, string][] = [["events", "olympic_event_id"], ["comps", "competition_id"], ["links", "link_id"], ["rank", "ranking_id"], ["cuts", "cut_line_id"], ["fixtures", "fixture_id"]];
  for (const [tab, col] of keyCols) {
    const byCanon: Record<string, string[]> = {};
    for (const row of (ds as any)[tab] as Row[]) {
      const v = row[col];
      if (v == null) continue;
      (byCanon[canon(String(v))] ||= []).push(String(v));
    }
    for (const [c, ids] of Object.entries(byCanon))
      if (new Set(ids).size > 1)
        out.push(finding("WARN", "hygiene/id-unicode-twins", ds.sheetNameOf[tab], ids.join(" vs "),
          `${col} values differ only by curly/straight punctuation: ${ids.map(i => JSON.stringify(i)).join(", ")}. Unify them.`));
  }

  return out;
};
