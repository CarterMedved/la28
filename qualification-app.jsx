import React, { useState, useEffect, useMemo, useRef } from "react";
import * as XLSX from "xlsx";
import Papa from "papaparse";
import { teamKey } from "./src/lib/normalise.ts";
import { computeThresholds, derivePoolExclusions } from "./src/lib/thresholds.ts";
import { deriveQualification } from "./src/lib/qualified.ts";
import { buildPlacementContext, placementVerdict } from "./src/lib/placement.ts";

const C = {
  paper: "#EDF0F3", card: "#FFFFFF", ink: "#14202B", muted: "#5F7183",
  rule: "#D2DAE2", brass: "#9A6F30", live: "#147D5C", fault: "#B3372F", open: "#A8761A",
  rank: "#3D6B8F",
};
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "'IBM Plex Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";
const STORE_KEY = "la28-dataset-v1";

/* ------------------------------------------------------------------ *
 *  DATA LAYER — the sheet is the source of truth, nothing is baked in
 * ------------------------------------------------------------------ */

const SHEETS = {
  events:    { names: ["Olympic_Events", "olympic_events", "Events"],   key: "olympic_event_id", required: true },
  comps:     { names: ["Competitions", "competitions"],                 key: "competition_id",   required: true },
  links:     { names: ["Links", "links"],                               key: "link_id",          required: true },
  rank:      { names: ["Ranking_Systems", "ranking_systems", "Rankings"], key: "ranking_id",     required: false },
  standings: { names: ["Standings", "standings"],                       key: null,               required: false },
  cuts:      { names: ["Cut_Lines", "cut_lines", "Cutlines"],           key: "cut_line_id",      required: false },
  fixtures:  { names: ["Fixtures", "fixtures"],                         key: "fixture_id",       required: false },
  qualified: { names: ["Qualified", "qualified"],                       key: null,               required: false },
};

const REQUIRED_COLS = {
  events: ["olympic_event_id", "quota_total"],
  comps:  ["competition_id", "name"],
  links:  ["from_id", "to_id", "relationship"],
};

const norm = (h) => String(h ?? "").trim().toLowerCase().replace(/[\s\-]+/g, "_").replace(/[^\w]/g, "");
const NUMERIC = new Set(["berths", "qualifiers", "quota_total", "cascade_order", "rank", "rating",
                         "matches", "points", "n", "teams_count"]);

function cleanCell(key, v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date && !isNaN(v)) return v;
  const s = String(v).trim();
  if (!s || ["nan", "nat", "none", "null", "#n/a"].includes(s.toLowerCase())) return null;
  if (NUMERIC.has(key)) { const n = Number(s); return Number.isFinite(n) ? n : null; }
  return s;
}

function rowsToObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const head = rows[0].map(norm);
  return rows.slice(1)
    .filter(r => r.some(c => c !== null && c !== undefined && String(c).trim() !== ""))
    .map(r => {
      const o = {};
      head.forEach((h, i) => { if (h) o[h] = cleanCell(h, r[i]); });
      return o;
    });
}

const pad = (n) => String(n).padStart(2, "0");
function toStamp(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date && !isNaN(v))
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}`;
  const s = String(v).trim();
  // Hour group is \d{1,2}: the loader's numFmt renders single-digit hours
  // ("2026-02-05 8:00:00"), and the padded stamp is load-bearing — fxByComp
  // orders by localeCompare on it, where unpadded "8:00" sorts after "10:00".
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) return `${m[1]} ${pad(m[2] ?? 0)}:${m[3] ?? "00"}`;
  if (/^\d+(\.\d+)?$/.test(s)) {                       // Excel serial
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    if (!isNaN(d)) return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const dayOf = (v) => { const t = toStamp(v); return t ? t.slice(0, 10) : null; };

/** Shape whatever came out of the sheet into what the views expect, and report every problem found. */
function normalise(raw) {
  const problems = [];
  const out = { events: [], comps: [], links: [], rank: [], standings: [], cuts: [], fx: [] };

  Object.entries(SHEETS).forEach(([k, spec]) => {
    if (!raw[k] && spec.required) problems.push({ level: "fatal", msg: `Missing required sheet: ${spec.names[0]}` });
  });
  if (problems.some(p => p.level === "fatal")) return { data: null, problems };

  Object.entries(REQUIRED_COLS).forEach(([k, cols]) => {
    const first = (raw[k] || [])[0] || {};
    cols.forEach(c => { if (!(c in first)) problems.push({ level: "fatal", msg: `Sheet "${SHEETS[k].names[0]}" has no "${c}" column` }); });
  });
  if (problems.some(p => p.level === "fatal")) return { data: null, problems };

  out.events = (raw.events || []).filter(r => r.olympic_event_id);
  out.comps  = (raw.comps  || []).filter(r => r.competition_id).map(r => ({
    ...r, start_date: dayOf(r.start_date), end_date: dayOf(r.end_date) }));
  out.links  = (raw.links  || []).filter(r => r.from_id && r.to_id)
    .map((r, i) => ({ ...r, link_id: r.link_id || `lnk-${i}` }));
  out.rank   = (raw.rank   || []).filter(r => r.ranking_id);
  out.cuts   = (raw.cuts   || []).filter(r => r.ranking_id);
  out.qualified = (raw.qualified || []).filter(r => r.olympic_event_id && r.team);
  // Qualified is the single source for settled berths: already_qualified and
  // qualified_via are derived from it per managed event (src/lib/qualified.ts),
  // never read from Standings where a Qualified row governs the event.
  out.standings = deriveQualification(
    (raw.standings || []).filter(r => r.ranking_id && r.team),
    out.qualified, out.rank,
    new Set(out.events.map(e => String(e.olympic_event_id))));
  // Undated rows are kept: a fixture with no date is real (unscheduled
  // knockout, unconfirmed leg) and dropping it made the app disagree with
  // the sheet — 303 vs 313 — and starved the placement context of stages.
  // Consumers must treat f[1] === null as "date unconfirmed", never as 1970.
  out.fx = (raw.fixtures || []).filter(r => r.competition_id)
    .map(r => [r.competition_id, toStamp(r.date), r.team1 ?? null, r.team2 ?? null,
               r.stage ?? null, r.stage_source ?? null, r.tz ?? null]);

  // --- integrity checks, surfaced rather than swallowed ---
  const ids = new Set([...out.comps.map(c => c.competition_id), ...out.events.map(e => e.olympic_event_id),
                       ...out.rank.map(r => r.ranking_id), "HOST_USA", "TRIPARTITE"]);
  out.links.forEach(l => {
    if (!ids.has(l.from_id)) problems.push({ level: "error", msg: `Link ${l.link_id}: from_id "${l.from_id}" matches nothing` });
    if (!ids.has(l.to_id))   problems.push({ level: "error", msg: `Link ${l.link_id}: to_id "${l.to_id}" matches nothing` });
  });
  const inb = {};
  out.links.forEach(l => (inb[l.to_id] ||= []).push(l));
  out.events.forEach(e => {
    const sum = (inb[e.olympic_event_id] || []).reduce((s, l) => s + (Number(l.berths) || 0), 0);
    if (Number(e.quota_total) && sum !== Number(e.quota_total))
      problems.push({ level: "error", msg: `${e.olympic_event_id}: inbound berths total ${sum}, quota_total is ${e.quota_total}` });
  });
  const compIds = new Set(out.comps.map(c => c.competition_id));
  const orphanFx = [...new Set(out.fx.filter(f => !compIds.has(f[0])).map(f => f[0]))];
  orphanFx.forEach(id => problems.push({ level: "warn", msg: `Fixtures reference competition "${id}" which is not in Competitions` }));
  const regional = out.comps.filter(c => !c.confederation);
  if (regional.length) problems.push({ level: "warn",
    msg: `${regional.length} competition(s) have no confederation. Routes through them cannot be region-gated, which can produce impossible pathways.` });

  const dupFx = out.fx.length - new Set(out.fx.map(f => f.join("|"))).size;
  if (dupFx > 0) problems.push({ level: "warn", msg: `${dupFx} duplicate fixture row(s) — identical competition, time and teams` });

  return { data: out, problems };
}

async function parseWorkbook(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { cellDates: true });
  const raw = {};
  Object.entries(SHEETS).forEach(([k, spec]) => {
    const found = wb.SheetNames.find(n => spec.names.some(c => norm(c) === norm(n)));
    if (found) raw[k] = rowsToObjects(XLSX.utils.sheet_to_json(wb.Sheets[found], { header: 1, raw: false, defval: null, cellDates: true }));
  });
  return raw;
}

async function parseCsvFiles(files) {
  const raw = {};
  for (const f of files) {
    const stem = f.name.replace(/\.[^.]+$/, "");
    const hit = Object.entries(SHEETS).find(([, s]) => s.names.some(c => norm(c) === norm(stem)));
    if (!hit) continue;
    const text = await f.text();
    raw[hit[0]] = rowsToObjects(Papa.parse(text.trim(), { skipEmptyLines: true }).data);
  }
  return raw;
}

async function fetchGoogleSheet(urlOrId) {
  const id = urlOrId.match(/\/d\/([a-zA-Z0-9-_]{20,})/)?.[1] || urlOrId.trim();
  if (!id) throw new Error("Could not find a spreadsheet ID in that URL.");
  const raw = {};
  for (const [k, spec] of Object.entries(SHEETS)) {
    for (const name of spec.names) {
      try {
        const res = await fetch(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`);
        if (!res.ok) continue;
        const text = await res.text();
        if (/^\s*</.test(text)) continue;                       // HTML = not shared publicly
        const rows = Papa.parse(text.trim(), { skipEmptyLines: true }).data;
        if (rows.length > 1) { raw[k] = rowsToObjects(rows); break; }
      } catch { /* try the next alias */ }
    }
  }
  if (!Object.keys(raw).length)
    throw new Error("Nothing came back. The sheet must be shared so that anyone with the link can view it.");
  return raw;
}
/**
 * Provenance strip (stage-four step 4, docs/stage-four.md §4): states which
 * source supplied the data as a fact about the LOAD PATH — never only what
 * the artefact says about itself — because a stored dataset outranks the
 * fetched artefact indefinitely and carries no meta.artefact. as-of
 * (reference_date) and generated_at are shown as a pair: as-of alone cannot
 * distinguish "the sheet hasn't changed" from "the pipeline died".
 */
/**
 * Workbook label for provenance surfaces. The CI pipeline pulls to
 * pulled.xlsx, so the published meta has version_label: null — the content
 * hash IS the workbook's identity there (it drives skip/archive/bootstrap),
 * and rendering it beats rendering a null.
 */
const wbLabel = w => w?.version_label
  ?? (w?.content_sha256 ? `content ${w.content_sha256.slice(0, 12)}` : "?");

function Provenance({ meta }) {
  const a = meta?.artefact, v = a?.validator;
  const day = t => (t ? String(t).slice(0, 10) : null);
  let body;
  if (meta?.loadPath === "artefact" && a) {
    body = <>published artefact · workbook {wbLabel(a.workbook)}
      {a.workbook?.sha256 ? ` (${a.workbook.sha256.slice(0, 8)})` : ""} · as of {a.reference_date ?? "?"} ·
      generated {a.generated_at ?? "?"} · validator {v
        ? `${v.error}E/${v.warn}W/${v.info}I${v.suppressed ? ` (+${v.suppressed} suppressed)` : ""}`
        : "summary missing"}{/* Unreachable through the pipeline — the publisher
        refuses a live artefact with fit_to_publish !== true (tools/ci-publish.mjs).
        Defence against a hand-edited or out-of-band artefact only. */}
      {v && v.fit_to_publish !== true ? " · NOT FIT TO PUBLISH" : ""}</>;
  } else if (meta?.loadPath === "stored") {
    body = <>stored dataset (this browser) · originally {meta?.source ?? "unknown"}
      {day(meta?.loadedAt) ? ` · loaded ${day(meta.loadedAt)}` : ""} · no published-artefact metadata —
      validator summary unavailable; Clear and start over (Data view) to fetch the published artefact</>;
  } else if (meta?.loadPath === "dragdrop") {
    body = <>workbook (drag-drop) · {meta?.source ?? "unknown"}
      {day(meta?.loadedAt) ? ` · loaded ${day(meta.loadedAt)}` : ""} · validated in this browser only —
      not the published artefact</>;
  } else {
    body = <>load path unrecorded · {meta?.source ?? "unknown source"}</>;
  }
  return (
    <div style={{ borderTop: `1px solid ${C.rule}`, background: C.paper }}>
      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "6px 22px",
        font: `400 10.5px/1.5 ${MONO}`, color: C.muted, letterSpacing: ".03em" }}>
        source: {body}
      </div>
    </div>
  );
}

