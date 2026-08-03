/**
 * Stage-four step 3: the CI chain (docs/stage-four.md §2–§4), pull excluded
 * (tools/pull-workbook.mjs runs first and separately — a failed pull never
 * reaches this script). Order is load-bearing:
 *
 *   gate-ack → validator → skip-check → emit → round-trip → atomic publish
 *
 * - Gate-ack: tools/pull-gate.mjs against the LAST PUBLISHED workbook
 *   (kept in the state dir). First run has no baseline: the gate is
 *   skipped once, loudly, and the baseline seeds on publish.
 * - Validator: exit 1 on unsuppressed ERROR only — the existing boundary.
 *   A failing run still archives its meta + report (no data block) so
 *   fit_to_publish:false runs exist in the archive corpus (§4).
 * - Skip-check: publish is skipped only when workbook sha AND the rules
 *   map ({rule_key: count}, deep) are BOTH unchanged vs the last published
 *   run. Never compares E/W/I totals.
 * - Round-trip: test/data-roundtrip.mjs --ci against the pulled workbook —
 *   the only guard on the artefact itself, between emit and publish.
 * - Publish: archive copy written and fsynced first, then temp + rename
 *   over data/data.json — a fetch sees old or new, never partial. The
 *   publisher refuses a live artefact with fit_to_publish !== true.
 * - Composition delta (log only, never gates): rule keys appeared/cleared
 *   vs the last published run.
 *
 * Usage: node tools/ci-publish.mjs --workbook pulled.xlsx [--site site]
 *        [--state .ci-state] [--reference-date YYYY-MM-DD] [--acks pull-acks.json]
 */
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync,
         openSync, writeSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { emit } from "./emit-data.mjs";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);
const flag = (name, dflt = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };

const WB = flag("--workbook");
if (!WB) { console.error("usage: node tools/ci-publish.mjs --workbook pulled.xlsx [--site site] [--state .ci-state] [--reference-date d] [--acks f]"); process.exit(2); }
const SITE = flag("--site", "site");
const STATE = flag("--state", ".ci-state");
const REF_DATE = flag("--reference-date", new Date().toISOString().slice(0, 10));
const ACKS = flag("--acks", root + "pull-acks.json");

mkdirSync(STATE, { recursive: true });
mkdirSync(`${SITE}/data/archive`, { recursive: true });

const sha256 = buf => createHash("sha256").update(buf).digest("hex");
const wbSha = sha256(readFileSync(WB));
const stableRules = r => JSON.stringify(Object.fromEntries(Object.entries(r ?? {}).sort(([a], [b]) => a.localeCompare(b))));
const writeFsync = (path, text) => {
  const fd = openSync(path, "w");
  writeSync(fd, text); fsyncSync(fd); closeSync(fd);
};
const run = (title, argv) => {
  console.log(`\n== ${title} ==`);
  try { execFileSync("node", argv, { stdio: "inherit", cwd: root }); return true; }
  catch { return false; }
};

const lastMetaPath = `${STATE}/last-published-meta.json`;
const lastWbPath = `${STATE}/last-published.xlsx`;
const lastMeta = existsSync(lastMetaPath) ? JSON.parse(readFileSync(lastMetaPath, "utf8")) : null;

// 0. BASELINE INTEGRITY — a distinct code path from "no baseline", because a
// baseline that is present-but-wrong is the tampering/corruption case: the
// workbook must hash to the sha recorded when it was published, and a
// half-baseline (one file of the pair) is treated the same, never as a fresh
// start. Exit 3, and the message forbids bootstrapping over it — a bootstrap
// ack here would launder whatever changed the baseline.
const integrityFail = why => {
  console.error("== BASELINE INTEGRITY FAILURE ==");
  console.error(why);
  console.error("This is NOT a missing baseline: do NOT commit a bootstrap ack over it.");
  console.error("Investigate how the baseline changed (branch history, cache tampering,");
  console.error("partial write), restore the genuine last-published pair, then re-run.");
  console.error("\nCHAIN STOPPED at baseline integrity. Nothing published.");
  process.exit(3);
};
if (existsSync(lastWbPath) !== (lastMeta !== null)) {
  integrityFail(`Half a baseline: ${existsSync(lastWbPath) ? "last-published.xlsx exists but its meta is missing" : "last-published-meta.json exists but its workbook is missing"}.`);
}
if (lastMeta && existsSync(lastWbPath)) {
  const baselineSha = sha256(readFileSync(lastWbPath));
  if (baselineSha !== lastMeta.workbook_sha256)
    integrityFail(`The stored baseline workbook hashes to ${baselineSha.slice(0, 12)}… but the meta recorded ` +
      `${String(lastMeta.workbook_sha256).slice(0, 12)}… at publish time — the gate would compare against bytes nobody published.`);
}

