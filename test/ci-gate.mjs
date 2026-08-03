/**
 * Step-3 gate harness: every classification branch of tools/pull-gate.mjs
 * proven by spawning the CLI on mutant workbooks — exit codes, not just
 * return values, because the exit code is the control.
 *
 * Baseline strategy: the unmutated workbook is first rewritten through the
 * same AoA path as the mutants, so representation differences (cell types,
 * formats) never enter the diff — only the mutation does.
 *
 * Directions proven:
 *   - identical books           → pass, zero changes
 *   - routine edit/addition     → pass without any ack
 *   - gated edit, no ack        → FAIL, digest printed
 *   - gated edit, correct ack   → pass, ack NAMED
 *   - C→B riding an A→B ack     → FAIL (old value is in the digest)
 *   - row deletion, routine tab → FAIL (deletions gated everywhere)
 *   - Competitions column grain → status flows, teams_count gates
 *   - Competitions col-add      → FAIL (schema changes gated)
 */
import XLSX from "xlsx";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const SRC = root + "data/LA28_Qualification_Database.xlsx";
const DIR = root + "test/mutants/gate/";
mkdirSync(DIR, { recursive: true });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

function readAoA() {
  const wb = XLSX.read(readFileSync(SRC));
  const out = {};
  for (const n of wb.SheetNames) out[n] = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: null });
  return out;
}
function writeAoA(aoa, path) {
  const wb = XLSX.utils.book_new();
  for (const [n, rows] of Object.entries(aoa)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), n);
  XLSX.writeFile(wb, path);
}
const col = (aoa, sheet, name) => aoa[sheet][0].indexOf(name);
function findRow(aoa, sheet, name, pred) {
  const c = col(aoa, sheet, name);
  for (let i = 1; i < aoa[sheet].length; i++) if (pred(aoa[sheet][i][c])) return i;
  throw new Error(`no row in ${sheet} where ${name} matches`);
}
const clone = aoa => JSON.parse(JSON.stringify(aoa));

const BASE = DIR + "base.xlsx";
writeAoA(readAoA(), BASE);

/** run the gate CLI; returns {code, out} */
function gate(prev, pulled, acksPath) {
  const argv = [root + "tools/pull-gate.mjs", prev, pulled];
  if (acksPath) argv.push("--acks", acksPath);
  else argv.push("--acks", DIR + "no-acks.json");   // never the repo's real ack file
  try {
    return { code: 0, out: execFileSync("node", argv, { stdio: "pipe" }).toString() };
  } catch (e) {
    return { code: e.status, out: (e.stdout ?? "").toString() + (e.stderr ?? "").toString() };
  }
}
const mutant = (name, fn) => {
  const aoa = readAoA(); fn(aoa);
  const p = DIR + name + ".xlsx"; writeAoA(aoa, p); return p;
};

// 1. Identical workbooks: pass, zero changes.
{
  const r = gate(BASE, BASE);
  check("identical workbooks pass with zero changes", r.code === 0 && /gated changes: 0/.test(r.out), r.out.slice(0, 200));
}

// 2. Routine edit (Standings points) flows through with no ack.
{
  const p = mutant("routine-standings", aoa => {
    const i = findRow(aoa, "Standings", "team", v => v === "Belgium");
    aoa["Standings"][i][col(aoa, "Standings", "points")] = "999.9";
  });
  const r = gate(BASE, p);
  check("routine Standings edit passes without ack", r.code === 0 && /routine changes \(flow through\): [1-9]/.test(r.out), r.out.slice(0, 300));
}

// 3. Routine addition (new Fixtures row) flows through.
{
  const p = mutant("routine-fx-add", aoa => {
    const head = aoa["Fixtures"][0];
    const row = head.map(() => null);
    row[col(aoa, "Fixtures", "fixture_id")] = "fx-9999";
    row[col(aoa, "Fixtures", "competition_id")] = "2026-fiba-women-s-basketball-world-cup";
    aoa["Fixtures"].push(row);
  });
  const r = gate(BASE, p);
  check("Fixtures row addition passes (additions on routine tabs flow through)", r.code === 0, r.out.slice(0, 300));
}

