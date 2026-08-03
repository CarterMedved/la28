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

/**
 * No formulas in the published workbook (docs/stage-four.md, 3 Aug 2026):
 * a Google Sheet RECALCULATES on import, so any formula is live data that
 * mutates outside the gate — the sheet stores declared facts, code derives
 * everything else. Measured on v21's upload: 461 formula cells in three
 * self-check columns, 288 with silently drifted row references, 238
 * evaluating "OK" against the WRONG row. Their intents were already
 * covered by tested rules (referential/fixtures-competition_id,
 * referential/links-from_id/-to_id, arithmetic/berth-sum). ERROR,
 * aggregate: one formula anywhere makes the workbook unfit to publish.
 */
/**
 * Best-effort net for the stale-prose failure (cri-007 said "ranked 20th"
 * while Standings said 19 and the app derived 19): a rank ordinal or a
 * rating margin typed into prose duplicates Standings and goes stale
 * silently. Fields carrying a DATED ANCHOR ("On the 25 Jul 2026 table…",
 * "13th on 30 Jun") are exempt — a snapshot that states its own staleness
 * is the approved pattern (cri-001). Rule constants ("top 15", "rank 15 or
 * better") are deliberately NOT matched: the net is ordinals plus
 * "N rating point(s)" (digits or words), which is why this is best-effort,
 * never proof of cleanliness. WARN, aggregate.
 *
 * TABLE ANCHORS ARE DATE-CHECKED: "On the 25 Jul 2026 table" on a women's
 * cut whose Standings are as_of 2026-08-01 certifies a stale number — worse
 * than no anchor. The anchor cannot be derived into the cell (that would be
 * a formula, banned by hygiene/formula-cells), so a human types it and this
 * rule verifies it: the row resolves to a ranking (cuts.ranking_id; links
 * via gate_ranking_id, else cut_line_id → cut), and the anchor date must
 * equal that ranking's unique Standings as_of. Non-table anchors ("13th on
 * 30 Jun, the window's first day" — a historical claim, not a current-table
 * snapshot) still exempt the field but are not as_of-checked. Rows that
 * resolve to no ranking, or to standings without a single as_of, are not
 * checkable — a limitation, not a pass.
 */