// Index builder — extracted from Explorer so the sentence engine, the
// harnesses and the card-model script derive from it without rendering.
// Pure: DATA in, derived index out (no hooks, no component state).
export function buildIndex(DATA) {
  {
    const node = {};
    (DATA.events||[]).forEach(e => node[e.olympic_event_id] = { ...e, kind: "EVENT", label: e.event_name });
    (DATA.comps||[]).forEach(c => node[c.competition_id] = { ...c, kind: "COMP", label: c.name });
    (DATA.rank||[]).forEach(r => node[r.ranking_id] = { ...r, kind: "RANK", label: r.name });
    node["HOST_USA"] = { kind: "ALLOC", label: "Host nation allocation" };
    node["TRIPARTITE"] = { kind: "ALLOC", label: "Tripartite Commission" };

    const inbound = {}, outbound = {};
    (DATA.links||[]).forEach(l => {
      (inbound[l.to_id] ||= []).push(l);
      (outbound[l.from_id] ||= []).push(l);
    });

    // hops = shortest distance to an Olympic quota pool, DERIVED not stored
    const hops = {};
    (DATA.events||[]).forEach(e => hops[e.olympic_event_id] = 0);
    let q = (DATA.events||[]).map(e => e.olympic_event_id), d = 0;
    while (q.length && d < 12) {
      d++;
      const next = [];
      q.forEach(id => (inbound[id] || []).forEach(l => {
        if (hops[l.from_id] === undefined) { hops[l.from_id] = d; next.push(l.from_id); }
      }));
      q = next;
    }

    // window relevance: is a ranking-feeder competition inside the ranking's window?
    const rankById = {};
    (DATA.rank||[]).forEach(r => rankById[r.ranking_id] = r);
    const windowState = {};
    (DATA.links||[]).forEach(l => {
      if (l.relationship !== "RANKING_POINTS") return;
      const rk = rankById[l.to_id], cp = node[l.from_id];
      if (!rk || !cp) return;
      const close = rk.window_end || rk.cutoff_date;
      if (!close || !cp.start_date) { windowState[l.link_id] = "unknown"; return; }
      windowState[l.link_id] =
        cp.start_date > close ? "after" : (cp.end_date || cp.start_date) > close ? "straddles" : "inside";
    });

    const fxCount = {}, fxByComp = {};
    (DATA.fx||[]).forEach(f => {
      fxCount[f[0]] = (fxCount[f[0]] || 0) + 1;
      (fxByComp[f[0]] ||= []).push(f);
    });
    Object.values(fxByComp).forEach(a => a.sort((x, y) => String(x[1]).localeCompare(String(y[1]))));

    // How does this competition reach a berth? Points into a ranking, direct placement, or both.
    const route = {};
    (DATA.comps||[]).forEach(c => {
      const out = outbound[c.competition_id] || [];
      if (!out.length) { route[c.competition_id] = { kind: "NONE" }; return; }
      const rankLinks = out.filter(l => l.relationship === "RANKING_POINTS");
      const rankings = rankLinks.map(l => rankById[l.to_id]).filter(Boolean);
      const kind = rankLinks.length === out.length ? "RANKING"
                 : rankLinks.length === 0 ? "DIRECT" : "BOTH";
      route[c.competition_id] = {
        kind, rankings,
        closes: rankings.map(r => r.window_end || r.cutoff_date).filter(Boolean).sort()[0] || null,
      };
    });

    // Materiality: how close is a team to a cut-line that decides Olympic qualification?
    const standBy = {};                                  // ranking_id -> [rows]
    (DATA.standings || []).forEach(r => (standBy[r.ranking_id] ||= []).push(r));
    // Fixtures name squads ("Sri Lanka Women", "USA U-20"); rankings name nations ("Sri Lanka").
    // The two sides meet on the shared teamKey (src/lib/normalise.ts) — the
    // validator uses the same one, so the app and the gate cannot drift.

    const teamRow = {};                                  // "ranking|teamKey" -> row
    (DATA.standings || []).forEach(r => teamRow[`${r.ranking_id}|${teamKey(r.team)}`] = r);
    const cutsBy = {};
    (DATA.cuts || []).forEach(c => (cutsBy[c.ranking_id] ||= []).push(c));

    // Each ranking is only captured to a certain depth. A cut-line deeper than that cannot be located,
    // and a threshold guessed from a short table lands in the wrong place.
    // Threshold maths lives in src/lib/thresholds.ts, shared with the validator.
    // TOP_N_OF_POOL exclusions (teams that reached a second round) are derived
    // from fixture participation — never stored.
    const poolExclusions = derivePoolExclusions(
      DATA.cuts || [], DATA.links || [],
      (DATA.fx || []).map(f => ({ competition_id: f[0], team1: f[2], team2: f[3], stage: f[4] })),
      teamKey);
    const { thresholds, blocked, capturedDepth } = computeThresholds(cutsBy, standBy, poolExclusions, teamKey);

    // A fixture matters if a participant sits near a threshold and the window is still open.
    const fixtureVerdict = (compId, t1, t2, dateStr) => {
      const rl = (outbound[compId] || []).filter(l => l.relationship === "RANKING_POINTS");
      if (!rl.length) return null;
      const rid = rl[0].to_id, rk = rankById[rid];
      const close = rk?.window_end || rk?.cutoff_date;
      if (close && dateStr && dateStr.slice(0, 10) > close)
        return { level: "none", why: `Played after this ranking closes on ${close}. It cannot affect qualification.`, rid };
      const rows = standBy[rid] || [];
      if (!rows.length)
        return { level: "unknown", why: "No standings captured for this ranking yet.", rid };
      if (!(thresholds[rid] || []).length) {
        const d = capturedDepth[rid] || 0;
        // Three distinct blocks share this branch and must not share an
        // explanation: a threshold beyond the captured depth, a TOP_N_OF_POOL
        // cut whose pool has no derivation basis, and a declared-unsatisfiable
        // allocation (the pool derives; no reading seats its result).
        const unsat = (blocked[rid] || []).filter(b => b.reason === "unsatisfiable");
        if (unsat.length)
          return { level: "unknown", rid, cut: unsat[0].cut,
            why: `${unsat.map(b => b.cut.name).join("; ")}: blocked by a recorded declaration — no reading of the allocation rule seats its own result, so no top-${unsat[0].cut.n ?? "N"} is computed or displayed. Resolves when the source document settles the reading and the block is cleared.` };
        const basis = (blocked[rid] || []).filter(b => b.reason === "basis");
        if (basis.length)
          return { level: "unknown", rid,
            why: `${basis.map(b => b.cut.name).join("; ")}: TOP_N_OF_POOL — the pool cannot be derived because no second-round participation is captured for this ranking's feeders, so the cut is blocked rather than guessed. This is a data gap in Fixtures, not a standings-depth problem.` };
        return { level: "unknown", rid,
          why: `This ranking is only captured to rank ${d}, and every cut-line for it falls deeper than that. A threshold guessed from a short table would land in the wrong place, so no verdict is offered.` };
      }
      const found = [t1, t2].map(t => teamRow[`${rid}|${teamKey(t)}`]).filter(Boolean);
      const missing = [t1, t2].filter(t => t && !teamRow[`${rid}|${teamKey(t)}`]);
      if (missing.length)
        return { level: "unknown", rid,
          why: `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not in the captured table for this ranking, which runs to rank ${capturedDepth[rid] || 0}. Add ${missing.length > 1 ? "them" : "it"} to Standings, or check the name matches.` };
      const th = thresholds[rid] || [];
      const contesting = found.filter(r => r.already_qualified !== "Y");
      if (!contesting.length)
        return { level: "none", rid,
          why: `${found.map(r => r.team).join(" and ")} ${found.length > 1 ? "have" : "has"} already secured a place, so no result here can change who qualifies. ${found.map(r => `${r.team}: ${r.qualified_via || "qualified"}`).join(" \u00b7 ")}` };

      let best = null;
      contesting.forEach(r => th.forEach(t => {
        if (t.appliesTo) {
          const only = String(t.appliesTo).split(",").map(x => teamKey(x.trim()));
          if (!only.includes(teamKey(r.team))) return;   // scoped to another nation
        }
        let gap, label = t.cut.name, at = t.atRank;
        if (t.cut.rule === "TOP_PER_NAMED_CONTINENT") {
          // Only the leader of your own continent takes this place, so measure against that team.
          const leader = (standBy[rid] || [])
            .filter(x => x.continent === r.continent && x.olympic_eligible === "Y")
            .sort((a, b) => a.rank - b.rank)[0];
          if (!leader || leader.team === r.team) return;
          gap = Math.abs((r.rating ?? 0) - (leader.rating ?? 0));
          if (gap > 25) return;                       // not in contention for its own continent
          best = (!best || gap < best.gap) ? { gap, team: r.team, rank: r.rank, rating: r.rating,
            cut: t.cut, atRank: leader.rank, note: `${leader.team} currently leads ${r.continent}` } : best;
          return;
        }
        gap = Math.abs(r.rank - at);
        if (!best || gap < best.gap) best = { gap, team: r.team, rank: r.rank, rating: r.rating, cut: t.cut, atRank: at };
      }));
      if (!best)
        return { level: "low", rid,
          why: `${contesting.map(r => `${r.team} (rank ${r.rank})`).join(" and ")} — neither is near a cut-line that decides qualification.` };
      const edge = (standBy[rid] || []).find(r => r.rank === best.atRank);
      const margin = edge && best.rating != null && edge.rating != null ? Math.abs(best.rating - edge.rating) : null;
      const onOrIn = best.rank <= best.atRank;
      if (best.gap <= 3) {
        const who = edge && edge.team !== best.team
          ? (onOrIn ? `holds the last place, with ${edge.team} (rank ${edge.rank}) the team it must stay ahead of`
                    : `must overtake ${edge.team} (rank ${edge.rank}${edge.rating != null ? `, ${edge.rating}`  : ""})`)
          : "sits on the line";
        return { level: "live", rid, cut: best.cut,
          why: `${best.team} (rank ${best.rank}${best.rating != null ? `, ${best.rating}` : ""}) ${who} for ${best.cut.name.toLowerCase()}` +
               (margin != null ? `. Margin: ${margin} rating point${margin === 1 ? "" : "s"}.` : ".") };
      }
      return { level: "low", rid, cut: best.cut,
        why: `Both teams are clear of every cut-line. The nearest is ${best.cut.name.toLowerCase()} at rank ${best.atRank}; ${best.team} (rank ${best.rank}) is ${best.gap} places away.` };
    };

    const berthSum = {};
    (DATA.events||[]).forEach(e => {
      berthSum[e.olympic_event_id] = (inbound[e.olympic_event_id] || [])
        .reduce((s, l) => s + (Number(l.berths) || 0), 0);
    });

    // Placement verdicts (src/lib/placement.ts, shared with the harnesses):
    // structural, from the link graph and stage labels only — no results, no
    // standings. Coexists with fixtureVerdict; a fixture can carry both.
    const pctx = buildPlacementContext(DATA.links || [], DATA.comps || [], DATA.events || [],
      (DATA.fx || []).map(f => ({ competition_id: f[0], stage: f[4] })));
    const placement = (compId, stage) => placementVerdict(compId, stage, pctx);

    const idx = { node, inbound, outbound, hops, fxCount, fxByComp, berthSum, rankById, windowState, route, standBy, cutsBy, thresholds, blocked, capturedDepth, teamKey, fixtureVerdict, placement };
    idx.cardModel = f => fixtureCardModel(idx, DATA, f);
    return idx;
  }
}

// ---------- fixture-card sentence engine (layer 1 of the card) ----------
// Every slot in every template is a module-derived value: thresholds,
// standings, the link graph, the HOST allocation, and (when filled) the
// structured condition columns. No free text enters a sentence.

