/**
 * Booster stat vocabularies — the bridge between Real's per-sport booster stat
 * keys (read off the live `userpassboostercards` inventory) and each card's
 * position.
 *
 * Every key a sport can hand you in a pack is listed here, so no owned booster
 * is ever silently unshowable: the plan walks the list in order and takes the
 * first key that is actually in stock. Order = expected rax value for that
 * position (stat volume × the booster's per-unit rate), highest first.
 *
 * Real's hockey/baseball keys (in nhl-dash / boost-plan) are untouched; these
 * are the basketball and football vocabularies, which previously fell through
 * to the generic baseball-oriented default and landed on the wrong stats.
 */

// ── Basketball (NBA · WNBA) ────────────────────────────────────────────────
// 1 PTS · 2 AST · 3 REB · 4 STL · 5 BLK · 21 3PM
const HOOPS_GUARD = ["1", "2", "21", "4", "3", "5"]; // PTS · AST · 3PM · STL · REB · BLK
const HOOPS_WING = ["1", "3", "21", "2", "4", "5"]; // PTS · REB · 3PM · AST · STL · BLK
const HOOPS_BIG = ["3", "1", "5", "2", "4", "21"]; // REB · PTS · BLK · AST · STL · 3PM
const HOOPS_ANY = ["1", "3", "2", "21", "4", "5"]; // PTS · REB · AST · 3PM · STL · BLK

/** Basketball position → booster stat keys. Accepts Real's `infoDetail`
 * ("PG"/"SG"/"C"/"G-F") and/or ESPN's abbreviation; either may be empty. */
export function hoopsStats(
  ...positions: (string | null | undefined)[]
): string[] {
  const p = positions
    .filter(Boolean)
    .join(" ")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (!p) return HOOPS_ANY;
  if (p.includes("C") || p.startsWith("PF")) return HOOPS_BIG; // C, C-F, PF
  if (p.includes("F")) return HOOPS_WING; // SF, F, G-F, F-G
  if (p.includes("G")) return HOOPS_GUARD; // PG, SG, G
  return HOOPS_ANY;
}

// ── Football (NFL · CFB) ───────────────────────────────────────────────────
// NFL composite keys: 3_135 TD·INT · 30_132 PTD·FF · 60_129 RUYDS·SACK ·
// 92_124 REC·TKL · 127_164 TFL·FGM
// CFB single keys: 3 TD · 30 PTD · 60 RUYDS · 92 REC (no defense/FG stat)
const NFL = {
  qb: ["30_132", "3_135", "60_129"],
  rb: ["60_129", "3_135", "92_124"],
  rec: ["92_124", "3_135", "60_129"],
  def: ["92_124", "60_129", "3_135", "30_132", "127_164"],
  k: ["127_164"],
  any: ["3_135", "30_132", "60_129", "92_124", "127_164"],
};
const CFB = {
  qb: ["30", "3", "60"],
  rb: ["60", "3", "92"],
  rec: ["92", "3", "60"],
  def: ["92", "3", "60", "30"],
  k: ["3", "30", "60", "92"],
  any: ["3", "30", "60", "92"],
};

/** Football position → booster stat keys. NFL carries defensive/FG keys, CFB
 * does not (a CFB kicker falls back to the offensive list). */
export function footballStats(
  league: "nfl" | "cfb",
  ...positions: (string | null | undefined)[]
): string[] {
  const T = league === "nfl" ? NFL : CFB;
  const p = positions
    .filter(Boolean)
    .join(" ")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (!p) return T.any;
  if (/^(QB|Q)/.test(p)) return T.qb;
  if (/^(K|PK)/.test(p)) return T.k;
  if (/^(RB|FB|HB|TB)/.test(p)) return T.rb;
  if (/^(WR|TE)/.test(p)) return T.rec;
  if (/(DL|DE|DT|NT|LB|CB|DB|FS|SS|S$|EDGE|DEF)/.test(p)) return T.def;
  return T.any;
}
