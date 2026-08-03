/**
 * Local rehearsal of the CI publish chain against a FRESH CHECKOUT — the
 * environment CI actually runs in and no local run naturally has. Run 1 of
 * the real pipeline died on exactly that gap: .ci-state/ existed on the dev
 * machine as a side effect of every local run and had never existed in CI,
 * so pull-workbook wrote into a directory nothing creates.
 *
 * The scratch tree holds ONLY tracked files (working-tree content, git
 * ls-files), matching actions/checkout: gitignored local side effects
 * (.ci-state/, site/, node_modules/, test/.build/) are absent by
 * construction. Then the workflow's own commands run in order:
 *
 *   npm ci
 *   pull (LA28_PULL_STUB seam — no network, no credentials; same magic
 *         check and write path as a real pull)
 *   ci-publish run 1  → must be the DESIGNED failure: exit 1,
 *                       NO BASELINE FOUND, bootstrap digest printed
 *   ack the digest    → pull-acks.json, as the runbook prescribes
 *   ci-publish run 2  → must publish; asserts every path the workflow's
 *                       upload steps and the archive job's cp lines expect
 *   ci-publish run 3  → must SKIP: exit 0, no publish-happened marker
 *                       (Pages + archive jobs would be skipped), data.json
 *                       byte-identical
 *
 * Fail-closed negatives, all asserting the standing message — an
 * unexpected raw stack trace is itself a failure here:
 *   no configuration      → exit 2
 *   stub bytes not xlsx   → exit 4
 *   out-dir mkdir removed → exit 5 (the run-1 defect, re-introduced in the
 *                           scratch copy only, must now fail LEGIBLY)
 *
 * Usage: node test/ci-rehearsal.mjs   (needs network for npm ci)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync,
         mkdtempSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const STANDING = "Publishing nothing; the last published artefact stands.";

// Env as CI would have it for these steps: no LA28_* secrets, and no CI var
// (the stub seam refuses under CI — that refusal gets its own check).
const baseEnv = Object.fromEntries(Object.entries(process.env)
  .filter(([k]) => !k.startsWith("LA28_") && k !== "CI"));

let passed = 0;
const fail = (label, detail, out) => {
  console.error(`✗ ${label}: ${detail}`);
  if (out) console.error(`--- output ---\n${out}`);
  process.exit(1);
};
const ok = label => { passed++; console.log(`✓ ${label}`); };
const assertFile = (label, p) => existsSync(p) ? ok(label) : fail(label, `missing ${p}`);

const run = (label, argv, { cwd, env = {}, expectCode = 0, expectOut = [], forbidOut = [] } = {}) => {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env: { ...baseEnv, ...env }, encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  if (r.status !== expectCode) fail(label, `exit ${r.status}, expected ${expectCode}`, out);
  for (const s of expectOut) if (!out.includes(s)) fail(label, `output missing ${JSON.stringify(s)}`, out);
  for (const s of forbidOut) if (out.includes(s)) fail(label, `output contains forbidden ${JSON.stringify(s)}`, out);
  ok(label);
  return out;
};

// -- scratch checkout: tracked files only, working-tree content ------------
const scratch = mkdtempSync(join(tmpdir(), "la28-rehearsal-"));
const ls = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" });
if (ls.status !== 0) fail("scratch checkout", "git ls-files failed", ls.stderr);
const tracked = ls.stdout.split("\0").filter(Boolean);
for (const f of tracked) {
  mkdirSync(join(scratch, dirname(f)), { recursive: true });
  copyFileSync(join(repo, f), join(scratch, f));
}
console.log(`scratch checkout: ${tracked.length} tracked files -> ${scratch}`);
if (existsSync(join(scratch, ".ci-state"))) fail("scratch checkout", ".ci-state leaked into scratch");

run("npm ci (fresh, as the workflow does)", ["npm", "ci", "--no-audit", "--no-fund"], { cwd: scratch });

const WORKBOOK = "data/LA28_Qualification_Database_v22.xlsx";
const PULL = ["node", "tools/pull-workbook.mjs", "--out", ".ci-state/pulled.xlsx"];
const CHAIN = ["node", "tools/ci-publish.mjs", "--workbook", ".ci-state/pulled.xlsx",
               "--site", "site", "--branch-baseline", ".archive-branch"];  // the workflow's exact line

// -- fail-closed negatives -------------------------------------------------
run("pull with no configuration → exit 2 + standing message", PULL,
  { cwd: scratch, expectCode: 2, expectOut: [STANDING] });
run("stub bytes that are not an xlsx → exit 4 + standing message", PULL,
  { cwd: scratch, env: { LA28_PULL_STUB: "package.json" }, expectCode: 4, expectOut: [STANDING] });
run("stub refuses when CI is set → exit 2", PULL,
  { cwd: scratch, env: { LA28_PULL_STUB: WORKBOOK, CI: "true" }, expectCode: 2, expectOut: [STANDING] });

// The run-1 defect, re-introduced in the SCRATCH copy only: strip the
// mkdirSync from the write path and the same pull must now fail legibly —
// numbered exit, named cause, standing message, no raw stack.
const pwPath = join(scratch, "tools/pull-workbook.mjs");
const pwOrig = readFileSync(pwPath, "utf8");
const pwBroken = pwOrig.replace(/^\s*mkdirSync\(dirname\(OUT\), \{ recursive: true \}\);\n/m, "");
if (pwBroken === pwOrig) fail("defect reintroduction", "mkdirSync line not found to strip — harness is stale");
writeFileSync(pwPath, pwBroken);
run("run-1 defect reintroduced → exit 5, cause named, no raw stack", PULL,
  { cwd: scratch, env: { LA28_PULL_STUB: WORKBOOK }, expectCode: 5,
    expectOut: ["PULL FAIL", "cannot write pulled workbook", STANDING],
    forbidOut: ["at file://"] });
writeFileSync(pwPath, pwOrig);

// -- the three-run sequence, exactly as the runbook describes --------------
run("pull (stub) into fresh .ci-state → exit 0", PULL,
  { cwd: scratch, env: { LA28_PULL_STUB: WORKBOOK } });
assertFile("pulled workbook written on a fresh checkout", join(scratch, ".ci-state/pulled.xlsx"));

const run1 = run("run 1: DESIGNED failure — exit 1, NO BASELINE FOUND, digest printed", CHAIN,
  { cwd: scratch, expectCode: 1, expectOut: ["NO BASELINE FOUND", "BOOTSTRAP"] });
const digest = run1.match(/"digest": "([0-9a-f]{64})"/)?.[1];
if (!digest) fail("run 1", "no 64-hex bootstrap digest in output", run1);
ok("bootstrap digest extracted");

const acksPath = join(scratch, "pull-acks.json");
const acks = JSON.parse(readFileSync(acksPath, "utf8"));
acks.acks.push({ digest, note: "bootstrap: local rehearsal", date: "rehearsal" });
writeFileSync(acksPath, JSON.stringify(acks, null, 2));

run("run 2: bootstrap acked → publishes", CHAIN,
  { cwd: scratch, expectCode: 0, expectOut: ["bootstrap acknowledged"] });
// Every path the workflow's conditional upload + the archive job's cp lines depend on:
assertFile("publish-happened marker (outcome step, archive condition)", join(scratch, ".ci-state/publish-happened"));
assertFile("baseline workbook (archive cp)", join(scratch, ".ci-state/last-published.xlsx"));
assertFile("baseline meta (archive cp)", join(scratch, ".ci-state/last-published-meta.json"));
assertFile("live artefact (Pages)", join(scratch, "site/data/data.json"));
const archived = readdirSync(join(scratch, "site/data/archive")).filter(f => f.startsWith("data-"));
archived.length ? ok("archive entry written") : fail("archive entry", "no data-*.json in site/data/archive");
const meta = JSON.parse(readFileSync(join(scratch, ".ci-state/last-published-meta.json"), "utf8"));
for (const k of ["workbook_sha256", "content_sha256"])
  meta[k]?.length === 64 ? ok(`meta carries ${k} (archive commit message reads it)`) : fail("meta", `bad ${k}`);

const dataBefore = readFileSync(join(scratch, "site/data/data.json"));
run("run 3: untouched workbook → SKIP, exit 0", CHAIN,
  { cwd: scratch, expectCode: 0, expectOut: ["SKIP PUBLISH"] });
existsSync(join(scratch, ".ci-state/publish-happened"))
  ? fail("run 3", "publish-happened marker present on a SKIP run — Pages/archive would wrongly run")
  : ok("no marker on SKIP (Pages + archive jobs would be skipped)");
dataBefore.equals(readFileSync(join(scratch, "site/data/data.json")))
  ? ok("data.json byte-identical after SKIP")
  : fail("run 3", "data.json changed on a SKIP run");

rmSync(scratch, { recursive: true, force: true });
console.log(`\nCI REHEARSAL PASS — ${passed} checks (scratch removed)`);