// One shared date formatter — deadlines must not render as raw ISO in prose.
export const fmtDay = (iso) => {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso ?? "");
  const M = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${M[Number(m[2])]} ${m[1]}`;
};

/**
 * Contention bands — POLICY, documented in README ("Contention bands").
 * 25 is a CHOSEN coarse number, not a derived one: its entire evidence
 * base is five margins in one sport (cricket T20I) at one date, read off
 * prose judgments the sweep later deleted BECAUSE typed judgments go
 * stale — they locate the number, they cannot justify it. Untested for
 * every other sport; rating scales differ. Refine only when captured
 * rating-volatility history or a per-sport scale note exists (README
 * states the full rationale and the change conditions). Never by feel.
 */
export const CONTENTION = { AT_STAKE_MAX_PLACES: 3, CONTENDING_MAX_RATING: 25 };

// Structured condition vocabulary. UNRECOGNISED VALUES FAIL CLOSED to the
// marker form — the enum will grow with ~46 sports left, and a value the
// template doesn't know must degrade to the conditional marker form,
// never to a flattened sentence.
const KNOWN_TRIGGERS = {
  HOST_WINS: (host) => `if ${host} win the tournament`,
  HOST_IN_SEMIS: (host) => `if ${host} reach the semi-finals`,
};
const KNOWN_RECIPIENTS = {
  RUNNER_UP: { clause: "the berth passes to the losing finalist", definite: true },
  NEXT_ELIGIBLE: { clause: "the berth passes to the next eligible team", definite: true },
  // Which placings convert depends on the draw — deliberately NOT definite:
  // fbl-012 stays marker-form even fully filled, until the draw resolves it.
  OTHER_SEMIFINALISTS: { clause: "which placings convert to berths changes", definite: false },
};

// Two detectors, opposite fail directions, because the two errors differ:
// CONDITIONAL_SHAPE is the FLATTEN GUARD — aggressive by design. Any
// prose on the edge (or conditional-shaped criterion) blocks the
// unconditional sentence; nothing can prove prose is absent rather than
// merely unparsed, so this side over-detects safely.
// CONDITION_ASSERTED is the LABEL GUARD — conservative by design. The
// card asserts "this can change" only on language that STATES a
// condition; firing on a descriptive note ("Two groups of four, league
// format.") would be a FALSE claim — the fbl-013 class. A bare mid-
// sentence "if" is not enough: explanatory prose uses it too ("can
// finish below another and still qualify if it is the top side" —
// bkb-002 explains a rule, changes nothing). The sheet's real
// conditionals announce themselves — CONDITIONAL:, NOT GUARANTEED, NOT
// automatic, Only (live) if, Reduced by N if, sentence-initial If — so
// those anchored forms are what asserts. Prose that is present but not
// asserting yields "quiet": no unconditional sentence, no condition
// label either, the note quoted verbatim in the sheet-text layer.
const CONDITIONAL_SHAPE = /\bshould\b|\bunless\b|\bif\b|\bconditional\b|already qualified|runner[- ]up|\binstead\b|passes to/i;
const CONDITION_ASSERTED = /\bshould\b|\bunless\b|\bconditional\b|passes to|\bwhether\b|not guaranteed|not automatic|\bonly (?:live )?if\b|reduced by \w+ if\b|(?:^|[.:;|] *)if\b/i;

// The recorded rule for a conditional edge — the source prose a reader
// needs to resolve the condition: the entry condition whenever one
// exists, plus whichever other field ASSERTS the condition. Null for
// edges with no asserting prose (descriptive notes stay in the audit
// layer only — they are not rules). `kind` labels what the text IS —
// "entry" (a condition on the route being live at all) vs "rule" —
// because an entry condition and a cut-line mechanism on the same step
// are different rules, and stacking them unlabelled implies one explains
// the other (the cri-020 lesson).
export function recordedRule(edge) {
  const parts = [];
  if (edge?.entry_condition) parts.push(String(edge.entry_condition));
  if (edge?.eligibility_note && CONDITION_ASSERTED.test(String(edge.eligibility_note))) parts.push(String(edge.eligibility_note));
  if (!parts.length && edge?.criterion && CONDITION_ASSERTED.test(String(edge.criterion))) parts.push(String(edge.criterion));
  if (!parts.length) return null;
  const kind = edge?.entry_condition && parts.length === 1 ? "entry" : "rule";
  return { text: parts.join(" "), kind };
}

// Inline-or-fold threshold for a recorded rule, ONE number: 134
// characters — the length of the longest signpost sentence this replaced
// ("A route condition applies on this step: … — the exact rule is in the
// Sheet text."). At or under it, showing the rule can never cost more
// space than pointing at it did. Over it, the rule opens IN PLACE on the
// step it governs. No string may tell the reader to go and find
// something.
export const INLINE_RULE_MAX = 134;

export function conditionState(edge, hostName) {
  const t = edge?.condition_trigger == null ? null : String(edge.condition_trigger).trim().toUpperCase() || null;
  const r = edge?.condition_recipient == null ? null : String(edge.condition_recipient).trim().toUpperCase() || null;
  const prose = !!(edge?.eligibility_note || edge?.entry_condition ||
    CONDITIONAL_SHAPE.test(String(edge?.criterion ?? "")));
  const asserted = CONDITION_ASSERTED.test(
    [edge?.eligibility_note, edge?.entry_condition, edge?.criterion].filter(Boolean).join(" "));
  if (t == null && r == null) return asserted ? { kind: "marker" } : prose ? { kind: "quiet" } : { kind: "none" };
  const trig = t != null ? KNOWN_TRIGGERS[t] : null;
  const rec = r != null ? KNOWN_RECIPIENTS[r] : null;
  if (!trig || !rec) return { kind: "marker" };            // half-filled, garbage, unknown: fail closed
  if (!rec.definite) return { kind: "marker", trigger: trig(hostName ?? "the hosts") };
  return { kind: "structured", clause: `${trig(hostName ?? "the hosts")}, ${rec.clause}`, trigger: t, recipient: r };
}

// EVERY route from a competition to an Olympic event, region-gated (a
// team's confederation is fixed, so a route may never cross into another
// region — without the gate an African qualifier appears to route through
// the Americas, Asia and Europe). ONE definition, used by the layer-3
// trace AND the card's route coverage, so the card can never describe
// a different route set than the trace shows.
export function routesFrom(idx, compId, origin = null, depth = 0, seen = new Set()) {
  const regionOf = (id) => { const c = idx.node[id]?.confederation; return c && c !== "GLOBAL" ? c : null; };
  if (depth > 7) return [];
  const home = origin ?? regionOf(compId);
  const res = [];
  for (const l of (idx.outbound[compId] || [])) {
    const r = regionOf(l.to_id);
    if (home && r && r !== home) continue;
    if (l.to_type === "OLYMPIC_EVENT") { res.push([l]); continue; }
    if (seen.has(l.to_id)) continue;
    routesFrom(idx, l.to_id, home, depth + 1, new Set([...seen, l.to_id]))
      .forEach(rest => res.push([l, ...rest]));
  }
  return res;
}

// Shortest direct (non-ranking) route, taken FROM the same enumeration
// the trace renders — never a separate search. This is what makes the
// conditional edge reachable from the rendered routes by construction:
// the primary path IS one of the rendered routes (an ungated BFS here
// once could, in principle, pick a region-crossing path the gated trace
// would never show). test/sentence.mjs pins the remaining data-shape
// assumption: no competition exceeds the trace's 8-route display cap.
export function shortestDirectRoute(idx, compId) {
  return routesFrom(idx, compId)
    .filter(r => r.every(l => l.relationship !== "RANKING_POINTS"))
    .sort((a, b) => a.length - b.length)[0] ?? null;
}

// Host already inside the field for an event? Derived from the HOST_*
// allocation links, never from prose. Returns a reader name or null.
export function hostInField(idx, eventId) {
  const hostLink = (idx.inbound[eventId] || []).find(l => /^HOST_/.test(String(l.from_id)) && Number(l.berths) > 0);
  if (!hostLink) return null;
  const code = String(hostLink.from_id).replace(/^HOST_/, "");
  return code === "USA" ? "the USA" : code;
}

// Per-team ranking facts against every locatable line of the comp's ranking.
function rankTeamFacts(idx, rid, team) {
  const rows = idx.standBy[rid] || [];
  const r = rows.find(x => idx.teamKey(x.team) === idx.teamKey(team));
  if (!r) return null;
  if (r.already_qualified === "Y") return { team: r.team, state: "qualified" };
  if (r.provisional === "Y") return { team: r.team, state: "holds", rank: r.rank };
  let nearest = null;
  for (const t of (idx.thresholds[rid] || [])) {
    if (t.appliesTo) {
      const only = String(t.appliesTo).split(",").map(x => idx.teamKey(x.trim()));
      if (!only.includes(idx.teamKey(r.team))) continue;
    }
    const edge = rows.find(x => x.rank === t.atRank);
    const gapRating = edge && r.rating != null && edge.rating != null ? Math.abs(r.rating - edge.rating) : null;
    const gapPlaces = Math.abs(r.rank - t.atRank);
    const cand = { cut: t.cut, atRank: t.atRank, edgeTeam: edge?.team ?? null, gapRating, gapPlaces,
      holder: t.cut.rule === "PROVISIONAL_HOLDER" ? edge?.team ?? null : null, inside: r.rank <= t.atRank };
    if (!nearest || (cand.gapRating ?? 1e9) < (nearest.gapRating ?? 1e9)) nearest = cand;
  }
  if (!nearest) return { team: r.team, state: "noline" };
  const band = nearest.gapRating != null
    ? (nearest.gapRating <= CONTENTION.CONTENDING_MAX_RATING ? "contending" : "far")
    : (nearest.gapPlaces <= CONTENTION.AT_STAKE_MAX_PLACES ? "contending" : "far");
  return { team: r.team, state: "chasing", band, ...nearest };
}

const stageNoun = (stage) => /series/i.test(String(stage ?? "")) ? "series"
  : /window|round[- ]robin/i.test(String(stage ?? "")) ? "round" : "game";

const winsToTitle = (stage) => {
  const s = String(stage ?? "").toLowerCase();
  if (/final\b/.test(s) && !/semi|quarter/.test(s)) return 1;
  if (/semi/.test(s)) return 2;
  if (/quarter/.test(s)) return 3;
  if (/round of 16|last 16/.test(s)) return 4;
  return null;
};

/**
 * The card model: sentence (layer 1), how-it-works lines (layer 2), route
 * steps (layer 3 uses the existing trace), verbatim quotes (layer 4).
 * The sentence is assembled ONLY from the fields of `facts` — templates
 * below — so what it derives from is exactly what this function collects.
 */
export function fixtureCardModel(idx, DATA, f) {
  const [compId, date, t1, t2, stage] = [f[0], f[1], f[2], f[3], f[4]];
  const comp = idx.node[compId];
  const route = idx.route[compId] || { kind: "NONE" };
  // Derived sentences live ON the edge they describe (link_id → lines),
  // rendered inside the trace at that step. There is no separate "how it
  // works" section: prose that retypes the trace is repetition, and every
  // derived sentence has an edge (each cut-line is carried by a link —
  // checked 6 Aug 2026 — and conditions sit on their own steps).
  const edgeNotes = {};
  const note = (id, text) => (edgeNotes[id] ??= []).push(text);
  // Cut-line mechanisms, keyed by cut_line_id: they describe the LINE
  // (rendered with the standings read against it), not the edge — an
  // edge can also carry its own entry condition, a different rule.
  const cutNotes = {};
  // A typed category line renders ONLY where the recorded rule is behind
  // a control (or absent): where the rule shows inline it says everything
  // the category line does, concretely, so the category line goes.
  const ruleHidden = (edge) => {
    const r = recordedRule(edge);
    return !r || r.text.length > INLINE_RULE_MAX;
  };
  const quotes = [];
  const qSeen = new Set();
  const pushQuote = (id, field, text) => {
    if (!text || qSeen.has(`${id}|${field}`)) return;
    qSeen.add(`${id}|${field}`);
    quotes.push({ id, field, text: String(text) });
  };

  // ---- ranking side ----
  let rankSentence = null, rankLevel = "none";
  const rid = (route.rankings || []).map(r => r.ranking_id).find(r => (idx.standBy[r] || []).length) ?? null;
  if (rid) {
    const eventId = idx.rankById[rid]?.feeds_id;
    const eventName = idx.node[eventId]?.event_name ?? eventId;
    const facts = [t1, t2].map(t => rankTeamFacts(idx, rid, t)).filter(Boolean);
    const contending = facts.filter(x => x.state === "chasing" && x.band === "contending");
    const far = facts.filter(x => x.state === "chasing" && x.band === "far");
    const qual = facts.filter(x => x.state === "qualified");
    const noun = stageNoun(stage);
    if (contending.length) {
      rankLevel = "live";
      const p = contending.sort((a, b) => (a.gapRating ?? 1e9) - (b.gapRating ?? 1e9))[0];
      const close = fmtDay(p.cut.deadline);
      const main = p.holder
        ? `${p.team} can close on ${p.holder}, who hold the ${eventName} place — ${p.gapRating} rating points, table closes ${close}.`
        : p.inside
          ? `${p.team} holds a qualifying position — ${p.gapRating != null ? `${p.gapRating} rating points clear of the line` : `${p.gapPlaces} places clear of the line`}, table closes ${close}.`
          : `${p.team} is ${p.gapRating != null ? `${p.gapRating} rating points` : `${p.gapPlaces} places`} off the last qualifying position, table closes ${close}.`;
      const rest = [
        ...far.map(x => `${x.team} are too far back for this ${noun} to change their position.`),
        ...qual.map(x => `${x.team} have already qualified.`),
        ...contending.slice(1).map(x => `${x.team} are also in contention, ${x.gapRating} rating points from the line.`),
      ];
      rankSentence = [main, ...rest].join(" ");
      // The ranking MECHANISM describes the cut-line, so it renders WITH
      // the line — above the standings read against it — not as an edge
      // note (the edge may carry its own entry condition, a different
      // rule; cri-020 carries both).
      cutNotes[p.cut.cut_line_id] = p.holder
        ? `The place isn't settled: it belongs to whoever is the highest-ranked team not already qualified when the table closes. This ${noun} moves rating points, not places directly.`
        : `Places go by ranking position when the table closes. This ${noun} moves rating points, not places directly.`;
      const cut = (DATA.cuts || []).find(c => c.cut_line_id === p.cut.cut_line_id);
      pushQuote(p.cut.cut_line_id, "notes", cut?.notes);
    } else if (facts.length) {
      rankSentence = qual.length === facts.length
        ? `${qual.map(x => x.team).join(" and ")} ${qual.length > 1 ? "have" : "has"} already qualified — nothing here changes who goes.`
        : `Neither side is near a qualifying line — this ${stageNoun(stage)} moves ranking points only.`;
    }
  }

  // ---- placement side ----
  let placeSentence = null;
  const path = shortestDirectRoute(idx, compId);
  if (path) {
    const berthEdge = path[path.length - 1];
    const eventName = idx.node[berthEdge.to_id]?.event_name ?? berthEdge.to_id;
    const host = hostInField(idx, berthEdge.to_id);
    const cond = conditionState(berthEdge, host);
    const wins = winsToTitle(stage);
    const downstream = path.length - 1;
    const berthComp = idx.node[berthEdge.from_id]?.label ?? berthEdge.from_id;
    const isGroup = /group|matchday/i.test(String(stage ?? ""));
    for (const l of path) {
      pushQuote(l.link_id, "criterion", l.criterion);
      pushQuote(l.link_id, "entry_condition", l.entry_condition);
      pushQuote(l.link_id, "eligibility_note", l.eligibility_note);
      pushQuote(l.link_id, "berth_math", l.berth_math);
    }
    const condClause = cond.kind === "structured"
      ? ` But ${host} are already in as hosts, so ${cond.clause}.`
      : cond.kind === "marker"
        ? (host ? ` But ${host} are already in as hosts, so who receives it is conditional.`
                : ` Who receives it is conditional.`)
        : "";
    if (wins != null && downstream === 0) {
      placeSentence = `${wins} win${wins === 1 ? "" : "s"} from an Olympic place.` +
        (cond.kind === "none" ? " The tournament winner takes it." : condClause);
    } else if (isGroup && downstream === 0) {
      placeSentence = `Doesn't decide a place by itself — the group sets the knockout bracket, and the title carries ${eventName}'s berth${Number(berthEdge.berths) === 1 ? "" : "s"}.` + condClause;
    } else if (isGroup) {
      placeSentence = `Doesn't decide a place. The group only sets the bracket — berths are ${downstream} round${downstream === 1 ? "" : "s"} away, at ${berthComp}.`;
    } else if (downstream > 0) {
      placeSentence = `Part of a longer road: berths are ${downstream} round${downstream === 1 ? "" : "s"} away, at ${berthComp}.`;
    } else {
      placeSentence = `This competition awards ${eventName}'s place${Number(berthEdge.berths) === 1 ? "" : "s"} directly.` + condClause;
    }
    // Condition TYPE is derived from the graph, never from prose: a
    // condition on a `qualifiers` edge is a ROUTE condition (how many, or
    // which, get through the step); a condition on a `berths` edge is a
    // RECIPIENT condition (who receives the place). berths/qualifiers
    // partition the Links tab — no edge fills both — so the label is a
    // fact of the edge, not a reading of its note. Edges with NEITHER
    // filled (some ADVANCE rows) can't be typed and get the untyped line.
    // Detection uses CONDITION_ASSERTED (the label guard), never the
    // flatten guard: over-claiming "this can change" would be a false
    // statement — the fbl-013 class — so labels fail quiet; the note is
    // still quoted verbatim in the sheet-text layer either way.
    const stepConditional = (l) => l === berthEdge
      ? cond.kind === "marker" || cond.kind === "structured"
      : CONDITION_ASSERTED.test(String(l.eligibility_note ?? "")) ||
        CONDITION_ASSERTED.test(String(l.entry_condition ?? ""));
    for (const l of path.slice(0, -1)) {
      if (!stepConditional(l) || !ruleHidden(l)) continue;
      note(l.link_id, Number(l.qualifiers) > 0
        ? `A route condition applies on this step: how many teams advance through it, or which, can change.`
        : `A condition applies on this step.`);
    }
    if (cond.kind === "structured") note(berthEdge.link_id, `The winner may not receive the berth: ${cond.clause} (structured condition).`);
    if (cond.kind === "marker" && ruleHidden(berthEdge)) note(berthEdge.link_id, Number(berthEdge.berths) > 0
      ? `A recipient condition applies on this step: who receives the place${Number(berthEdge.berths) === 1 ? "" : "s"} can change.`
      : `A condition applies on this step.`);
    // Other direct routes: their conditions render on their own final
    // steps, and their sheet text joins the verbatim layer. Ranking-points
    // routes are the ranking mechanism's territory (its note sits on the
    // cut-carrying edge).
    const otherFinals = new Set();
    for (const r of routesFrom(idx, compId)) {
      if (r.some(l => l.relationship === "RANKING_POINTS")) continue;
      const last = r[r.length - 1];
      if (last.link_id === berthEdge.link_id || otherFinals.has(last.link_id)) continue;
      otherFinals.add(last.link_id);
      const oc = conditionState(last, hostInField(idx, last.to_id));
      if (oc.kind === "structured") note(last.link_id, `The winner may not receive the berth: ${oc.clause} (structured condition).`);
      else if (oc.kind === "marker" && ruleHidden(last)) note(last.link_id, `A recipient condition applies on this step: who receives can change.`);
      for (const l of r) {
        pushQuote(l.link_id, "criterion", l.criterion);
        pushQuote(l.link_id, "entry_condition", l.entry_condition);
        pushQuote(l.link_id, "eligibility_note", l.eligibility_note);
        pushQuote(l.link_id, "berth_math", l.berth_math);
      }
    }
  }

  const sentence = rankSentence && placeSentence ? `${rankSentence} ${placeSentence}`
    : rankSentence ?? placeSentence
    ?? `No qualification route is mapped from this competition yet.`;
  return { sentence, edgeNotes, cutNotes, quotes, rankLevel, compLabel: comp?.label ?? compId, date, teams: [t1, t2], stage };
}

// Is a route IN PLAY for these teams? Judged by the cut-lines its edges
// carry, under the contention band: a route is settled when every reading
// for both teams sits beyond the band (comfortably inside or hopelessly
// out) with nobody provisional. Routes with no cut-lines, or no standings
// for either team, are always shown — absence of data never suppresses.
// This is a RANKING-ONLY test, stated as such: a placement route carries
// nothing derivable that could settle it — the app does not model
// results, and group standings/eliminations are not captured — so a
// placement route can NEVER be suppressed. Do not fake generality here;
// if placement materiality ever becomes derivable, it gets its own test.
export function routeMateriality(idx, DATA, route, teams) {
  const readings = [];
  let anyLive = false, sawTeam = false;
  for (const l of route) {
    if (!l.cut_line_id) continue;
    const rid = l.from_id;
    const th = (idx.thresholds[rid] || []).find(t => t.cut.cut_line_id === l.cut_line_id);
    if (!th) continue;
    const rows = idx.standBy[rid] || [];
    const edge = rows.find(x => x.rank === th.atRank);
    for (const team of (teams || []).filter(Boolean)) {
      const r = rows.find(x => idx.teamKey(x.team) === idx.teamKey(team));
      if (!r) continue;
      if (th.appliesTo) {
        const only = String(th.appliesTo).split(",").map(x => idx.teamKey(x.trim()));
        if (!only.includes(idx.teamKey(r.team))) continue;
      }
      sawTeam = true;
      if (r.provisional === "Y") { anyLive = true; continue; }
      if (r.already_qualified === "Y") { readings.push(`${r.team} has already qualified`); continue; }
      const pts = edge && r.rating != null && edge.rating != null ? Math.abs(r.rating - edge.rating) : null;
      const places = Math.abs(r.rank - th.atRank);
      const contending = pts != null ? pts <= CONTENTION.CONTENDING_MAX_RATING : places <= CONTENTION.AT_STAKE_MAX_PLACES;
      if (contending) { anyLive = true; continue; }
      const inside = r.rank <= th.atRank;
      readings.push(`${r.team} is ${pts != null ? `${pts} rating points` : `${places} places`} ${inside ? "clear of" : "short of"} this line`);
    }
  }
  if (anyLive || !sawTeam || !readings.length) return { inPlay: true };
  return { inPlay: false, reason: readings.join("; ") };
}

// What a route's header must say: how many places, decided where, and —
// when a cut-line governs it — WHICH line, by the cut's own name.
export function routeHeader(idx, DATA, route) {
  const last = route[route.length - 1];
  const dest = idx.node[last.from_id]?.label ?? last.from_id;
  const n = last.relationship === "REALLOCATION" ? "a reallocated place"
    : Number(last.berths) > 0 ? `${last.berths} place${Number(last.berths) === 1 ? "" : "s"}` : "a place";
  const cutEdge = [...route].reverse().find(l => l.cut_line_id);
  const cutName = cutEdge ? (DATA.cuts || []).find(c => c.cut_line_id === cutEdge.cut_line_id)?.name : null;
  return `${n} decided at ${dest}${cutName ? ` · ${cutName}` : ""}`;
}

