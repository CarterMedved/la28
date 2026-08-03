/**
 * Stage-four step 3: the pull gate (docs/stage-four.md §2, "the diff has
 * teeth"). Classifies every change between the last-published workbook and
 * the freshly pulled one as ROUTINE (flows through) or GATED (requires a
 * committed acknowledgment), and FAILS THE RUN on any gated change whose
 * digest is not in the ack file.
 *
 * Classification, exactly as agreed:
 *  - Links, Cut_Lines, Olympic_Events, Ranking_Systems: gated in full.
 *  - Competitions: column grain — start_date, end_date, date_confidence,
 *    status, notes are routine; every other column (format, confederation,
 *    teams_count, anything unlisted) is gated. Row additions are gated: a
 *    new competition row carries gated-column content by construction.
 *  - Standings, Fixtures, Qualified, README: routine (edits and additions).
 *  - Row DELETIONS are gated on EVERY tab — a deletion removes evidence,
 *    and absence is invisible to most rules (validated presence vs
 *    unvalidated absence).
 *  - Schema changes (col-add/col-del/tab-add/tab-del) are gated everywhere:
 *    the Competitions "any column addition" reasoning generalises, and an
 *    unlisted new column must fail closed, not default to routine.
 *  - Unknown tab: gated (fail closed).
 *
 * Ack digest: sha256 over the sorted gated-change signatures, each
 * "sheet·key·col·kind·OLD:…·NEW:…" — old value included so a C→B change
 * can never ride an acked A→B ack. Acks live in pull-acks.json
 * (append-only, no expiry); a matched ack is NAMED in the output.
 *
 * Usage: node tools/pull-gate.mjs <last-published.xlsx> <pulled.xlsx>
 *        [--acks pull-acks.json] [--json gate-report.json]
 * Exit 0: no gated changes, or all gated changes acked. Exit 1: unacked
 * gated changes — the run must publish nothing.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { snapshot, diffSnapshots, tzCouplingViolations } from "./wbdiff.mjs";

const GATED_TABS = new Set(["Olympic_Events", "Links", "Ranking_Systems", "Cut_Lines"]);
const ROUTINE_TABS = new Set(["Standings", "Fixtures", "Qualified", "README"]);
const COMPETITIONS_ROUTINE_COLS = new Set(["start_date", "end_date", "date_confidence", "status", "notes"]);
const SCHEMA_KINDS = new Set(["col-add", "col-del", "tab-add", "tab-del"]);

export function classify(ch) {
  if (ch.kind === "row-del" || SCHEMA_KINDS.has(ch.kind)) return "gated";
  if (GATED_TABS.has(ch.sheet)) return "gated";
  if (ch.sheet === "Competitions") {
    if (ch.kind === "row-add") return "gated";
    return COMPETITIONS_ROUTINE_COLS.has(ch.col) ? "routine" : "gated";
  }
  if (ROUTINE_TABS.has(ch.sheet)) return "routine";
  return "gated";
}

export const signature = ch =>
  `${ch.sheet}·${ch.key}·${ch.col ?? ""}·${ch.kind}·OLD:${ch.old ?? "∅"}·NEW:${ch.new ?? "∅"}`;

export const digestOf = sigs =>
  createHash("sha256").update([...sigs].sort().join("\n")).digest("hex");

export async function gate(prevPath, pulledPath, acksPath) {
  const [A, B] = [await snapshot(prevPath, { dateRender: "full" }),
                  await snapshot(pulledPath, { dateRender: "full" })];
  const changes = diffSnapshots(A, B);
  // Coupling refusal comes BEFORE the ack lookup: a tz changed under a stale
  // marker is incoherent, not sensitive — no digest may bless it.
  const refused = tzCouplingViolations(changes);
  if (refused.length) return { ok: false, refused, routine: 0, gated: [], digest: null, matched_ack: null };
  const gated = changes.filter(c => classify(c) === "gated");
  const routine = changes.length - gated.length;
  if (!gated.length) return { ok: true, routine, gated: [], digest: null, matched_ack: null };

  const digest = digestOf(gated.map(signature));
  const acks = acksPath && existsSync(acksPath)
    ? JSON.parse(readFileSync(acksPath, "utf8")).acks ?? [] : [];
  const matched = acks.find(a => a.digest === digest) ?? null;
  return { ok: !!matched, routine, gated: gated.map(c => ({ ...c, signature: signature(c) })), digest, matched_ack: matched };
}

// CLI
if (process.argv[1]?.endsWith("pull-gate.mjs")) {
  const args = process.argv.slice(2);
  const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const [prev, pulled] = args.filter(a => !a.startsWith("--") && a.endsWith(".xlsx"));
  if (!prev || !pulled) {
    console.error("usage: node tools/pull-gate.mjs <last-published.xlsx> <pulled.xlsx> [--acks pull-acks.json] [--json out.json]");
    process.exit(2);
  }
  const res = await gate(prev, pulled, flag("--acks") ?? "pull-acks.json");
  if (flag("--json")) writeFileSync(flag("--json"), JSON.stringify(res, null, 2));

  if (res.refused?.length) {
    console.log("GATE REFUSED (not acknowledgeable): tz changed with tz_source untouched —");
    console.log("an old provenance marker would describe a value it was never written about.");
    for (const v of res.refused) console.log("  " + v);
    console.log("Fix the sheet: re-establish tz_source on those rows in the same edit.");
    process.exit(1);
  }
  console.log(`routine changes (flow through): ${res.routine}`);
  console.log(`gated changes: ${res.gated.length}`);
  if (!res.gated.length) { console.log("GATE PASS — no gated changes."); process.exit(0); }
  for (const g of res.gated) console.log(`  ${g.signature}`);
  console.log(`digest: ${res.digest}`);
  if (res.matched_ack) {
    console.log(`GATE PASS — acknowledged: "${res.matched_ack.note}" (${res.matched_ack.date})`);
    process.exit(0);
  }
  console.log("GATE FAIL — gated changes have no acknowledgment. Publishing nothing; the last");
  console.log("published artefact stands. To release: review the changes above, then commit to");
  console.log(`pull-acks.json: { "digest": "${res.digest}", "note": "<what and why>", "date": "<today>" }`);
  process.exit(1);
}