// 1. GATE-ACK — vs the last published workbook.
if (existsSync(lastWbPath)) {
  if (!run("gate-ack (pull-gate vs last published workbook)",
      [root + "tools/pull-gate.mjs", lastWbPath, WB, "--acks", ACKS, "--json", `${STATE}/gate-report.json`])) {
    console.error("\nCHAIN STOPPED at gate-ack. Nothing published.");
    process.exit(1);
  }
} else {
  // FAIL CLOSED: a missing baseline is indistinguishable from an evicted or
  // unreachable one, and an ungated publish is exactly what the gate exists
  // to prevent. A genuine first run is an EXPLICIT, acked bootstrap: a
  // human commits an ack whose digest binds the exact workbook bytes being
  // bootstrapped — any other workbook, including a later edit of the same
  // sheet, fails until re-acked.
  const bootstrapDigest = createHash("sha256").update(`BOOTSTRAP·${wbSha}`).digest("hex");
  const acks = existsSync(ACKS) ? JSON.parse(readFileSync(ACKS, "utf8")).acks ?? [] : [];
  const matched = acks.find(a => a.digest === bootstrapDigest);
  if (matched) {
    console.log(`== gate-ack: NO BASELINE — bootstrap acknowledged: "${matched.note}" (${matched.date}). Baseline seeds when this run publishes. ==`);
  } else {
    console.error("== gate-ack: NO BASELINE FOUND ==");
    console.error("The last-published workbook is missing (evicted cache, unreachable archive,");
    console.error("or a genuine first run). Publishing without a baseline would skip the gate,");
    console.error("so this run publishes NOTHING. If this IS the intended first publish of");
    console.error(`workbook ${wbSha.slice(0, 12)}…, review it and commit to pull-acks.json:`);
    console.error(`  { "digest": "${bootstrapDigest}", "note": "bootstrap: <why there is no baseline>", "date": "<today>" }`);
    console.error("(digest = sha256 of \"BOOTSTRAP·<workbook sha256>\" — it authorises these exact bytes only)");
    console.error("\nCHAIN STOPPED at gate-ack (no baseline). Nothing published.");
    process.exit(1);
  }
}

// 2. VALIDATOR — the existing boundary, unchanged.
const reportPath = `${STATE}/run-report.json`;
const validatorOk = run("validator gate",
  [root + "src/validate/cli.ts", WB, "--reference-date", REF_DATE,
   "--json", reportPath, "--known-issues", root + "known-issues.json", "--sentinels", root + "sentinels.json"]);
const artefact = emit(WB, { reportPath, referenceDate: REF_DATE });
const rules = artefact.meta.validator.rules;
const archiveKey = sha256(wbSha + REF_DATE + stableRules(rules)).slice(0, 12);

if (!validatorOk) {
  // Failed runs are archived too — meta + report, no data block (§4).
  writeFsync(`${SITE}/data/archive/failed-${archiveKey}.json`,
    JSON.stringify({ meta: artefact.meta, report: JSON.parse(readFileSync(reportPath, "utf8")) }));
  console.error(`\nCHAIN STOPPED at validator gate (unsuppressed ERROR). Failure archived as failed-${archiveKey}.json; nothing published.`);
  process.exit(1);
}

// 3. SKIP-CHECK — workbook sha AND rules map, never totals.
if (lastMeta && lastMeta.workbook_sha256 === wbSha && stableRules(lastMeta.rules) === stableRules(rules)) {
  console.log(`\nSKIP PUBLISH — workbook (${wbSha.slice(0, 8)}) and rules map both unchanged since last publish (${lastMeta.reference_date}).`);
  process.exit(0);
}

// 4. ROUND-TRIP — on the pulled workbook and the emit path, between emit and publish.
if (!run("round-trip harness (data.json path == workbook path)",
    [root + "test/data-roundtrip.mjs", WB, "--ci"])) {
  console.error("\nCHAIN STOPPED at round-trip. The artefact path and the workbook path disagree; nothing published.");
  process.exit(1);
}

// 5. COMPOSITION DELTA — log only, never gates (§3: no WARN-count pinning).
if (lastMeta) {
  const oldKeys = Object.keys(lastMeta.rules ?? {}), newKeys = Object.keys(rules);
  const appeared = newKeys.filter(k => !oldKeys.includes(k));
  const cleared = oldKeys.filter(k => !newKeys.includes(k));
  console.log(`\ncomposition delta vs last published: appeared [${appeared.join(", ") || "none"}] · cleared [${cleared.join(", ") || "none"}]`);
}

// 6. ATOMIC PUBLISH — archive (fsynced) first, then temp + rename.
if (artefact.meta.validator.fit_to_publish !== true)
  throw new Error("refusing to publish a live artefact with fit_to_publish !== true");
const json = JSON.stringify(artefact);
writeFsync(`${SITE}/data/archive/data-${archiveKey}.json`, json);
writeFsync(`${SITE}/data/data.json.tmp`, json);
renameSync(`${SITE}/data/data.json.tmp`, `${SITE}/data/data.json`);

// Seed/update the baseline the next run gates against.
copyFileSync(WB, lastWbPath);
writeFsync(lastMetaPath, JSON.stringify({
  workbook_sha256: wbSha, rules, reference_date: REF_DATE,
  generated_at: artefact.meta.generated_at, archive_key: archiveKey,
}, null, 2));

const v = artefact.meta.validator;
console.log(`\nPUBLISHED ${SITE}/data/data.json — workbook ${wbSha.slice(0, 8)} · ${v.error}E/${v.warn}W/${v.info}I · archive data-${archiveKey}.json`);