export const proseUnanchoredSnapshot: Rule = ({ ds }) => {
  const ORD = /\b\d{1,2}(?:st|nd|rd|th)\b/g;
  const RATING = /\b(?:\d+|(?:twenty|thirty|forty|fifty)(?:-\w+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\s+rating\s+points?\b/gi;
  const ANCHOR = /\bon\s+(?:the\s+)?\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?\b/i;
  const TABLE_ANCHOR = /\bon the (\d{1,2}) ([A-Za-z]{3,9}) (\d{4}) table\b/gi;
  const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

  const cutRanking: Record<string, string> = {};
  for (const c of ds.cuts) if (c.cut_line_id != null && c.ranking_id != null)
    cutRanking[String(c.cut_line_id)] = String(c.ranking_id);
  const asOf: Record<string, Set<string>> = {};
  for (const s of ds.standings) if (s.ranking_id != null && s.as_of != null)
    (asOf[String(s.ranking_id)] ??= new Set()).add(String(s.as_of).slice(0, 10));
  const rankingOf = (tab: string, row: Record<string, unknown>): string | null => {
    if (tab === "cuts") return row.ranking_id == null ? null : String(row.ranking_id);
    if (tab === "links") return row.gate_ranking_id != null ? String(row.gate_ranking_id)
      : row.cut_line_id != null ? cutRanking[String(row.cut_line_id)] ?? null : null;
    if (tab === "qualified") return row.qualified_via != null && asOf[String(row.qualified_via)] ? String(row.qualified_via) : null;
    return null;
  };

  const FIELDS: [keyof typeof idOf, Row[], string[]][] = [
    ["links", ds.links, ["criterion", "eligibility_note", "entry_condition", "berth_math", "qualifiers_note", "notes"]],
    ["cuts", ds.cuts, ["name", "label", "notes"]],
    ["qualified", ds.qualified, ["notes"]],
  ];
  const hits: string[] = [];
  for (const [tab, rows, cols] of FIELDS)
    for (const row of rows)
      for (const c of cols) {
        const v = (row as Record<string, unknown>)[c];
        if (v == null || typeof v !== "string") continue;
        // Table anchors first: a wrong-dated anchor is its own finding and
        // must not buy the field an exemption.
        let anchorWrong = false;
        for (const m of v.matchAll(TABLE_ANCHOR)) {
          const iso = `${m[3]}-${MONTHS[m[2].slice(0, 3).toLowerCase()] ?? "??"}-${m[1].padStart(2, "0")}`;
          const rid = rankingOf(tab, row as Record<string, unknown>);
          const known = rid ? asOf[rid] : undefined;
          if (known && known.size === 1 && !known.has(iso)) {
            anchorWrong = true;
            hits.push(`${String(idOf[tab](row as never))}·${c}: table anchor "${m[0]}" but ${rid} standings are as_of ${[...known][0]}`);
          }
        }
        if (anchorWrong) continue;              // already reported; don't double-list its ordinals
        if (ANCHOR.test(v)) continue;
        const found = [...v.matchAll(ORD), ...v.matchAll(RATING)].map(m => m[0]);
        if (found.length) hits.push(`${String(idOf[tab](row as never))}·${c}: [${found.join(", ")}]`);
      }
  if (!hits.length) return [];
  return [finding("WARN", "hygiene/prose-unanchored-snapshot", ds.sheetNameOf.links, "(aggregate)",
    `${hits.length} prose field(s) carry a rank ordinal or rating margin with no dated anchor, or a table ` +
    `anchor whose date does not match the ranking's Standings as_of. A number typed into prose duplicates ` +
    `Standings and goes stale silently (cri-007 said 20th while Standings said 19); a wrong-dated anchor is ` +
    `worse — it certifies the stale number. Either remove it (the app derives positions) or anchor it ` +
    `("On the <as_of date> table: …"). Best-effort net — rule constants like "top 15" are not matched:\n      ${hits.join("\n      ")}`)];
};

/**
 * Cross-database superlatives are the permanently read-it-yourself class
 * (HANDOFF, "prose claims about derived quantities"): "tightest margin
 * anywhere in this database" was jointly held, not tightest; "harshest
 * conversion rate in the database" was false with cricket the
 * counterexample. No module derives cross-database comparisons, so this
 * lint VERIFIES NOTHING — it matches the superlative shape ("-est … in
 * the/this database | anywhere | of any") and forces a human read. Scoped
 * comparatives ("harshest of the four FOQTs") carry no marker and pass;
 * that is the boundary of best-effort, not an endorsement.
 */
export const proseSuperlative: Rule = ({ ds }) => {
  const RX = /\b(\w+est)\b[^.!?]{0,60}?\b(in\s+th(?:e|is)\s+database|anywhere|of\s+any)\b/gi;
  const NOT_SUPERLATIVE = /^(west|test|rest|contest|interest|latest)$/i;   // "latest" = temporal, not comparative
  const TABS: (keyof typeof idOf)[] = ["links", "cuts", "qualified", "rank", "comps"];
  const hits: string[] = [];
  for (const tab of TABS)
    for (const row of (ds as unknown as Record<string, Record<string, unknown>[]>)[tab])
      for (const [c, v] of Object.entries(row)) {
        if (typeof v !== "string") continue;
        for (const m of v.matchAll(RX)) {
          if (NOT_SUPERLATIVE.test(m[1])) continue;
          hits.push(`${tab}·${String(idOf[tab](row as never))}·${c}: "…${m[0].slice(0, 70)}…"`);
        }
      }
  if (!hits.length) return [];
  return [finding("WARN", "hygiene/prose-superlative", ds.sheetNameOf.links, "(aggregate)",
    `${hits.length} cross-database superlative(s) in prose. NO MODULE VERIFIES THESE — this rule matched a ` +
    `text shape, nothing more; it cannot judge truth, and scoped comparatives pass it unseen. Each match ` +
    `needs a human read: evidence it, date-anchor it, or delete it. The class has produced real errors ` +
    `("tightest anywhere" was jointly held; "harshest in the database" was false):\n      ${hits.join("\n      ")}`)];
};

export const formulaCellsRule: Rule = ({ ds }) => {
  if (!ds.formulaCells?.length) return [];
  const byTab: Record<string, string[]> = {};
  for (const f of ds.formulaCells) (byTab[f.tab] ||= []).push(f.cell);
  const lines = Object.entries(byTab).map(([t, cells]) =>
    `${t}: ${cells.length} (${cells.slice(0, 5).join(", ")}${cells.length > 5 ? ", …" : ""})`);
  const sample = ds.formulaCells[0];
  return [finding("ERROR", "hygiene/formula-cells", sample.tab, "(aggregate)",
    `${ds.formulaCells.length} formula cell(s) in the workbook. A Sheet recalculates on import — formulas are ` +
    `live data mutating outside the gate; store declared facts, derive in the validator (docs/stage-four.md). ` +
    `Delete them (e.g. [${sample.cell}]=${sample.formula.slice(0, 60)}):\n      ${lines.join("\n      ")}`)];
};
