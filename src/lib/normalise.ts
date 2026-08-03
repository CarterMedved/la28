/**
 * Team-name normalisation shared by the app and the validator.
 * Extracted verbatim from qualification-app.jsx — fixtures name squads
 * ("Sri Lanka Women", "USA U-20"); rankings name nations ("Sri Lanka").
 * Both sides meet on this key. Change it here and only here.
 */
export const ALIAS: Record<string, string> = {
  usa: "united states", "u.s.a.": "united states", uae: "united arab emirates",
  png: "papua new guinea", "chinese taipei": "chinese taipei",
  "west indies": "west indies", holland: "netherlands",
  // FIBA's ranking page abbreviates some nations; fixtures spell them out.
  "korea": "south korea", "bosnia and herz": "bosnia and herzegovina",
  "dominican rep": "dominican republic", "congo dr": "dr congo",
  "central african rep": "central african republic",
  // Deliberately NO "great britain" → "england" entry: that is a directional,
  // sport-scoped fact (England represents GB in ICC events; in football they
  // are distinct teams), and ALIAS is global and symmetric. It is declared
  // per-row instead, via Standings.represents_noc.
};

export const teamKey = (t: unknown): string => {
  let k = String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")  // accent fold: Côte/Cote, Türkiye/Turkiye meet
    .toLowerCase().trim()
    .replace(/\b(women|men|womens|mens|women's|men's)\b/g, "")
    .replace(/\bu-?\d+\b/g, "")
    .replace(/\b(a|xi|emerging|development)\b$/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ").trim();
  return ALIAS[k] || k;
};