function Explorer({ data, meta, problems, onReset, onLoad, busy }) {
  const DATA = data;
  const [view, setView] = useState("pathway");
  const [sel, setSel] = useState(() => (data.events?.[0]?.olympic_event_id) ?? null);
  const [openNote, setOpenNote] = useState(null);
  const [openComp, setOpenComp] = useState(null);
  const [sportFilter, setSportFilter] = useState("All");
  const [calMode, setCalMode] = useState("events");
  const [openFx, setOpenFx] = useState(null);
  // Evidence mode (global audit toggle): expands every "rules as recorded
  // (verbatim)" layer and reveals the internal verdict blocks on cards.
  const [evidence, setEvidence] = useState(false);

  const idx = useMemo(() => buildIndex(DATA), [DATA]);

  const orphans = (DATA.comps||[]).filter(c => !(idx.outbound[c.competition_id] || []).length);
  const linked = (DATA.comps||[]).length - orphans.length;

  // "2026-07-29 21:00" -> { day, time, known }. Midnight in the source means no time was recorded.
  const parseWhen = (v) => {
    const str = String(v || "");
    const [day, time] = str.split(" ");
    return { day: day || "", time: time || "", known: !!time && time !== "00:00" };
  };
  // Stored times are as displayed by each row's ENTRY SOURCE — measured
  // consistent with US Eastern throughout, NOT venue-local match times
  // (docs/timezones.md, measured correction). zone is Fixtures.tz — an IANA
  // declaration of what zone the stored time is in, never a conversion.
  // Three cases: declared → short zone name ("EDT");
  // undeclared → "·?" so a bare time can never be mistaken for a zone the
  // viewer assumes (the 5-vs-6 Aug re-entry hazard); no time → "—".
  const zoneAbbrev = (zone, day) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
        .formatToParts(new Date((day || "2028-07-14") + "T12:00:00Z"))
        .find(p => p.type === "timeZoneName")?.value ?? zone;
    } catch { return zone; }   // unrecognised zone string: show it verbatim, never hide it
  };
  // Two marks, one register, defined once in the Calendar legend:
  // "·?" = time as entered, zone unverified; "—" = no time recorded.
  // ("TBC" implied a confirmation is coming, which no data tracks.)
  const Time = ({ value, zone, width = 52 }) => {
    const { day, time, known } = parseWhen(value);
    return (
      <span style={{ font: `500 11.5px/1 ${MONO}`, width, flexShrink: 0, color: known ? C.ink : C.muted }}>
        {known ? time : "—"}
        {known && <span style={{ font: `400 9px/1 ${MONO}`, color: C.muted, marginLeft: 4 }}>
          {zone ? zoneAbbrev(zone, day) : "·?"}</span>}
      </span>
    );
  };
  const DayLabel = (d) => {
    const dt = new Date(d + "T12:00:00");
    return isNaN(dt) ? d : dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  };

  // Every outbound link becomes an explicit chip: what is at stake, and how much of it.
  const Stakes = ({ compId, showHops = true }) => {
    const out = idx.outbound[compId] || [];
    const h = idx.hops[compId];
    if (!out.length) return <Chip tone="fault">no links</Chip>;
    return (
      <>
        {out.map(l => {
          const tgt = idx.node[l.to_id];
          const name = tgt?.label || l.to_id;
          const n = l.qualifiers;
          if (l.relationship === "RANKING_POINTS") {
            const rk = idx.rankById[l.to_id];
            const close = rk?.window_end || rk?.cutoff_date;
            return <Chip key={l.link_id} tone="rank">
              ranking points → {name.replace(/^ICC |^FIE |^FIBA /, "")}{close ? ` · counts to ${close}` : ""}
            </Chip>;
          }
          if (l.relationship === "RANKING_CONTINGENCY")
            return <Chip key={l.link_id}>replacements only → {name}</Chip>;
          if (l.to_type === "OLYMPIC_EVENT") {
            if (l.relationship === "REALLOCATION")
              return <Chip key={l.link_id} tone="open">reallocated place at LA28</Chip>;
            return <Chip key={l.link_id} tone="live">
              {l.berths ? `${l.berths} ${l.berths === 1 ? "berth" : "berths"} at LA28` : "berth at LA28"}
              {l.relationship === "HOST" ? " (host)" : l.relationship === "PLAYOFF" ? " (play-off)" : ""}
            </Chip>;
          }
          return <Chip key={l.link_id} tone={n ? "open" : "fault"}>
            {n ? `${n} advance` : "count unknown"} → {name.replace(/^20\d\d /, "").replace(/^FIBA |^Two FIBA /, "")}
          </Chip>;
        })}
        {showHops && <Chip>{h === undefined ? "unreachable" : `${h} hops to a berth`}</Chip>}
      </>
    );
  };

  // A team's confederation is fixed, so a route may never cross into another region.
  // Region-gated route enumeration — module-level routesFrom, shared with
  // the card model so the two can never diverge.
  const routesToBerth = (compId) => routesFrom(idx, compId);

  // Match a graph edge back to the cut-line that governs it, so a route can be read
  // from a specific team's position rather than in the abstract.
  const cutFor = (l) => l.cut_line_id ? (DATA.cuts || []).find(c => c.cut_line_id === l.cut_line_id) : null;

  function StepStanding({ link, teams, cutNotes = null }) {
    const c = cutFor(link);
    if (!c || !teams?.length) return null;
    const mech = cutNotes?.[c.cut_line_id] ?? null;
    const rid = link.from_id;
    const th = (idx.thresholds[rid] || []).find(t => t.cut.cut_line_id === c.cut_line_id);
    if (!th) return null;
    let rows = teams.map(t => idx.standBy[rid]?.find(r => idx.teamKey(r.team) === idx.teamKey(t))).filter(Boolean);
    if (c.applies_to) {
      const only = String(c.applies_to).split(",").map(x => idx.teamKey(x.trim()));
      rows = rows.filter(r => only.includes(idx.teamKey(r.team)));
      if (!rows.length) return (
        <div style={{ marginTop: 5, font: `400 11.5px/1.5 ${SANS}`, color: C.muted,
          padding: "6px 9px", background: "#5F718308", borderLeft: `2px solid ${C.rule}`, borderRadius: "0 3px 3px 0" }}>
          This step applies only to {c.applies_to}, so neither team here is affected by it.
        </div>
      );
    }
    if (!rows.length) return null;
    const edge = (idx.standBy[rid] || []).find(r => r.rank === th.atRank);
    return (
      <div style={{ marginTop: 5, display: "grid", gap: 4 }}>
        {/* The cut-line's mechanism, labelled with the line's own name —
            it describes the LINE the readings below are against, and is
            a different rule from any entry condition on the edge above. */}
        {mech && (
          <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.ink,
            padding: "6px 9px", background: "#14507D0C", borderLeft: `2px solid ${C.rank}`, borderRadius: "0 3px 3px 0" }}>
            <span style={{ font: `500 9.5px/1 ${MONO}`, color: C.rank, letterSpacing: ".08em",
              textTransform: "uppercase", display: "block", marginBottom: 3 }}>{c.name}</span>
            {mech}
          </div>
        )}
        {rows.map(r => {
          if (r.already_qualified === "Y")
            return <Line key={r.team} tone="muted" text={`${r.team} has already qualified, so this step no longer applies to them.`} />;
          const inside = r.rank <= th.atRank;
          const places = Math.abs(r.rank - th.atRank);
          const pts = edge && r.rating != null && edge.rating != null ? Math.abs(r.rating - edge.rating) : null;
          if (r.provisional === "Y")
            return <Line key={r.team} tone="open" text={`${r.team} currently HOLDS this place (rank ${r.rank}) but it is not settled until ${c.deadline}.`} />;
          // Tone is governed by the CONTENTION band, both directions:
          // red is for a live chase, not for any team below any line.
          const inBand = pts != null ? pts <= CONTENTION.CONTENDING_MAX_RATING : places <= CONTENTION.AT_STAKE_MAX_PLACES;
          if (inside && !inBand)
            return <Line key={r.team} tone="live" text={`${r.team} is ${r.rank}${nth(r.rank)} — comfortably inside. The cut is at rank ${th.atRank}, ${places} places below, so this step is effectively secure for them${pts != null ? ` (${pts} rating points of cushion)` : ""}.`} />;
          if (inside)
            return <Line key={r.team} tone="open" text={`${r.team} is ${r.rank}${nth(r.rank)} — inside, but only ${places === 0 ? "on" : `${places} place${places === 1 ? "" : "s"} above`} the cut at rank ${th.atRank}${pts != null ? `, a margin of ${pts} rating points` : ""}. Contested.`} />;
          // Red is for data faults only. A team inside the band is the
          // contest worth watching — attention (brass), not alarm, and
          // "chasing", not "OUTSIDE": say what is true and by how much.
          if (inBand)
            return <Line key={r.team} tone="open" text={`${r.team} is ${r.rank}${nth(r.rank)} — chasing this place: ${places} place${places === 1 ? "" : "s"}${pts != null ? ` and ${pts} rating points` : ""} behind ${edge?.team ?? `rank ${th.atRank}`}${edge?.team ? ` at rank ${th.atRank}` : ""}.`} />;
          return <Line key={r.team} tone="muted" text={`${r.team} is ${r.rank}${nth(r.rank)} — ${pts != null ? `${pts} rating points` : `${places} places`} from this line, beyond the contention band. Not in play for them today.`} />;
        })}
      </div>
    );
  }
  const nth = (n) => ["th","st","nd","rd"][(n % 100 - n % 10 !== 10) * 1 && n % 10 < 4 ? n % 10 : 0];
  const Line = ({ tone, text }) => (
    <div style={{ font: `400 11.5px/1.5 ${SANS}`, padding: "6px 9px", borderRadius: "0 3px 3px 0",
      color: tone === "muted" ? C.muted : tone === "live" ? C.live : tone === "fault" ? C.fault : C.open,
      background: tone === "muted" ? "#5F718308" : tone === "live" ? "#147D5C0C" : tone === "fault" ? "#B3372F0C" : "#A8761A0C",
      borderLeft: `2px solid ${tone === "muted" ? C.rule : tone === "live" ? C.live : tone === "fault" ? C.fault : C.open}` }}>
      {text}
    </div>
  );

  // A conditional step CARRIES its rule: inline when the rule is no
  // longer than the signpost it replaced (INLINE_RULE_MAX), otherwise
  // opening in place — never a pointer to somewhere the reader can't go.
  const RecordedRule = ({ rule }) => {
    const [open, setOpen] = useState(false);
    const label = rule.kind === "entry" ? "The entry condition as recorded" : "The rule as recorded";
    if (rule.text.length <= INLINE_RULE_MAX || open) return (
      <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.ink, marginTop: 3,
        padding: "6px 9px", background: "#9A6F300E", borderLeft: `2px solid ${C.brass}`, borderRadius: "0 3px 3px 0" }}>
        <span style={{ font: `500 9.5px/1 ${MONO}`, color: C.brass, letterSpacing: ".08em",
          textTransform: "uppercase", display: "block", marginBottom: 3 }}>{label}</span>
        «{rule.text}»
      </div>
    );
    return (
      <div style={{ marginTop: 3 }}>
        <span role="button" tabIndex={0} onClick={() => setOpen(true)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}
          style={{ color: C.brass, cursor: "pointer", font: `500 11px/1.5 ${MONO}` }}>{label.toLowerCase()} ▸</span>
      </div>
    );
  };

  function PathwayTrace({ compId, teams, quotes = true, notes = null, cutNotes = null }) {
    const routes = routesToBerth(compId).sort((a, b) => a.length - b.length);
    const here = idx.node[compId];
    // Out-of-contention routes collapse to their reason; one click (or
    // evidence mode) restores the full trace.
    const [forcedOpen, setForcedOpen] = useState({});
    if (!routes.length) return <Empty text="No route to an Olympic berth from here yet." />;

    const Node = ({ label, sub, tone }) => (
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", marginTop: 5, flexShrink: 0,
          background: tone === "end" ? C.live : tone === "start" ? C.ink : C.card,
          border: `2px solid ${tone === "end" ? C.live : tone === "rank" ? C.rank : tone === "start" ? C.ink : C.brass}` }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ font: `${tone === "end" ? 600 : 500} 13px/1.35 ${SANS}`,
            color: tone === "end" ? C.live : C.ink }}>{label}</div>
          {sub && <div style={{ font: `400 10.5px/1.3 ${MONO}`, color: C.muted, marginTop: 2 }}>{sub}</div>}
        </div>
      </div>
    );
    const Step = ({ l, teams, quotes = true, notes = null, cutNotes = null }) => {
      const n = l.relationship === "REALLOCATION" ? "reallocated place"
              : l.relationship === "RANKING_CONTINGENCY" ? "replacements only"
              : l.berths ? `${l.berths} berth${l.berths === 1 ? "" : "s"}`
              : l.qualifiers ? `${l.qualifiers} advance`
              : l.relationship === "RANKING_POINTS" ? "rating points"
              : l.qualifiers_note || "count unknown";
      // The prefix is a fact of the RELATIONSHIP, never of entry_condition
      // presence: 43 edges across five relationships carry an
      // entry_condition (the fencing zonal entries, the main FOGQT field),
      // and only REALLOCATION is actually a fallback.
      const prefix = l.relationship === "REALLOCATION" ? "fallback route · "
                   : l.entry_condition ? "conditional entry · " : "";
      return (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "3px 0 3px 0" }}>
          <span style={{ width: 9, flexShrink: 0, display: "flex", justifyContent: "center" }}>
            <span style={{ width: 1, minHeight: 26, background: C.rule }} />
          </span>
          <div style={{ minWidth: 0, paddingLeft: 1 }}>
            <div style={{ font: `500 11px/1.3 ${MONO}`, color: l.entry_condition ? C.open : l.confidence === "AMBIGUOUS" ? C.fault : C.brass }}>
              ↓ {prefix}{n}
            </div>
            {/* Derived sentences that belong to THIS edge — the ranking
                mechanism on its cut-carrying edge, conditions on their
                conditional step. Not sheet text: these render always. */}
            {(notes || []).map((t, i) => (
              <div key={i} style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.ink, marginTop: 3,
                padding: "6px 9px", background: "#14507D0C", borderLeft: `2px solid ${C.rank}`, borderRadius: "0 3px 3px 0" }}>
                {t}
              </div>
            ))}
            {/* Every condition is reachable from the step it governs. When
                the full quote blocks are off (fixture cards), the asserting
                prose renders here — inline or opening in place. */}
            {!quotes && recordedRule(l) && <RecordedRule rule={recordedRule(l)} />}
            {quotes && l.entry_condition && (
              <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.open, marginTop: 3,
                padding: "6px 9px", background: "#A8761A0E", borderLeft: `2px solid ${C.open}`, borderRadius: "0 3px 3px 0" }}>
                {l.entry_condition}
              </div>
            )}
            {quotes && l.eligibility_note && (
              <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.ink, marginTop: 3,
                padding: "6px 9px", background: "#9A6F300E", borderLeft: `2px solid ${C.brass}`, borderRadius: "0 3px 3px 0" }}>
                <span style={{ font: `500 9.5px/1 ${MONO}`, color: C.brass, letterSpacing: ".08em",
                  textTransform: "uppercase", display: "block", marginBottom: 3 }}>Eligibility filter</span>
                {l.eligibility_note}
              </div>
            )}
            <StepStanding link={l} teams={teams} cutNotes={cutNotes} />
            {quotes && l.berth_math && (
              <div style={{ marginTop: 4, padding: "6px 9px", background: "#147D5C0C",
                borderLeft: `2px solid ${C.live}`, borderRadius: "0 3px 3px 0" }}>
                <span style={{ font: `500 9.5px/1 ${MONO}`, color: C.live, letterSpacing: ".08em",
                  textTransform: "uppercase" }}>Why this number</span>
                <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.muted, marginTop: 4 }}>{l.berth_math}</div>
              </div>
            )}
            {quotes && <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.muted, marginTop: 2 }}>{l.criterion}</div>}
            {l.confidence === "AMBIGUOUS" &&
              <div style={{ font: `400 11px/1.4 ${SANS}`, color: C.fault, marginTop: 2 }}>Ambiguous in the source document.</div>}
          </div>
        </div>
      );
    };

    return (
      <div style={{ display: "grid", gap: 12 }}>
        {routes.slice(0, 8).map((r, ri) => {
          // The header states what SEPARATES this route — its final step,
          // and the cut-line's own name where one governs it — BEFORE any
          // per-team line, so "6th — chasing" and "6th — comfortably
          // inside" read as the different lines they are.
          const mat = routeMateriality(idx, DATA, r, teams);
          const open = mat.inPlay || evidence || !!forcedOpen[ri];
          return (
          <div key={ri} style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4, padding: "13px 15px" }}>
            <div style={{ font: `500 10px/1 ${MONO}`, color: C.muted, letterSpacing: ".09em",
              textTransform: "uppercase", marginBottom: open ? 11 : 6 }}>
              {ri === 0 ? "Shortest route" : `Route ${ri + 1}`} — {routeHeader(idx, DATA, r)} · {r.length} step{r.length > 1 ? "s" : ""}
              {r.some(l => l.relationship === "REALLOCATION") ? " · reallocation, not an extra place" : ""}
            </div>
            {!open && (
              <div style={{ font: `400 12px/1.5 ${SANS}`, color: C.muted }}>
                Not in play here — {mat.reason}.{" "}
                <span role="button" tabIndex={0} onClick={() => setForcedOpen({ ...forcedOpen, [ri]: true })}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setForcedOpen({ ...forcedOpen, [ri]: true }); } }}
                  style={{ color: C.brass, cursor: "pointer", font: `500 11px/1.5 ${MONO}` }}>show the trace ▸</span>
              </div>
            )}
            {open && <Node label={here?.label || compId} sub="you are here" tone="start" />}
            {open && r.map((l, i) => {
              const tgt = idx.node[l.to_id];
              const isEnd = l.to_type === "OLYMPIC_EVENT";
              return (
                <React.Fragment key={l.link_id}>
                  <Step l={l} teams={teams} quotes={quotes} notes={notes?.[l.link_id]} cutNotes={cutNotes} />
                  <Node
                    label={tgt?.event_name || tgt?.label || l.to_id}
                    sub={isEnd ? `${tgt?.quota_total} team field` : tgt?.confederation && tgt.confederation !== "GLOBAL" ? tgt.confederation : (tgt?.format || "")}
                    tone={isEnd ? "end" : l.to_type === "RANKING" ? "rank" : undefined} />
                </React.Fragment>
              );
            })}
          </div>
          );
        })}
        {routes.length > 8 && <Chip>+{routes.length - 8} more routes</Chip>}
      </div>
    );
  }

  // Collapsible card layer. Collapsed by default; `open` (evidence mode)
  // forces it open without stealing the local toggle.
  const Fold = ({ label, open, children }) => {
    const [o, setO] = useState(false);
    const isOpen = open || o;
    return (
      <div style={{ marginBottom: 6 }}>
        <button onClick={() => setO(!o)} style={{ font: `500 11px/1 ${MONO}`, color: C.muted,
          letterSpacing: ".06em", background: "none", border: "none", cursor: "pointer", padding: "3px 0" }}>
          {isOpen ? "▾" : "▸"} {label}
        </button>
        {isOpen && (
          <div style={{ padding: "8px 11px", background: C.card, border: `1px solid ${C.rule}`,
            borderRadius: 4, marginTop: 3 }}>{children}</div>
        )}
      </div>
    );
  };

  const Chip = ({ tone, children }) => (
    <span style={{
      font: `500 10px/1 ${MONO}`, letterSpacing: ".06em", textTransform: "uppercase",
      padding: "4px 7px", borderRadius: 3, whiteSpace: "nowrap",
      color: tone === "live" ? C.live : tone === "fault" ? C.fault : tone === "open" ? C.open : tone === "rank" ? C.rank : C.muted,
      background: tone === "live" ? "#147D5C14" : tone === "fault" ? "#B3372F14" : tone === "open" ? "#A8761A14" : tone === "rank" ? "#3D6B8F14" : "#5F718310",
      border: `1px solid ${tone === "live" ? "#147D5C33" : tone === "fault" ? "#B3372F33" : tone === "open" ? "#A8761A33" : tone === "rank" ? "#3D6B8F33" : C.rule}`,
    }}>{children}</span>
  );

  // ---------- PATHWAY: the cascade ladder ----------
  function Pathway() {
    const ev = idx.node[sel];
    if (!ev) return null;
    const stages = [...(idx.inbound[sel] || [])].sort((a, b) => (a.cascade_order || 0) - (b.cascade_order || 0));
    const quota = Number(ev.quota_total) || 0;
    let running = quota;
    const upstream = [...new Set(stages.map(s => s.from_id))]
      .flatMap(id => (idx.inbound[id] || []).map(l => ({ ...l, via: id })));

    return (
      <div>
        <div style={{ borderBottom: `1px solid ${C.rule}`, paddingBottom: 18, marginBottom: 24 }}>
          <div style={{ font: `500 11px/1 ${MONO}`, color: C.muted, letterSpacing: ".1em", textTransform: "uppercase" }}>
            {ev.sport} · {ev.gender === "X" ? "Open" : ev.gender === "M" ? "Men" : "Women"}
          </div>
          <h2 style={{ font: `600 27px/1.15 ${SANS}`, color: C.ink, margin: "8px 0 14px", letterSpacing: "-.02em" }}>
            {ev.event_name}
          </h2>
          <div style={{ display: "flex", gap: 26, alignItems: "baseline", flexWrap: "wrap" }}>
            <div>
              <span style={{ font: `600 30px/1 ${SANS}`, color: C.brass }}>{quota}</span>
              <span style={{ font: `400 11px/1 ${MONO}`, color: C.muted, marginLeft: 7, textTransform: "uppercase", letterSpacing: ".08em" }}>
                {ev.quota_unit} places
              </span>
            </div>
            {idx.berthSum[sel] === quota
              ? <Chip tone="live">berths sum ✓ {idx.berthSum[sel]}/{quota}</Chip>
              : <Chip tone="fault">mismatch {idx.berthSum[sel]}/{quota}</Chip>}
            <Chip>{stages.length} inbound links</Chip>
          </div>
          {ev.notes && <p style={{ font: `400 13px/1.55 ${SANS}`, color: C.muted, margin: "14px 0 0", maxWidth: 700 }}>{ev.notes}</p>}
        </div>

        <SectionLabel n="01" text="Allocation cascade" sub="Resolved top to bottom. Each stage is open only to NOCs not already qualified above it." />

        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", left: 27, top: 10, bottom: 10, width: 1, background: C.rule }} />
          {stages.map((l, i) => {
            const before = running; running -= Number(l.berths) || 0;
            const src = idx.node[l.from_id] || { label: l.from_id, kind: "?" };
            const isOpen = openNote === l.link_id;
            return (
              <div key={l.link_id} style={{ display: "flex", gap: 16, position: "relative", marginBottom: 4 }}>
                <div style={{
                  width: 55, flexShrink: 0, display: "flex", justifyContent: "center",
                  alignItems: "flex-start", paddingTop: 15,
                }}>
                  <div style={{
                    width: 26, height: 26, borderRadius: "50%", background: C.card,
                    border: `1.5px solid ${C.brass}`, display: "grid", placeItems: "center",
                    font: `500 10px/1 ${MONO}`, color: C.brass, zIndex: 1,
                  }}>{l.cascade_order ?? "–"}</div>
                </div>
                <div style={{
                  flex: 1, background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4,
                  padding: "13px 15px", marginBottom: 10,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 14, alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 5 }}>
                        <Chip>{l.relationship}</Chip>
                        <Chip tone={src.kind === "RANK" ? "open" : undefined}>{src.kind}</Chip>
                        {l.gate_ranking_id && <Chip tone="open">conditional on ranking</Chip>}
                        {l.confidence === "AMBIGUOUS" && <Chip tone="fault">ambiguous in source</Chip>}
                        {l.source_ref && <Chip>{l.source_ref}</Chip>}
                      </div>
                      <div style={{ font: `500 14px/1.35 ${SANS}`, color: C.ink }}>{src.label}</div>
                      <div style={{ font: `400 12.5px/1.5 ${SANS}`, color: C.muted, marginTop: 4 }}>{l.criterion}</div>
                      {l.gate_ranking_id && idx.rankById[l.gate_ranking_id] && (
                        <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.open, marginTop: 5 }}>
                          Gated by {idx.rankById[l.gate_ranking_id].name} — this berth only lands if the ranking test is met.
                        </div>
                      )}
                      {l.eligibility_note && (
                        <button onClick={() => setOpenNote(isOpen ? null : l.link_id)}
                          style={{
                            marginTop: 8, font: `400 11px/1 ${MONO}`, color: C.brass, background: "none",
                            border: "none", borderBottom: `1px dotted ${C.brass}`, padding: "0 0 2px", cursor: "pointer",
                          }}>
                          {isOpen ? "hide" : "eligibility filter"}
                        </button>
                      )}
                      {isOpen && (
                        <p style={{
                          font: `400 12px/1.55 ${SANS}`, color: C.ink, margin: "9px 0 0", padding: "9px 11px",
                          background: "#A8761A0E", borderLeft: `2px solid ${C.open}`, borderRadius: "0 3px 3px 0",
                        }}>{l.eligibility_note}</p>
                      )}
                      {l.berth_math && (
                        <div style={{ marginTop: 8, padding: "8px 11px", background: "#147D5C0C",
                          borderLeft: `2px solid ${C.live}`, borderRadius: "0 3px 3px 0" }}>
                          <span style={{ font: `500 9.5px/1 ${MONO}`, color: C.live, letterSpacing: ".08em",
                            textTransform: "uppercase" }}>Why {l.berths}</span>
                          <div style={{ font: `400 12px/1.55 ${SANS}`, color: C.ink, marginTop: 5 }}>{l.berth_math}</div>
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ font: `600 22px/1 ${SANS}`, color: C.brass }}>{l.berths ?? "—"}</div>
                      <div style={{ font: `400 9.5px/1 ${MONO}`, color: C.muted, letterSpacing: ".07em", marginTop: 4 }}>
                        {before} → {running}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{
          marginLeft: 71, marginTop: 2, marginBottom: 34, padding: "11px 15px", borderRadius: 4,
          background: running === 0 ? "#147D5C0E" : "#B3372F0E",
          border: `1px solid ${running === 0 ? "#147D5C33" : "#B3372F33"}`,
          font: `500 12.5px/1 ${MONO}`, color: running === 0 ? C.live : C.fault,
        }}>
          {running === 0 ? "All places allocated. Cascade closes at zero." : `${running} place(s) unaccounted for.`}
        </div>

        {(() => {
          const rk = (DATA.rank||[]).filter(r => r.sport === ev.sport && (r.gender === ev.gender || r.gender === "X")
            && r.selection_rule_type === "CONTINGENCY_ONLY");
          if (!rk.length) return null;
          return (
            <div style={{ marginBottom: 26, padding: "12px 15px", background: C.card,
              border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.rank}`, borderRadius: 4 }}>
              <div style={{ font: `500 11px/1 ${MONO}`, color: C.rank, letterSpacing: ".07em",
                textTransform: "uppercase", marginBottom: 7 }}>No ranking route to this event</div>
              {rk.map(r => (
                <p key={r.ranking_id} style={{ font: `400 12.5px/1.55 ${SANS}`, color: C.muted, margin: 0 }}>
                  The {r.name} exists and is consulted, but only to replace withdrawn teams. No team enters any
                  qualifying tournament for this event on ranking alone, so no fixture reaches a berth via the ranking.
                  {(DATA.rank||[]).some(o => o.sport === r.sport && o.gender !== r.gender && o.selection_rule_type !== "CONTINGENCY_ONLY")
                    ? " The equivalent men's ranking does award entry places — the two are not symmetrical." : ""}
                </p>
              ))}
            </div>
          );
        })()}
        <SectionLabel n="02" text="Upstream" sub="What feeds the sources above. Hop count is derived from the link graph, never typed in." />
        {upstream.length === 0
          ? <Empty text="No upstream links. Add rows to the Links tab pointing at the sources above." />
          : (
            <div style={{ display: "grid", gap: 7 }}>
              {upstream.map(l => {
                const src = idx.node[l.from_id] || { label: l.from_id };
                return (
                  <div key={l.link_id} style={{
                    background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4, padding: "11px 14px",
                    display: "flex", justifyContent: "space-between", gap: 14, alignItems: "center",
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ font: `500 13px/1.3 ${SANS}`, color: C.ink }}>{src.label}</div>
                      <div style={{ font: `400 11px/1.4 ${MONO}`, color: C.muted, marginTop: 3 }}>
                        {l.relationship} → {idx.node[l.via]?.label || l.via}
                      </div>
                    </div>
                    <Chip>{idx.hops[l.from_id] ?? "∞"} hops</Chip>
                  </div>
                );
              })}
            </div>
          )}
      </div>
    );
  }

  // ---------- CALENDAR ----------
  function SportFilter() {
    const sports = ["All", ...[...new Set((DATA.comps||[]).map(c => c.sport).filter(Boolean))].sort()];
    return (
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 16 }}>
        {sports.map(sp => (
          <button key={sp} onClick={() => { setSportFilter(sp); setOpenComp(null); }} style={{
            font: `500 11px/1 ${SANS}`, padding: "7px 11px", borderRadius: 3, cursor: "pointer",
            border: `1px solid ${sportFilter === sp ? C.brass : C.rule}`,
            background: sportFilter === sp ? "#9A6F300E" : C.card,
            color: sportFilter === sp ? C.brass : C.muted,
          }}>{sp}</button>
        ))}
      </div>
    );
  }

  function EventsSection() {
    const rows = DATA.comps
      .filter(c => sportFilter === "All" || c.sport === sportFilter)
      .sort((a, b) => {
        const A = a.start_date && a.start_date !== "None" ? a.start_date : "9999";
        const B = b.start_date && b.start_date !== "None" ? b.start_date : "9999";
        return A.localeCompare(B);
      });
    return (
      <div>
        <SectionLabel n="—" text="Events"
          sub={`${rows.length} competitions and ranking windows, earliest first. Click a row with fixtures to expand it. Red edge = no Links rows, so nothing downstream reaches it.`} />
        <div style={{ display: "grid", gap: 6 }}>
          {rows.map(c => {
            const out = idx.outbound[c.competition_id] || [];
            const fx = idx.fxByComp[c.competition_id] || [];
            const h = idx.hops[c.competition_id];
            const isOpen = openComp === c.competition_id;
            const dated = c.start_date && c.start_date !== "None";
            const st = out.map(l => idx.windowState[l.link_id]).filter(Boolean);
            return (
              <div key={c.competition_id} style={{
                background: C.card, border: `1px solid ${out.length ? C.rule : "#B3372F30"}`,
                borderLeft: `3px solid ${!out.length ? C.fault : idx.route[c.competition_id]?.kind === "RANKING" ? C.rank : C.brass}`,
                borderRadius: 4,
              }}>
                <div
                  onClick={() => fx.length && setOpenComp(isOpen ? null : c.competition_id)}
                  role={fx.length ? "button" : undefined}
                  tabIndex={fx.length ? 0 : undefined}
                  onKeyDown={e => { if (fx.length && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpenComp(isOpen ? null : c.competition_id); } }}
                  style={{ padding: "11px 14px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", cursor: fx.length ? "pointer" : "default" }}>
                  <div style={{ font: `400 11px/1.35 ${MONO}`, color: dated ? C.muted : C.open, width: 88, flexShrink: 0 }}>
                    {dated ? c.start_date : "TBC"}
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ font: `500 13px/1.35 ${SANS}`, color: C.ink }}>{c.name}</div>
                    <div style={{ font: `400 11px/1.4 ${MONO}`, color: C.muted, marginTop: 3 }}>
                      {c.sport}{c.gender && c.gender !== "X" ? ` · ${c.gender}` : ""}
                      {c.format ? ` · ${c.format}` : ""}
                    </div>
                  </div>
                  {c.status === "CONDITIONAL" && <Chip tone="open">may not happen</Chip>}
                  {c.status === "UNANNOUNCED" && <Chip tone="open">date TBC</Chip>}
                  {c.status === "COMPLETE" && <Chip>concluded</Chip>}
                  {st.includes("after") ? <Chip tone="fault">after ranking cutoff</Chip>
                    : st.includes("straddles") ? <Chip tone="open">straddles cutoff</Chip>
                    : st.includes("inside") ? <Chip tone="live">in ranking window</Chip> : null}
                  {fx.length
                    ? <Chip>{isOpen ? "▾" : "▸"} {fx.length} fixtures</Chip>
                    : <Chip>no fixtures</Chip>}
                  <Stakes compId={c.competition_id} />
                </div>
                {isOpen && (
                  <div style={{ borderTop: `1px solid ${C.rule}`, background: C.paper, padding: "4px 14px 10px" }}>
                    {out.length > 0 && (
                      <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.muted, padding: "9px 0", borderBottom: `1px solid ${C.rule}` }}>
                        {idx.route[c.competition_id]?.kind === "RANKING"
                          ? `No fixture here eliminates or advances anyone. Each result moves rating points in: ${out.map(l => idx.node[l.to_id]?.label || l.to_id).join(" · ")}`
                          : `Every fixture below feeds: ${out.map(l => idx.node[l.to_id]?.label || l.to_id).join(" · ")}`}
                      </div>
                    )}
                    {fx.map((f, i) => (
                      <div key={i} style={{ display: "flex", gap: 11, alignItems: "center", padding: "7px 0",
                        borderBottom: i < fx.length - 1 ? `1px solid ${C.rule}` : "none" }}>
                        <span style={{ font: `400 11px/1 ${MONO}`, color: C.muted, width: 78, flexShrink: 0 }}>{parseWhen(f[1]).day}</span>
                        <Time value={f[1]} zone={f[6]} />
                        <span style={{ font: `400 12.5px/1.35 ${SANS}`, color: C.ink, flex: 1, minWidth: 140 }}>
                          {f[2] || "TBD"}{f[3] && f[3] !== "—" ? <span style={{ color: C.muted }}> v {f[3]}</span> : null}
                        </span>
                        {f[4] && <Chip tone={f[5] === "UNKNOWN" ? "fault" : undefined}>{f[4]}</Chip>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function FixturesSection() {
    const compById = {};
    (DATA.comps||[]).forEach(c => compById[c.competition_id] = c);
    const rows = (DATA.fx||[])
      .filter(f => sportFilter === "All" || compById[f[0]]?.sport === sportFilter)
      .slice()
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));

    const dated = rows.filter(f => f[1]);
    const undated = rows.filter(f => !f[1]);
    const days = [];
    dated.forEach(f => {
      const d = parseWhen(f[1]).day;
      if (!days.length || days[days.length - 1].day !== d) days.push({ day: d, items: [] });
      days[days.length - 1].items.push(f);
    });
    const noTime = dated.filter(f => !parseWhen(f[1]).known).length;
    // Per-competition buckets for undated fixtures (sheet order within each).
    const undatedByComp = [];
    undated.forEach(f => {
      const last = undatedByComp[undatedByComp.length - 1];
      if (!last || last.comp !== f[0]) undatedByComp.push({ comp: f[0], items: [f] });
      else last.items.push(f);
    });

    return (
      <div>
        <SectionLabel n="—" text="Fixtures"
          sub={`${dated.length} games across ${days.length} days${undated.length ? `, plus ${undated.length} awaiting dates` : ""}. Open a row for what the game means. Times: "18:30 ·?" is the time as entered from its source with the zone unverified; "—" means no time recorded (${noTime} such). Stages marked DERIVED were inferred from the fixture pattern, not read off an official schedule.`} />
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14, padding: "10px 13px",
          background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4 }}>
          {[[C.rank, "Ranking event — results move rating points, nobody advances"],
            [C.brass, "Direct qualifier — placing awards a berth or advances toward one"],
            [C.fault, "Not linked yet"]].map(([col, label]) => (
            <div key={label} style={{ display: "flex", gap: 7, alignItems: "center" }}>
              <span style={{ width: 3, height: 15, background: col, borderRadius: 1 }} />
              <span style={{ font: `400 11.5px/1.3 ${SANS}`, color: C.muted }}>{label}</span>
            </div>
          ))}
        </div>
        {days.map(({ day, items }) => (
          <div key={day} style={{ marginBottom: 14 }}>
            <div style={{
              position: "sticky", top: 0, zIndex: 2, background: C.paper,
              font: `500 11px/1 ${MONO}`, color: C.brass, letterSpacing: ".07em",
              padding: "7px 0 7px 2px", borderBottom: `1px solid ${C.rule}`, marginBottom: 5,
            }}>{DayLabel(day)}</div>
            <div style={{ display: "grid", gap: 4 }}>
              {items.map((f, i) => <FxRow key={i} f={f} />)}
            </div>
          </div>
        ))}
        {undatedByComp.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{
              position: "sticky", top: 0, zIndex: 2, background: C.paper,
              font: `500 11px/1 ${MONO}`, color: C.open, letterSpacing: ".07em",
              padding: "7px 0 7px 2px", borderBottom: `1px solid ${C.rule}`, marginBottom: 5,
            }}>DATE UNCONFIRMED</div>
            {undatedByComp.map(({ comp, items }) => (
              <div key={comp} style={{ marginBottom: 10 }}>
                <div style={{ font: `400 11px/1.3 ${MONO}`, color: C.muted, margin: "6px 0 4px 2px" }}>
                  {compById[comp]?.name || comp} — dates not yet published
                </div>
                <div style={{ display: "grid", gap: 4 }}>
                  {items.map((f, i) => <FxRow key={i} f={f} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );

    // One fixture row plus its expandable panel — shared by the dated day
    // groups and the "date unconfirmed" bucket. Undated rows have f[1] null:
    // Time renders "—" (same mark as a midnight-stored no-time row — both
    // mean "no time recorded"), the ranking verdict skips its window check,
    // and the key includes the stage so two undated semi-finals don't collide.
    function FxRow({ f }) {
                const c = compById[f[0]] || {};
                const out = idx.outbound[f[0]] || [];
                const key = `${f[0]}|${f[1]}|${f[2]}|${f[4]}`;
                const shown = openFx === key;
                return (
                  <div>
                  <div onClick={() => out.length && setOpenFx(shown ? null : key)}
                    role={out.length ? "button" : undefined} tabIndex={out.length ? 0 : undefined}
                    onKeyDown={e => { if (out.length && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setOpenFx(shown ? null : key); } }}
                    style={{ cursor: out.length ? "pointer" : "default",
                    background: C.card, border: `1px solid ${C.rule}`,
                    borderLeft: `3px solid ${!out.length ? C.fault : idx.route[f[0]]?.kind === "RANKING" ? C.rank : C.brass}`,
                    borderRadius: 4, padding: "9px 13px",
                    display: "flex", gap: 13, alignItems: "center", flexWrap: "wrap",
                  }}>
                    <Time value={f[1]} zone={f[6]} width={54} />
                    <div style={{ flex: 1, minWidth: 190 }}>
                      <div style={{ font: `500 13px/1.35 ${SANS}`, color: C.ink }}>
                        {f[2] || "TBD"}{f[3] && f[3] !== "—" ? <span style={{ color: C.muted, fontWeight: 400 }}> v {f[3]}</span> : null}
                      </div>
                      <div style={{ font: `400 11px/1.35 ${MONO}`, color: C.muted, marginTop: 3 }}>
                        {c.name || f[0]}{f[4] ? ` · ${f[4]}` : ""}
                      </div>
                    </div>
                    <Chip>{c.sport || "?"}</Chip>
                    {f[5] === "UNKNOWN" && <Chip tone="fault">stage unknown</Chip>}
                    {(() => {
                      // Reader-worded status, one chip, only when something is at
                      // stake or the data can't say (fault tones = data problems,
                      // never sporting distance — see README contention bands).
                      const v = idx.fixtureVerdict(f[0], f[2], f[3], f[1]);
                      if (v?.level === "unknown") return <Chip tone="fault">can't assess</Chip>;
                      const m = idx.cardModel(f);
                      if (m.rankLevel === "live" || /wins? from an Olympic place/.test(m.sentence))
                        return <Chip tone="live">◉ qualification at stake</Chip>;
                      return null;
                    })()}
                    {/* Short route summary — a scannable header, deliberately
                        overlapping layer 3's detail (the chips are the summary;
                        the layers are the expansion). */}
                    <Stakes compId={f[0]} showHops={false} />
                    {out.length > 0 && <Chip tone="open">{shown ? "▾" : "▸"} details</Chip>}
                  </div>
                  {shown && (() => {
                    const m = idx.cardModel(f);
                    return (
                    <div style={{ margin: "5px 0 9px 12px", paddingLeft: 12, borderLeft: `2px solid ${C.rule}` }}>
                      {/* Layer 1 — the sentence. Plain language, no ids. */}
                      <div style={{ padding: "11px 13px", background: C.card, border: `1px solid ${C.rule}`,
                        borderRadius: 4, font: `400 13px/1.6 ${SANS}`, color: C.ink, marginBottom: 8 }}>
                        {m.sentence}
                      </div>
                      {/* The route — auto-expanded, no dropdown. Derived
                          sentences (mechanism, conditions) render on their
                          edges via edgeNotes; there is no separate "how it
                          works" prose to retype the trace. */}
                      <div style={{ font: `500 10px/1 ${MONO}`, color: C.muted, letterSpacing: ".08em",
                        textTransform: "uppercase", margin: "2px 0 6px 1px" }}>The route</div>
                      <div style={{ marginBottom: 8 }}>
                        <PathwayTrace compId={f[0]} teams={[f[2], f[3]]} quotes={false} notes={m.edgeNotes} cutNotes={m.cutNotes} />
                      </div>
                      {/* Layer 4 — sheet text, verbatim, adjacent to the derivation.
                          This is the fbl-005 protection; evidence mode expands it. */}
                      <Fold label="The rules as recorded (verbatim)" open={evidence}>
                        {m.quotes.map((q, j) => (
                          <div key={j} style={{ font: `400 11.5px/1.55 ${SANS}`, color: C.muted, marginTop: j ? 6 : 0 }}>
                            <span style={{ font: `500 10px/1 ${MONO}`, color: C.brass }}>{q.id} · {q.field}: </span>
                            «{q.text}»
                          </div>
                        ))}
                      </Fold>
                      {/* Internal verdicts (taxonomy, footers, gap narration) —
                          audit voice, evidence mode only. Relocated, not dropped. */}
                      {evidence && (() => {
                        const v = idx.fixtureVerdict(f[0], f[2], f[3], f[1]);
                        if (!v) return null;
                        const col = v.level === "live" ? C.rank : v.level === "low" ? C.muted : C.fault;
                        return (
                          <div style={{ marginBottom: 12, padding: "10px 12px", background: C.card,
                            border: `1px solid ${C.rule}`, borderLeft: `3px solid ${col}`, borderRadius: 4 }}>
                            <div style={{ font: `500 10px/1 ${MONO}`, color: col, letterSpacing: ".08em",
                              textTransform: "uppercase", marginBottom: 6 }}>
                              Ranking impact — {v.level}
                            </div>
                            <div style={{ font: `400 12.5px/1.55 ${SANS}`, color: C.ink }}>{v.why}</div>
                            {v.cut && <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.muted, marginTop: 6 }}>{v.cut.notes}</div>}
                            <div style={{ font: `400 10.5px/1.4 ${MONO}`, color: C.muted, marginTop: 7 }}>
                              Proximity to a cut-line on today’s table. Not a prediction.
                            </div>
                          </div>
                        );
                      })()}
                      {evidence && (() => {
                        const p = idx.placement(f[0], f[4]);
                        if (!p) return null;
                        const col = p.level === "live" ? C.live : p.level === "unresolved" ? C.fault : C.muted;
                        return (
                          <div style={{ marginBottom: 12, padding: "10px 12px", background: C.card,
                            border: `1px solid ${C.rule}`, borderLeft: `3px solid ${col}`, borderRadius: 4 }}>
                            <div style={{ font: `500 10px/1 ${MONO}`, color: col, letterSpacing: ".08em",
                              textTransform: "uppercase", marginBottom: 6 }}>
                              Placement stakes — {p.level}
                            </div>
                            <div style={{ font: `400 12.5px/1.55 ${SANS}`, color: C.ink }}>{p.why}</div>
                            <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.ink, marginTop: 6 }}>{p.distance}</div>
                            {p.stakes.map((s, j) => (
                              <div key={j} style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.muted, marginTop: 6 }}>{s}</div>
                            ))}
                            {p.conditions.length > 0 && (
                              <div style={{ marginTop: 7, paddingLeft: 9, borderLeft: `2px solid ${C.open}` }}>
                                {p.conditions.map((c, j) => (
                                  <div key={j} style={{ font: `400 11px/1.5 ${SANS}`, color: C.open, marginTop: j ? 4 : 0 }}>{c}</div>
                                ))}
                              </div>
                            )}
                            <div style={{ font: `400 10.5px/1.4 ${MONO}`, color: C.muted, marginTop: 7 }}>
                              {p.footer}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    );
                  })()}
                  </div>
                );
    }
  }

  function Calendar() {
    return (
      <div>
        <div style={{ display: "flex", gap: 3, background: C.card, padding: 3, borderRadius: 5,
          border: `1px solid ${C.rule}`, marginBottom: 16, width: "fit-content" }}>
          {[["events", "Events"], ["fixtures", "Fixtures"]].map(([k, l]) => (
            <button key={k} onClick={() => setCalMode(k)} style={{
              font: `500 12px/1 ${SANS}`, padding: "8px 17px", borderRadius: 3, cursor: "pointer",
              border: "none", background: calMode === k ? C.paper : "transparent",
              color: calMode === k ? C.ink : C.muted,
            }}>{l}</button>
          ))}
        </div>
        <SportFilter />
        {calMode === "events" ? <EventsSection /> : <FixturesSection />}
      </div>
    );
  }

  // ---------- RANKINGS ----------
  function Rankings() {
    return (
      <div>
        <SectionLabel n="—" text="Rankings and cut-lines"
          sub="Where each ranking's qualifying thresholds fall, and who sits near them. Everything here is arithmetic on the captured table — no simulation, no probabilities." />
        {(DATA.rank||[]).map(r => {
          const rows = (idx.standBy[r.ranking_id] || []).slice().sort((a, b) => a.rank - b.rank);
          const cuts = idx.cutsBy[r.ranking_id] || [];
          const th = idx.thresholds[r.ranking_id] || [];
          const cutAt = {}; th.forEach(t => (cutAt[t.atRank] ||= []).push(t.cut.name));
          return (
            <div key={r.ranking_id} style={{ marginBottom: 26, background: C.card,
              border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.rank}`, borderRadius: 4, padding: "15px 17px" }}>
              <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                <span style={{ font: `600 15px/1.2 ${SANS}`, color: C.ink }}>{r.name}</span>
                <Chip tone={r.selection_rule_type === "CONTINGENCY_ONLY" ? undefined : "rank"}>
                  {r.selection_rule_type === "CONTINGENCY_ONLY" ? "contingency only" : "awards entry"}
                </Chip>
                <Chip tone={r.points_model_type === "DERIVED" ? "open" : undefined}>{r.points_model_type || "model unknown"}</Chip>
                {r.cutoff_date && <Chip>closes {r.cutoff_date}</Chip>}
              </div>
              {r.points_notes && <p style={{ font: `400 12.5px/1.55 ${SANS}`, color: C.muted, margin: "0 0 12px" }}>{r.points_notes}</p>}

              {rows.length === 0 ? (
                <div style={{ padding: "11px 13px", background: "#B3372F0C", borderLeft: `2px solid ${C.fault}`,
                  borderRadius: "0 3px 3px 0", font: `400 12.5px/1.55 ${SANS}`, color: C.ink }}>
                  No standings captured. Nothing can be said about which fixtures matter for this ranking.
                  {r.standings_url && <> Source: <span style={{ font: `400 11.5px ${MONO}`, color: C.rank }}>{r.standings_url}</span></>}
                </div>
              ) : (
                <>
                  <div style={{ font: `400 10.5px/1 ${MONO}`, color: C.muted, marginBottom: 7 }}>
                    as of {rows[0].as_of} · captured to rank {idx.capturedDepth[r.ranking_id]}
                    {" · "}{(idx.thresholds[r.ranking_id] || []).length} of {(idx.cutsBy[r.ranking_id] || []).length} cut-lines locatable
                  </div>
                  {(idx.blocked[r.ranking_id] || []).length > 0 && (() => {
                    const bs = idx.blocked[r.ranking_id] || [];
                    const byDepth = bs.filter(b => b.reason !== "basis" && b.reason !== "unsatisfiable"),
                          byBasis = bs.filter(b => b.reason === "basis"),
                          byUnsat = bs.filter(b => b.reason === "unsatisfiable");
                    return (
                      <div style={{ marginBottom: 9, padding: "9px 12px", background: "#B3372F0C",
                        borderLeft: `2px solid ${C.fault}`, borderRadius: "0 3px 3px 0",
                        font: `400 12px/1.55 ${SANS}`, color: C.ink }}>
                        {byDepth.length > 0 && <>
                          Captured to rank {idx.capturedDepth[r.ranking_id]}. {byDepth.length} cut-line
                          {byDepth.length === 1 ? "" : "s"} fall deeper than that and cannot be
                          located: {byDepth.map(b => b.cut.name).join("; ")}. Extending the table
                          is what unblocks them.
                        </>}
                        {byBasis.length > 0 && <>
                          {byDepth.length > 0 ? " " : ""}{byBasis.map(b => b.cut.name).join("; ")}: TOP_N_OF_POOL with no
                          derivation basis — no second-round participation captured for the feeders, so the cut blocks
                          rather than guesses. Capturing those fixtures, not extending the table, is what unblocks it.
                        </>}
                        {byUnsat.length > 0 && <>
                          {byDepth.length + byBasis.length > 0 ? " " : ""}{byUnsat.map(b => b.cut.name).join("; ")}: blocked
                          by a recorded declaration — no reading of the allocation rule seats its own result, so no
                          threshold is shown. The evidence is on the cut's notes; resolving the reading and clearing
                          the block is what unblocks it.
                        </>}
                      </div>
                    );
                  })()}
                  <div style={{ display: "grid", gap: 2 }}>
                    {rows.map(x => {
                      const ineligible = x.olympic_eligible === "N";
                      const marks = cutAt[x.rank];
                      return (
                        <React.Fragment key={x.rank}>
                          <div style={{ display: "flex", gap: 11, alignItems: "center", padding: "6px 9px",
                            borderRadius: 3, background: ineligible ? "#B3372F08" : "transparent" }}>
                            <span style={{ font: `500 11px/1 ${MONO}`, color: C.muted, width: 20 }}>{x.rank}</span>
                            <span style={{ font: `${ineligible ? 400 : 500} 13px/1.3 ${SANS}`,
                              color: ineligible ? C.muted : C.ink, flex: 1, minWidth: 110,
                              textDecoration: ineligible ? "line-through" : "none" }}>{x.team}</span>
                            <span style={{ font: `400 10.5px/1 ${MONO}`, color: C.muted, width: 66 }}>{x.continent}</span>
                            <span style={{ font: `500 12px/1 ${MONO}`, color: C.ink, width: 34, textAlign: "right" }}>
                              {x.rating ?? "—"}</span>
                            {ineligible && <Chip tone="fault">not an eligible NOC</Chip>}
                          </div>
                          {marks && (
                            <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "3px 0" }}>
                              <span style={{ flex: 1, height: 1, background: C.live }} />
                              <span style={{ font: `500 9.5px/1 ${MONO}`, color: C.live, letterSpacing: ".08em",
                                textTransform: "uppercase" }}>{marks.join(" · ")} cut</span>
                              <span style={{ flex: 1, height: 1, background: C.live }} />
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </>
              )}
              {cuts.map(c => {
                const t = (idx.thresholds[r.ranking_id] || []).find(x => x.cut.cut_line_id === c.cut_line_id);
                return (
                <div key={c.cut_line_id} style={{ marginTop: 11, padding: "9px 12px", background: C.paper, borderRadius: 3,
                  borderLeft: `2px solid ${t ? C.live : C.fault}` }}>
                  <div style={{ font: `500 11.5px/1.3 ${SANS}`, color: C.ink }}>
                    {c.name} <span style={{ font: `400 10.5px ${MONO}`, color: C.muted }}>· by {c.deadline}</span>
                    {t ? <Chip tone="live">falls at rank {t.atRank}</Chip> : <Chip tone="fault">not locatable</Chip>}
                  </div>
                  <div style={{ font: `400 12px/1.55 ${SANS}`, color: C.muted, marginTop: 4 }}>{c.notes}</div>
                </div>
              );})}
            </div>
          );
        })}
      </div>
    );
  }

  // ---------- DATA ----------
  function DataTab() {
    const fileRef = useRef(null);
    const errs = (problems || []).filter(p => p.level === "error");
    const warns = (problems || []).filter(p => p.level === "warn");
    const Row = ({ k, v }) => (
      <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0",
        borderBottom: `1px solid ${C.rule}` }}>
        <span style={{ font: `400 12px ${MONO}`, color: C.muted }}>{k}</span>
        <span style={{ font: `500 12.5px ${SANS}`, color: C.ink }}>{v}</span>
      </div>
    );
    return (
      <div>
        <SectionLabel n="—" text="Data source"
          sub="Nothing is compiled into this page. Every number above is read from the workbook you loaded." />
        <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4,
          padding: "14px 17px", marginBottom: 20 }}>
          <Row k="source" v={meta?.source || "unknown"} />
          <Row k="load path" v={meta?.loadPath === "artefact" ? "published artefact (fetched)"
            : meta?.loadPath === "stored" ? "stored dataset (this browser)"
            : meta?.loadPath === "dragdrop" ? "workbook (drag-drop)" : "unrecorded"} />
          <Row k="loaded" v={meta?.loadedAt ? new Date(meta.loadedAt).toLocaleString() : "—"} />
          {Object.entries(meta?.counts || {}).map(([k, v]) => <Row key={k} k={k} v={v} />)}
        </div>

        <SectionLabel n="—" text="About the verdicts"
          sub="The methodology behind every fixture card and ranking panel — stated once, here, instead of on each card." />
        <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4,
          padding: "14px 17px", marginBottom: 20, font: `400 12.5px/1.65 ${SANS}`, color: C.ink }}>
          Verdicts are structural: derived from the link graph, the captured standings, and declared
          cut-line rules. Proximity to a line is arithmetic on today's table — no results, seeding,
          form or probability is consulted, and nothing here is a prediction. "In contention" means
          within the documented contention bands: 25 rating points of a line, or 3 places
          where no rating exists. Conditional berth rules are either structured in the data
          or quoted verbatim from the sheet — when a condition can't be resolved, the card says so
          rather than naming a winner. The app compares today's table to the cut-lines and does not
          model rating changes from results: ICC-style rating movement depends on both sides'
          ratings, so a win can move a team a lot, a little, or the wrong way — "what happens if
          they win" is deliberately unanswered. Fixture times are shown exactly as entered from
          their sources with the zone unverified unless declared.
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 26 }}>
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={{
            font: `500 12.5px/1 ${SANS}`, padding: "10px 16px", borderRadius: 4, cursor: "pointer",
            border: `1px solid ${C.ink}`, background: C.ink, color: "#fff", opacity: busy ? .5 : 1 }}>
            {busy ? "Reading\u2026" : "Reload from file"}
          </button>
          <input ref={fileRef} type="file" multiple accept=".xlsx,.xlsm,.xls,.csv" style={{ display: "none" }}
            onChange={e => {
              const arr = [...e.target.files];
              const xl = arr.find(f => /\.(xlsx|xlsm|xls)$/i.test(f.name));
              onLoad(xl ? { kind: "workbook", file: xl } : { kind: "csvs", files: arr });
            }} />
          <button onClick={onReset} style={{
            font: `500 12.5px/1 ${SANS}`, padding: "10px 16px", borderRadius: 4, cursor: "pointer",
            border: `1px solid ${C.rule}`, background: C.card, color: C.ink }}>Clear and start over</button>
        </div>

        <SectionLabel n="—" text={`Validation — ${errs.length} error${errs.length === 1 ? "" : "s"}, ${warns.length} warning${warns.length === 1 ? "" : "s"}`}
          sub="Run after every load. Errors mean a number on screen is wrong; warnings mean something is missing but the app still works." />
        {problems?.length
          ? <Problems list={problems} />
          : <div style={{ padding: "12px 14px", background: "#147D5C0E", borderLeft: `2px solid ${C.live}`,
              borderRadius: "0 3px 3px 0", font: `400 12.5px/1.55 ${SANS}`, color: C.ink }}>
              Everything checks out: berth totals reconcile, every link resolves, no duplicate fixtures.
            </div>}
      </div>
    );
  }

  // ---------- AUDIT ----------
  function Audit() {
    const bad = (DATA.events||[]).filter(e => idx.berthSum[e.olympic_event_id] !== Number(e.quota_total));
    const Stat = ({ v, l, tone }) => (
      <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4, padding: "15px 17px", flex: "1 1 150px" }}>
        <div style={{ font: `600 27px/1 ${SANS}`, color: tone === "fault" ? C.fault : tone === "live" ? C.live : C.ink }}>{v}</div>
        <div style={{ font: `400 11px/1.35 ${MONO}`, color: C.muted, marginTop: 6, letterSpacing: ".04em" }}>{l}</div>
      </div>
    );
    return (
      <div>
        <SectionLabel n="—" text="Coverage audit" sub="What the app can and cannot trace with the data as it stands." />
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 30 }}>
          <Stat v={(DATA.events||[]).length} l="Olympic quota pools" />
          <Stat v={(DATA.links||[]).length} l="Graph links" />
          <Stat v={linked} l="Competitions linked" tone="live" />
          <Stat v={orphans.length} l="Competitions with no links" tone={orphans.length ? "fault" : "live"} />
          <Stat v={bad.length} l="Berth-sum mismatches" tone={bad.length ? "fault" : "live"} />
          <Stat v={(DATA.links||[]).filter(l => l.confidence === "AMBIGUOUS").length} l="Rules flagged ambiguous" tone="open" />
        </div>

        <SectionLabel n="—" text="Ranking-fixture materiality"
          sub="Every fixture that feeds a ranking, scored by proximity to a qualifying cut-line on today's table." />
        {(() => {
          const tally = { live: 0, low: 0, none: 0, unknown: 0 };
          (DATA.fx||[]).forEach(f => { const v = idx.fixtureVerdict(f[0], f[2], f[3], f[1]); if (v) tally[v.level]++; });
          const gaps = [];
          Object.entries(idx.thresholds).forEach(([rid, ts]) => {
            ts.forEach(t => (idx.standBy[rid] || []).forEach(r => {
              if (Math.abs(r.rank - t.atRank) <= 2 && r.olympic_eligible === "Y") {
                const has = (DATA.fx||[]).some(f => (f[2] === r.team || f[3] === r.team) &&
                  (idx.outbound[f[0]] || []).some(l => l.to_id === rid));
                if (!has && !gaps.includes(r.team)) gaps.push(r.team);
              }
            }));
          });
          return (
            <>
              <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 18 }}>
                {[["live", "Live — near a cut-line", C.rank], ["low", "Low impact", C.muted],
                  ["none", "No impact — after cutoff", C.fault], ["unknown", "Not computable", C.fault]].map(([k, l, col]) => (
                  <div key={k} style={{ background: C.card, border: `1px solid ${C.rule}`,
                    borderLeft: `3px solid ${col}`, borderRadius: 4, padding: "13px 15px", flex: "1 1 150px" }}>
                    <div style={{ font: `600 24px/1 ${SANS}`, color: col === C.muted ? C.ink : col }}>{tally[k]}</div>
                    <div style={{ font: `400 11px/1.35 ${MONO}`, color: C.muted, marginTop: 5 }}>{l}</div>
                  </div>
                ))}
              </div>
              {gaps.length > 0 && (
                <div style={{ marginBottom: 26, padding: "12px 15px", background: C.card,
                  border: `1px solid ${C.rule}`, borderLeft: `3px solid ${C.open}`, borderRadius: 4 }}>
                  <div style={{ font: `500 11px/1 ${MONO}`, color: C.open, letterSpacing: ".07em",
                    textTransform: "uppercase", marginBottom: 7 }}>Bubble teams with no fixtures in the sheet</div>
                  <div style={{ font: `400 12.5px/1.55 ${SANS}`, color: C.ink }}>
                    {gaps.join(", ")} sit within two places of a cut-line but have no fixtures recorded. Their results
                    are the ones most likely to change who qualifies, and none of them are being tracked.
                  </div>
                </div>
              )}
            </>
          );
        })()}
        <SectionLabel n="—" text="Ranking systems" sub="points_model_type governs how far impact analysis can go for that sport." />
        <div style={{ display: "grid", gap: 8, marginBottom: 30 }}>
          {(DATA.rank||[]).map(r => (
            <div key={r.ranking_id} style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4, padding: "13px 15px" }}>
              <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                <Chip tone={r.points_model_type === "DERIVED" ? "open" : undefined}>{r.points_model_type}</Chip>
                <span style={{ font: `500 13px/1.3 ${SANS}`, color: C.ink }}>{r.name}</span>
              </div>
              <div style={{ font: `400 11px/1.4 ${MONO}`, color: C.muted, marginBottom: 6 }}>
                closes {r.cutoff_date} · cap {r.nation_cap}
              </div>
              <p style={{ font: `400 12.5px/1.55 ${SANS}`, color: C.muted, margin: 0 }}>{r.points_notes}</p>
            </div>
          ))}
        </div>

        <SectionLabel n="—" text={`Not yet traceable (${orphans.length})`} sub="These exist in Competitions but award nothing in Links, so no pathway reaches them." />
        <div style={{ display: "grid", gap: 5, marginBottom: 30 }}>
          {orphans.map(c => (
            <div key={c.competition_id} style={{
              background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4,
              padding: "9px 13px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap",
            }}>
              <span style={{ font: `500 12.5px/1.3 ${SANS}`, color: C.ink, flex: 1, minWidth: 200 }}>{c.name}</span>
              <span style={{ font: `400 10.5px/1 ${MONO}`, color: C.muted }}>{c.sport}</span>
              {idx.fxCount[c.competition_id] && <Chip>{idx.fxCount[c.competition_id]} fx</Chip>}
            </div>
          ))}
        </div>

        <SectionLabel n="—" text="Published artefact"
          sub="The validator report embedded when this dataset was emitted — the pipeline's claim at publish time, distinct from this browser's own validation on the Data view." />
        {meta?.artefact ? (() => {
          const a = meta.artefact, v = a.validator;
          const ARow = ({ k, val }) => (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 14, padding: "6px 0",
              borderBottom: `1px solid ${C.rule}` }}>
              <span style={{ font: `400 12px ${MONO}`, color: C.muted }}>{k}</span>
              <span style={{ font: `500 12px ${MONO}`, color: C.ink, textAlign: "right" }}>{val}</span>
            </div>
          );
          return (
            <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 4, padding: "14px 17px" }}>
              <ARow k="workbook" val={`${wbLabel(a.workbook)} · sha ${(a.workbook?.sha256 ?? "").slice(0, 12) || "?"}`} />
              <ARow k="as of (validator clock)" val={a.reference_date ?? "—"} />
              <ARow k="generated" val={a.generated_at ?? "—"} />
              <ARow k="fit to publish" val={String(v?.fit_to_publish ?? "unknown")} />
              {v && <ARow k="findings" val={`${v.error} error · ${v.warn} warn · ${v.info} info · ${v.suppressed} suppressed`} />}
              {v && Object.entries(v.rules ?? {}).sort(([x], [y]) => x.localeCompare(y)).map(([k, n]) =>
                <ARow key={k} k={k} val={n} />)}
            </div>
          );
        })() : (
          <Empty text={`This session was not loaded from the published artefact (load path: ${meta?.loadPath ?? "unrecorded"}), so there is no embedded validator report to audit. The Data view shows this browser's own validation of what was loaded.`} />
        )}
      </div>
    );
  }

  const SectionLabel = ({ n, text, sub }) => (
    <div style={{ marginBottom: 15 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
        <span style={{ font: `500 10px/1 ${MONO}`, color: C.brass, letterSpacing: ".12em" }}>{n}</span>
        <h3 style={{ font: `600 14px/1 ${SANS}`, color: C.ink, margin: 0, letterSpacing: ".01em" }}>{text}</h3>
      </div>
      {sub && <p style={{ font: `400 12px/1.5 ${SANS}`, color: C.muted, margin: "6px 0 0 25px", maxWidth: 640 }}>{sub}</p>}
    </div>
  );
  const Empty = ({ text }) => (
    <div style={{
      border: `1px dashed ${C.rule}`, borderRadius: 4, padding: "20px 16px",
      font: `400 12.5px/1.5 ${SANS}`, color: C.muted, textAlign: "center",
    }}>{text}</div>
  );

  const bySport = {};
  (DATA.events||[]).forEach(e => (bySport[e.sport] ||= []).push(e));

  return (
    <div style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.ink }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        *{box-sizing:border-box} button:focus-visible{outline:2px solid ${C.brass};outline-offset:2px}
        @media (prefers-reduced-motion:no-preference){.vw{animation:f .25s ease both}}
        @keyframes f{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
      `}</style>

      <header style={{ borderBottom: `1px solid ${C.rule}`, background: C.card }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "15px 22px", display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ font: `600 15px/1 ${SANS}`, letterSpacing: "-.01em" }}>LA28 qualification graph</div>
            <div style={{ font: `400 10.5px/1 ${MONO}`, color: C.muted, marginTop: 5, letterSpacing: ".05em" }}>
              schema test harness · fencing seeded
            </div>
          </div>
          <nav style={{ display: "flex", gap: 3, background: C.paper, padding: 3, borderRadius: 5 }}>
            {[["pathway", "Pathway"], ["calendar", "Calendar"], ["rankings", "Rankings"], ["audit", "Audit"], ["data", "Data"]].map(([k, l]) => (
              <button key={k} onClick={() => setView(k)} style={{
                font: `500 12px/1 ${SANS}`, padding: "8px 15px", borderRadius: 3, cursor: "pointer",
                border: "none", background: view === k ? C.card : "transparent",
                color: view === k ? C.ink : C.muted,
                boxShadow: view === k ? "0 1px 2px #14202B14" : "none",
              }}>{l}</button>
            ))}
            {/* Evidence mode: expands every "rules as recorded" layer and
                reveals the internal verdict blocks. The audit affordance. */}
            <button onClick={() => setEvidence(!evidence)} title="Expand all recorded rules and internal verdicts"
              style={{ font: `500 12px/1 ${SANS}`, padding: "8px 15px", borderRadius: 3, cursor: "pointer",
                border: `1px dashed ${evidence ? C.brass : C.rule}`, background: evidence ? "#9A6F3014" : "transparent",
                color: evidence ? C.brass : C.muted }}>
              evidence {evidence ? "on" : "off"}
            </button>
          </nav>
        </div>
        <Provenance meta={meta} />
      </header>

      <div style={{ maxWidth: 1180, margin: "0 auto", padding: "26px 22px 70px", display: "flex", gap: 30, alignItems: "flex-start", flexWrap: "wrap" }}>
        {view === "pathway" && (
          <aside style={{ width: 246, flexShrink: 0, minWidth: 210 }}>
            <div style={{ font: `500 10px/1 ${MONO}`, color: C.muted, letterSpacing: ".12em", textTransform: "uppercase", marginBottom: 11 }}>
              Quota pools
            </div>
            {Object.entries(bySport).map(([sport, evs]) => (
              <div key={sport} style={{ marginBottom: 16 }}>
                <div style={{ font: `500 11px/1 ${SANS}`, color: C.muted, marginBottom: 7 }}>{sport}</div>
                <div style={{ display: "grid", gap: 3 }}>
                  {evs.map(e => {
                    const ok = idx.berthSum[e.olympic_event_id] === Number(e.quota_total);
                    const on = sel === e.olympic_event_id;
                    return (
                      <button key={e.olympic_event_id} onClick={() => { setSel(e.olympic_event_id); setOpenNote(null); }}
                        style={{
                          textAlign: "left", cursor: "pointer", borderRadius: 4, padding: "8px 10px",
                          border: `1px solid ${on ? C.brass : C.rule}`,
                          background: on ? "#9A6F300E" : C.card,
                          display: "flex", gap: 8, alignItems: "center",
                        }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: ok ? C.live : C.fault, flexShrink: 0 }} />
                        <span style={{ font: `${on ? 500 : 400} 12px/1.3 ${SANS}`, color: C.ink, flex: 1 }}>{e.event_name}</span>
                        <span style={{ font: `400 10px/1 ${MONO}`, color: C.muted }}>{e.quota_total}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </aside>
        )}
        <main key={view + sel + calMode + sportFilter} className="vw" style={{ flex: 1, minWidth: 300 }}>
          {view === "pathway" ? <Pathway /> : view === "calendar" ? <Calendar /> : view === "rankings" ? <Rankings /> : view === "data" ? <DataTab /> : <Audit />}
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  APP SHELL — load, persist, validate, then hand off to the explorer
 * ------------------------------------------------------------------ */

function Problems({ list, compact }) {
  if (!list?.length) return null;
  const order = { fatal: 0, error: 1, warn: 2 };
  const sorted = [...list].sort((a, b) => order[a.level] - order[b.level]);
  const shown = compact ? sorted.slice(0, 6) : sorted;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {shown.map((p, i) => (
        <div key={i} style={{
          font: `400 12px/1.5 ${SANS}`, padding: "7px 10px", borderRadius: 3,
          color: p.level === "warn" ? C.open : C.fault,
          background: p.level === "warn" ? "#A8761A0E" : "#B3372F0E",
          borderLeft: `2px solid ${p.level === "warn" ? C.open : C.fault}`,
        }}>
          <span style={{ font: `500 9.5px ${MONO}`, letterSpacing: ".07em", textTransform: "uppercase",
            marginRight: 7 }}>{p.level}</span>{p.msg}
        </div>
      ))}
      {compact && sorted.length > 6 && (
        <div style={{ font: `400 11.5px ${SANS}`, color: C.muted }}>+{sorted.length - 6} more</div>
      )}
    </div>
  );
}

function Loader({ onLoad, busy, error, problems, notice }) {
  const [url, setUrl] = useState("");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);

  const handleFiles = async (files) => {
    const arr = [...files];
    if (!arr.length) return;
    const xl = arr.find(f => /\.(xlsx|xlsm|xls)$/i.test(f.name));
    onLoad(xl ? { kind: "workbook", file: xl } : { kind: "csvs", files: arr.filter(f => /\.csv$/i.test(f.name)) });
  };

  const Btn = ({ children, onClick, primary, disabled }) => (
    <button onClick={onClick} disabled={disabled} style={{
      font: `500 12.5px/1 ${SANS}`, padding: "10px 16px", borderRadius: 4,
      cursor: disabled ? "default" : "pointer", opacity: disabled ? .5 : 1,
      border: `1px solid ${primary ? C.ink : C.rule}`,
      background: primary ? C.ink : C.card, color: primary ? "#fff" : C.ink,
    }}>{children}</button>
  );

  return (
    <div style={{ background: C.paper, minHeight: "100vh", fontFamily: SANS, color: C.ink,
      display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "48px 22px" }}>
      <div style={{ maxWidth: 620, width: "100%" }}>
        <div style={{ font: `600 20px/1.2 ${SANS}`, letterSpacing: "-.015em" }}>LA28 qualification graph</div>
        <p style={{ font: `400 13px/1.6 ${SANS}`, color: C.muted, margin: "9px 0 26px" }}>
          Everything is read from your workbook at run time — no data is compiled into this page.
          Edit the sheet, reload, and every pathway, cut-line and verdict recomputes.
        </p>

        {notice && (
          <div style={{ margin: "0 0 16px", padding: "11px 13px", background: C.card,
            borderLeft: `2px solid ${C.brass}`, borderRadius: "0 3px 3px 0",
            font: `400 12.5px/1.55 ${SANS}`, color: C.ink }}>
            {notice} The pipeline publishes daily — the published view may return on its own.
            You can still load a workbook below.
          </div>
        )}

        <div
          onDragOver={e => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => fileRef.current?.click()}
          style={{ border: `1.5px dashed ${drag ? C.brass : C.rule}`, borderRadius: 6, padding: "34px 20px",
            textAlign: "center", cursor: "pointer", background: drag ? "#9A6F300A" : C.card, marginBottom: 16 }}>
          <div style={{ font: `500 14px/1.3 ${SANS}` }}>
            {busy ? "Reading…" : "Drop LA28_Qualification_Database.xlsx here"}
          </div>
          <div style={{ font: `400 11.5px/1.5 ${MONO}`, color: C.muted, marginTop: 7 }}>
            or click to choose · .xlsx, or one .csv per tab
          </div>
          <input ref={fileRef} type="file" multiple accept=".xlsx,.xlsm,.xls,.csv"
            onChange={e => handleFiles(e.target.files)} style={{ display: "none" }} />
        </div>

        <div style={{ background: C.card, border: `1px solid ${C.rule}`, borderRadius: 6, padding: "16px 18px" }}>
          <div style={{ font: `500 12.5px/1.3 ${SANS}`, marginBottom: 4 }}>…or pull from Google Sheets</div>
          <div style={{ font: `400 11.5px/1.5 ${SANS}`, color: C.muted, marginBottom: 11 }}>
            Paste the sheet URL. It must be shared so anyone with the link can view, and the tabs must keep
            their names. Tab names are matched, so gid order doesn't matter.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              style={{ flex: 1, minWidth: 220, font: `400 12px ${MONO}`, padding: "10px 11px",
                border: `1px solid ${C.rule}`, borderRadius: 4, background: C.paper, color: C.ink }} />
            <Btn primary disabled={!url.trim() || busy} onClick={() => onLoad({ kind: "gsheet", url })}>Fetch</Btn>
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 16, padding: "11px 13px", background: "#B3372F0E",
            borderLeft: `2px solid ${C.fault}`, borderRadius: "0 3px 3px 0",
            font: `400 12.5px/1.55 ${SANS}`, color: C.ink }}>{error}</div>
        )}
        {problems?.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ font: `500 11px/1 ${MONO}`, color: C.muted, letterSpacing: ".08em",
              textTransform: "uppercase", marginBottom: 8 }}>Could not load</div>
            <Problems list={problems} />
          </div>
        )}

        <div style={{ marginTop: 26, font: `400 11.5px/1.7 ${MONO}`, color: C.muted }}>
          Expected tabs: Olympic_Events · Competitions · Links · Ranking_Systems · Standings · Cut_Lines · Fixtures<br />
          Required: Olympic_Events, Competitions, Links. The rest degrade gracefully.
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [problems, setProblems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [restoring, setRestoring] = useState(true);
  // Why the published artefact didn't load, if it didn't. A visitor with no
  // workbook must see a stated reason, never a bare file picker (the
  // drag-drop Loader is the dev path; on the site it is the FALLBACK).
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(STORE_KEY);
        if (r?.value) {
          const saved = JSON.parse(r.value);
          // loadPath is a fact about THIS session's load, not the saved blob:
          // the blob keeps its original source/loadedAt, but the strip must
          // say the data came from the store, not from a fresh read.
          setData(saved.data);
          setMeta(saved.meta ? { ...saved.meta, loadPath: "stored" } : saved.meta);
          setProblems(saved.problems || []);
          setRestoring(false); return;
        }
      } catch { /* nothing stored yet */ }
      // Nothing stored: try the published artefact (the site path). Fetched
      // at RUNTIME — never imported — which is what keeps "no data compiled
      // into the app" true (docs/stage-four.md §1; test/bundle-invariant.mjs
      // enforces it). Shape-validated on meta.schema_version, NOT on the
      // sentinel: the sentinel string must never appear in this bundle.
      // Not written to storage — the site refetches per visit; the store
      // stays the drag-drop cache. Absent/failed fetch falls through to the
      // Loader exactly as before (dev workflow unchanged).
      try {
        if (typeof fetch === "function") {
          const res = await fetch("data/data.json", { cache: "no-store" });
          if (!res.ok) {
            setNotice(`The published artefact could not be loaded (data/data.json — HTTP ${res.status}).`);
          } else {
            const j = await res.json();
            if (!(j?.meta?.schema_version === 1 && j?.data && Array.isArray(j.data.events))) {
              setNotice("The published artefact was fetched but has an unexpected shape — refusing to render it.");
            } else {
              const { data: norm_, problems: probs } = normalise(j.data);
              if (norm_) {
                setMeta({ source: `data.json · workbook ${wbLabel(j.meta.workbook)}`,
                  loadedAt: new Date().toISOString(), loadPath: "artefact", artefact: j.meta,
                  counts: { events: norm_.events.length, comps: norm_.comps.length, links: norm_.links.length,
                            rank: norm_.rank.length, standings: norm_.standings.length, cuts: norm_.cuts.length,
                            fixtures: norm_.fx.length } });
                setData(norm_); setProblems(probs);
              } else {
                setProblems(probs);
                setNotice("The published artefact was fetched but failed normalisation — details below.");
              }
            }
          }
        }
      } catch (e) {
        // No artefact where we're running (dev file://, offline, outage) —
        // the Loader takes over, with the reason stated.
        setNotice(`The published artefact could not be reached (${e?.message ?? "fetch failed"}).`);
      }
      setRestoring(false);
    })();
  }, []);

  const load = async (req) => {
    setBusy(true); setError(null); setProblems([]);
    try {
      let raw, source;
      if (req.kind === "workbook") { raw = await parseWorkbook(req.file); source = req.file.name; }
      else if (req.kind === "csvs") {
        if (!req.files.length) throw new Error("No .csv files recognised. Name each file after its tab.");
        raw = await parseCsvFiles(req.files); source = `${req.files.length} CSV files`;
      } else { raw = await fetchGoogleSheet(req.url); source = "Google Sheets"; }

      const { data: norm_, problems: probs } = normalise(raw);
      if (!norm_) { setProblems(probs); setBusy(false); return; }

      const m = { source, loadedAt: new Date().toISOString(), loadPath: "dragdrop",
        counts: { events: norm_.events.length, comps: norm_.comps.length, links: norm_.links.length,
                  rank: norm_.rank.length, standings: norm_.standings.length, cuts: norm_.cuts.length,
                  fixtures: norm_.fx.length } };
      setData(norm_); setMeta(m); setProblems(probs);
      try { await window.storage.set(STORE_KEY, JSON.stringify({ data: norm_, meta: m, problems: probs })); }
      catch { /* too large to cache; app still works this session */ }
    } catch (e) {
      setError(e?.message || "Could not read that file.");
    }
    setBusy(false);
  };

  const reset = async () => {
    try { await window.storage.delete(STORE_KEY); } catch {}
    setData(null); setMeta(null); setProblems([]); setError(null);
  };

  if (restoring) return (
    <div style={{ background: C.paper, minHeight: "100vh", display: "grid", placeItems: "center",
      font: `400 13px ${MONO}`, color: C.muted }}>loading…</div>
  );
  if (!data) return <Loader onLoad={load} busy={busy} error={error} problems={problems} notice={notice} />;
  return <Explorer data={data} meta={meta} problems={problems} onReset={reset} onLoad={load} busy={busy} />;
}

// Named exports for the render-test harness (handoff PART 8 #9): execute the
// module, feed Explorer the real dataset, and read the rendered output.
export { Explorer, normalise };