// 4/5/6. Gated edit on Links: blocked bare; passes with the exact ack, named;
// a C→B change cannot ride the A→B ack.
{
  const iLinks = (aoa) => findRow(aoa, "Links", "entry_condition", v => v && v.length > 3);
  const pB = mutant("gated-links", aoa => {
    const i = iLinks(aoa);
    aoa["Links"][i][col(aoa, "Links", "entry_condition")] = "MUTATED ENTRY CONDITION";
  });
  const bare = gate(BASE, pB);
  const digest = bare.out.match(/digest: ([0-9a-f]{64})/)?.[1];
  check("gated Links edit FAILS without ack and prints the digest", bare.code === 1 && !!digest, bare.out.slice(0, 400));

  const acks = DIR + "acks.json";
  writeFileSync(acks, JSON.stringify({ acks: [{ digest, note: "test ack: entry_condition rewrite", date: "2026-08-03" }] }));
  const acked = gate(BASE, pB, acks);
  check("same edit PASSES with the committed ack, which is NAMED in the output",
    acked.code === 0 && /acknowledged: "test ack: entry_condition rewrite"/.test(acked.out), acked.out.slice(0, 400));

  // Different OLD value (C→B): baseline's cell rewritten to C, same new value B.
  const prevC = mutant("gated-links-prevC", aoa => {
    const i = iLinks(aoa);
    aoa["Links"][i][col(aoa, "Links", "entry_condition")] = "A DIFFERENT ORIGINAL VALUE";
  });
  const ride = gate(prevC, pB, acks);
  check("C→B change FAILS against the A→B ack (old value is in the digest)", ride.code === 1, ride.out.slice(0, 400));
}

// 7. Row deletion on a routine tab is gated.
{
  const p = mutant("fx-delete", aoa => {
    const i = findRow(aoa, "Fixtures", "fixture_id", v => v === "fx-0026");
    aoa["Fixtures"].splice(i, 1);
  });
  const r = gate(BASE, p);
  check("Fixtures row DELETION fails the gate (deletions gated on every tab)",
    r.code === 1 && /Fixtures·fx-0026··row-del/.test(r.out), r.out.slice(0, 400));
}

// 8. Competitions column grain: status routine, teams_count gated.
{
  const iComp = (aoa) => findRow(aoa, "Competitions", "competition_id", v => v === "2026-fiba-women-s-basketball-world-cup");
  const pStatus = mutant("comp-status", aoa => {
    aoa["Competitions"][iComp(aoa)][col(aoa, "Competitions", "status")] = "COMPLETED";
  });
  const rs = gate(BASE, pStatus);
  check("Competitions status edit is routine (column grain)", rs.code === 0, rs.out.slice(0, 300));

  const pTeams = mutant("comp-teams", aoa => {
    aoa["Competitions"][iComp(aoa)][col(aoa, "Competitions", "teams_count")] = "99";
  });
  const rt = gate(BASE, pTeams);
  check("Competitions teams_count edit is GATED (column grain)",
    rt.code === 1 && /Competitions·.*·teams_count·cell/.test(rt.out), rt.out.slice(0, 400));
}

// 9. Column addition on Competitions is gated.
{
  const p = mutant("comp-col-add", aoa => {
    aoa["Competitions"][0].push("surprise_column");
  });
  const r = gate(BASE, p);
  check("Competitions column addition fails the gate",
    r.code === 1 && /col-add/.test(r.out), r.out.slice(0, 400));
}

// 10/11. MISSING BASELINE fails closed; an acked bootstrap publishes. Both
// directions through the real ci-publish chain (real validator, real emit)
// on the real workbook, in scratch dirs.
{
  const S = DIR + "bootstrap-test/";
  const publishArgv = acks => [root + "tools/ci-publish.mjs",
    "--workbook", root + "data/LA28_Qualification_Database_v22.xlsx",
    "--site", S + "site", "--state", S + "state",
    "--reference-date", "2026-08-03", "--acks", acks];
  const runPub = acks => {
    try { return { code: 0, out: execFileSync("node", publishArgv(acks), { stdio: "pipe" }).toString() }; }
    catch (e) { return { code: e.status, out: (e.stdout ?? "").toString() + (e.stderr ?? "").toString() }; }
  };
  execFileSync("rm", ["-rf", S]);
  const bare = runPub(DIR + "no-acks.json");
  const digest = bare.out.match(/"digest": "([0-9a-f]{64})"/)?.[1];
  check("missing baseline BLOCKS the chain (exit 1, bootstrap digest printed, nothing published)",
    bare.code === 1 && /NO BASELINE FOUND/.test(bare.out) && !!digest && !existsSync(S + "site/data/data.json"),
    bare.out.slice(0, 300));
  const bAcks = DIR + "bootstrap-acks.json";
  writeFileSync(bAcks, JSON.stringify({ acks: [{ digest, note: "bootstrap: test first publish", date: "2026-08-03" }] }));
  const booted = runPub(bAcks);
  check("acked bootstrap PUBLISHES, names the ack, and drops the publish marker",
    booted.code === 0 && /bootstrap acknowledged: "bootstrap: test first publish"/.test(booted.out)
      && /PUBLISHED/.test(booted.out) && existsSync(S + "site/data/data.json")
      && existsSync(S + "state/publish-happened"),
    booted.out.slice(-400));
}

