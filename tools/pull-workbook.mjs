/**
 * Stage-four step 3: the pull (docs/stage-four.md §2). Exports the pinned
 * Google Sheet as xlsx using a service account — no interactive auth, no
 * Google SDK (a JWT signed with node:crypto, exchanged for a bearer token).
 *
 * Configuration (environment, both required):
 *   LA28_SA_KEY         service-account key: either the JSON itself or a
 *                       path to it. The account needs NO IAM roles; the
 *                       spreadsheet is shared to its client_email as
 *                       Viewer, and the token is requested with the
 *                       drive.readonly scope — it can read exactly the
 *                       files shared with it and write nothing, anywhere.
 *   LA28_SPREADSHEET_ID the pinned spreadsheet id (not secret; config).
 *
 * FAIL-CLOSED: every failure exits non-zero BEFORE the gate/emit/publish
 * chain runs, so a broken or revoked credential publishes nothing and the
 * last published artefact stands. Distinct exit codes:
 *   2 = missing/unparseable configuration
 *   3 = token exchange refused (key revoked, deleted, or clock-skewed)
 *   4 = export failed (sheet unshared, moved, deleted, or wrong id)
 *
 * Usage: node tools/pull-workbook.mjs --out pulled.xlsx
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, createSign } from "node:crypto";

const die = (code, msg) => {
  console.error(`PULL FAIL (${msg})`);
  console.error("Publishing nothing; the last published artefact stands.");
  process.exit(code);
};

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : "pulled.xlsx";

const rawKey = process.env.LA28_SA_KEY;
const SHEET_ID = process.env.LA28_SPREADSHEET_ID;
if (!rawKey) die(2, "LA28_SA_KEY is not set");
if (!SHEET_ID) die(2, "LA28_SPREADSHEET_ID is not set");
let sa;
try {
  sa = JSON.parse(rawKey.trim().startsWith("{") ? rawKey : readFileSync(rawKey, "utf8"));
  if (!sa.client_email || !sa.private_key) throw new Error("not a service-account key");
} catch (e) {
  die(2, `LA28_SA_KEY unusable: ${e.message}`);
}

// JWT → access token (RS256, drive.readonly only).
const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = b64u({ alg: "RS256", typ: "JWT" }) + "." + b64u({
  iss: sa.client_email,
  scope: "https://www.googleapis.com/auth/drive.readonly",
  aud: "https://oauth2.googleapis.com/token",
  iat: now, exp: now + 600,
});
const jwt = unsigned + "." + createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");

let token;
try {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(`${r.status} ${j.error ?? ""} ${j.error_description ?? ""}`.trim());
  token = j.access_token;
} catch (e) {
  die(3, `token exchange refused — key revoked, account deleted, or clock skew: ${e.message}`);
}

// Reach check: list what the account can actually see, every run — the
// "shared with exactly one file" claim is verified, not assumed. Non-fatal:
// over-sharing doesn't corrupt the pull (we export by pinned id below), and
// a hard fail here would let an unrelated share break publishing; the
// warning makes the drift visible in every run log instead.
try {
  const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=files(id,name)&pageSize=100&q=trashed%3Dfalse",
    { headers: { authorization: `Bearer ${token}` } });
  if (r.ok) {
    const { files = [] } = await r.json();
    console.log(`reach: ${sa.client_email} can list ${files.length} file(s)`);
    for (const f of files) console.log(`  ${f.id === SHEET_ID ? "pinned  " : "EXTRA   "} ${f.name} (${f.id})`);
    const extras = files.filter(f => f.id !== SHEET_ID);
    if (extras.length)
      console.log(`REACH WARNING: ${extras.length} file(s) beyond the pinned spreadsheet are shared with this account — un-share them.`);
    if (!files.some(f => f.id === SHEET_ID))
      console.log("note: pinned sheet not in the listing (listing can lag or be scoped); the export below is the authoritative access test.");
  } else {
    console.log(`reach check skipped (list returned ${r.status}); the export below is the authoritative access test.`);
  }
} catch (e) {
  console.log(`reach check skipped (${e.message}); the export below is the authoritative access test.`);
}

// Drive export of the pinned sheet as xlsx.
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let bytes;
try {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(SHEET_ID)}/export?mimeType=${encodeURIComponent(MIME)}`,
    { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error("response is not an xlsx (zip magic missing)");
} catch (e) {
  die(4, `export failed — sheet unshared with ${sa.client_email}, moved, or wrong id: ${e.message}`);
}

writeFileSync(OUT, bytes);
const sha = createHash("sha256").update(bytes).digest("hex");
console.log(`pulled ${SHEET_ID} -> ${OUT} (${bytes.length} bytes, sha256 ${sha})`);