// tz↔tz_source coupling: the gate REFUSES (pre-ack) a tz change that leaves
// its marker untouched; changing both together is ordinary gated flow.
{
  const withTzCols = (mutFn) => {
    const aoa = readAoA();
    const H = aoa["Fixtures"][0]; H.push("tz", "tz_source");
    const cT = H.length - 2, cS = H.length - 1;
    for (let i = 1; i < aoa["Fixtures"].length; i++) {
      const r = aoa["Fixtures"][i];
      while (r.length < H.length) r.push(null);
    }
    aoa["Fixtures"][1][cT] = "America/New_York";
    aoa["Fixtures"][1][cS] = "DERIVED (test): premise recorded here";
    if (mutFn) mutFn(aoa, cT, cS);
    return aoa;
  };
  const tzBase = DIR + "tz-base.xlsx";
  writeAoA(withTzCols(null), tzBase);
  const tzAlone = DIR + "tz-alone.xlsx";
  writeAoA(withTzCols((aoa, cT) => { aoa["Fixtures"][1][cT] = "America/Chicago"; }), tzAlone);
  const r1 = gate(tzBase, tzAlone);
  check("tz changed alone is REFUSED pre-ack (stale marker), not offered a digest",
    r1.code === 1 && /GATE REFUSED \(not acknowledgeable\)/.test(r1.out) && !/digest:/.test(r1.out),
    r1.out.slice(0, 300));
  const tzBoth = DIR + "tz-both.xlsx";
  writeAoA(withTzCols((aoa, cT, cS) => {
    aoa["Fixtures"][1][cT] = "America/Chicago";
    aoa["Fixtures"][1][cS] = "RESEARCHED: organiser listing (test)";
  }), tzBoth);
  const r2 = gate(tzBase, tzBoth);
  check("tz + tz_source changed together flows as routine (Fixtures cells; coupling satisfied, no refusal)",
    r2.code === 0 && /routine changes \(flow through\): 2/.test(r2.out) && !/GATE REFUSED/.test(r2.out),
    r2.out.slice(0, 300));
}

// Baseline integrity: present-but-wrong is exit 3 with no bootstrap recipe —
// a different path from "no baseline" in both code and message.
{
  const S = DIR + "bootstrap-test/";   // state seeded by the bootstrap test above
  const runPub = () => {
    try {
      return { code: 0, out: execFileSync("node", [root + "tools/ci-publish.mjs",
        "--workbook", root + "data/LA28_Qualification_Database_v22.xlsx",
        "--site", S + "site", "--state", S + "state",
        "--reference-date", "2026-08-03", "--acks", DIR + "no-acks.json"], { stdio: "pipe" }).toString() };
    } catch (e) { return { code: e.status, out: (e.stdout ?? "").toString() + (e.stderr ?? "").toString() }; }
  };
  const wbPath = S + "state/last-published.xlsx";
  const goodBytes = readFileSync(wbPath);
  writeFileSync(wbPath, Buffer.concat([goodBytes, Buffer.from([0])]));   // corrupt: sha no longer matches meta
  const tampered = runPub();
  check("baseline present-but-wrong exits 3, names both hashes, offers NO bootstrap recipe",
    tampered.code === 3 && /BASELINE INTEGRITY FAILURE/.test(tampered.out)
      && /do NOT commit a bootstrap ack/.test(tampered.out) && !/"digest":/.test(tampered.out),
    `exit ${tampered.code}: ${tampered.out.slice(0, 300)}`);
  writeFileSync(wbPath, goodBytes);
  const metaPath = S + "state/last-published-meta.json";
  const goodMeta = readFileSync(metaPath);
  execFileSync("rm", [metaPath]);
  const half = runPub();
  check("half a baseline (meta missing) is an integrity failure, not a fresh start",
    half.code === 3 && /Half a baseline/.test(half.out), `exit ${half.code}: ${half.out.slice(0, 300)}`);
  writeFileSync(metaPath, goodMeta);
}

// Baseline source preference: the archive-branch checkout outranks the
// state cache; a half-pair on the branch fails integrity rather than
// falling back; an empty branch dir falls through to the cache; a skip run
// leaves no publish marker.
{
  const S = DIR + "bootstrap-test/";           // valid baseline pair lives in S/state after the tests above
  const run = (stateDir, branchDir) => {
    const argv = [root + "tools/ci-publish.mjs",
      "--workbook", root + "data/LA28_Qualification_Database_v22.xlsx",
      "--site", S + "site", "--state", stateDir,
      "--reference-date", "2026-08-03", "--acks", DIR + "no-acks.json"];
    if (branchDir) argv.push("--branch-baseline", branchDir);
    try { return { code: 0, out: execFileSync("node", argv, { stdio: "pipe" }).toString() }; }
    catch (e) { return { code: e.status, out: (e.stdout ?? "").toString() + (e.stderr ?? "").toString() }; }
  };
  const branchDir = DIR + "branch-sim/";
  mkdirSync(branchDir + "state", { recursive: true });
  writeFileSync(branchDir + "state/last-published.xlsx", readFileSync(S + "state/last-published.xlsx"));
  writeFileSync(branchDir + "state/last-published-meta.json", readFileSync(S + "state/last-published-meta.json"));

  const emptyCache = DIR + "empty-cache/";
  execFileSync("rm", ["-rf", emptyCache]);
  const r1 = run(emptyCache, branchDir);
  check("branch baseline outranks an EMPTY cache (source line says archive branch, run skips clean)",
    r1.code === 0 && /baseline source: archive branch/.test(r1.out) && /SKIP PUBLISH/.test(r1.out)
      && !existsSync(emptyCache + "publish-happened"),
    r1.out.slice(0, 300));

  const halfBranch = DIR + "branch-half/";
  mkdirSync(halfBranch + "state", { recursive: true });
  writeFileSync(halfBranch + "state/last-published-meta.json", readFileSync(S + "state/last-published-meta.json"));
  const r2 = run(S + "state", halfBranch);
  check("half-pair on the branch is exit 3, NEVER a fallback to the valid cache",
    r2.code === 3 && /Half a baseline/.test(r2.out), `exit ${r2.code}: ${r2.out.slice(0, 300)}`);

  const r3 = run(S + "state", DIR + "branch-empty-nonexistent/");
  check("empty branch dir falls through to the state cache (source line says state cache)",
    r3.code === 0 && /baseline source: state cache/.test(r3.out) && /SKIP PUBLISH/.test(r3.out),
    r3.out.slice(0, 300));
}

// Dual-hash: a byte-DIFFERENT but content-IDENTICAL workbook (the measured
// behaviour of Google's export) must SKIP, not republish — content drives
// identity; raw bytes keep only the baseline integrity job.
{
  const S = DIR + "bootstrap-test/";
  const tmp = DIR + "rezip-tmp", variant = DIR + "v21-rezip.xlsx";
  execFileSync("rm", ["-rf", tmp, variant]);
  mkdirSync(tmp, { recursive: true });
  execFileSync("unzip", ["-q", root + "data/LA28_Qualification_Database_v22.xlsx", "-d", tmp]);
  execFileSync("zip", ["-q", "-r", "-X", "-9", variant, "."], { cwd: tmp });
  const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex");
  const bytesDiffer = sha(variant) !== sha(root + "data/LA28_Qualification_Database_v22.xlsx");
  let r;
  try {
    r = { code: 0, out: execFileSync("node", [root + "tools/ci-publish.mjs",
      "--workbook", variant, "--site", S + "site", "--state", S + "state",
      "--reference-date", "2026-08-03", "--acks", DIR + "no-acks.json"], { stdio: "pipe" }).toString() };
  } catch (e) { r = { code: e.status, out: (e.stdout ?? "").toString() + (e.stderr ?? "").toString() }; }
  check("byte-different content-identical workbook SKIPS (dual-hash: content is the identity)",
    bytesDiffer && r.code === 0 && /SKIP PUBLISH — workbook content/.test(r.out),
    `bytesDiffer=${bytesDiffer} exit=${r.code}: ${r.out.slice(0, 300)}`);
  const meta = JSON.parse(readFileSync(S + "state/last-published-meta.json", "utf8"));
  check("baseline meta records BOTH hashes (raw for integrity, content for identity)",
    /^[0-9a-f]{64}$/.test(meta.workbook_sha256) && /^[0-9a-f]{64}$/.test(meta.content_sha256)
      && meta.workbook_sha256 !== meta.content_sha256);
}

// 12. The pull fails closed on missing configuration (exit 2, publishes nothing).
{
  let code = 0, out = "";
  try {
    execFileSync("node", [root + "tools/pull-workbook.mjs", "--out", DIR + "never-written.xlsx"],
      { stdio: "pipe", env: { ...process.env, LA28_SA_KEY: "", LA28_SPREADSHEET_ID: "" } });
  } catch (e) { code = e.status; out = (e.stderr ?? "").toString(); }
  check("pull-workbook fails closed without credentials (exit 2, 'publishes nothing' stated)",
    code === 2 && /Publishing nothing; the last published artefact stands/.test(out), `exit ${code}: ${out.slice(0, 200)}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : "\nGate proven in both directions: routine flows, gated blocks, acks match on old+new only.");
process.exit(failures ? 1 : 0);
