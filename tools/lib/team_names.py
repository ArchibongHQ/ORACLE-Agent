"""
team_names.py — Single source of truth for team-name normalisation (audit M2-1).

Every Python tool that joins match data across sources MUST use
``normalise_team`` so that football-data.co.uk abbreviations ("Man United",
"Nott'm Forest", "Sheffield Utd", "Wolves"), Understat full names
("Manchester United", "Paris Saint Germain"), Beat-the-Bookie/odds-portal
names ("Newcastle Utd", "B. Monchengladbach") and slehkyi/Kaggle variants all
collapse to the SAME canonical key.

Semantics (inherited from gbm_residual.py, the historical base):
  lowercase -> strip non-alphanumerics (keep spaces) -> collapse whitespace
  -> alias lookup.

Guarantees enforced at import time:
  * every key in TEAM_ALIASES is stored both raw-lowercased (so callers that
    look up pre-regex strings, e.g. scrape_fixtures country dedup, still hit)
    and regex-normalised;
  * every VALUE is a fixed point of ``normalise_team`` (alias chains are
    resolved), which makes ``normalise_team`` idempotent.

Merged alias sources (superset):
  - tools/gbm_residual.py  _TEAM_ALIASES   (base — wins on conflict)
  - tools/scrape_fixtures.py _COUNTRY_ALIASES
  - new entries closing the OTS/AH 0-hit join gap (fdco abbreviations vs
    Beat-the-Bookie / Understat full names).

NOT merged: gbm_residual._CLUBELO_ALIASES — it maps names to ClubElo DISPLAY
names ("Man City", "Nottm Forest") used as keys of the ClubElo ratings dict.
Merging it would conflict with every canonical value here and break Elo
lookups; it stays a provider-specific map in gbm_residual.py.
"""
from __future__ import annotations

import re

_NONALNUM_RE = re.compile(r"[^a-z0-9\s]")
_WS_RE = re.compile(r"\s+")


def _norm_raw(name: str) -> str:
    """Lowercase, strip punctuation/diacritics chars, collapse whitespace."""
    s = name.lower()
    s = _NONALNUM_RE.sub("", s)
    return _WS_RE.sub(" ", s).strip()


# Raw alias entries.  Keys may contain punctuation (they are normalised AND
# kept raw-lowercased); values are canonicalised + chain-resolved below.
_RAW_ALIASES: dict[str, str] = {
    # ── gbm_residual.py base (football-data.co.uk → Understat) ──
    "man city":              "manchester city",
    "man united":            "manchester united",
    "man utd":               "manchester united",
    "newcastle":             "newcastle united",
    "nott'm forest":         "nottingham forest",
    "nottm forest":          "nottingham forest",
    "wolves":                "wolverhampton wanderers",
    "spurs":                 "tottenham hotspur",
    "tottenham":             "tottenham hotspur",
    "west brom":             "west bromwich albion",
    "sheffield utd":         "sheffield united",
    "sheff utd":             "sheffield united",
    "sheff wed":             "sheffield wednesday",
    "leicester":             "leicester city",
    "brighton":              "brighton and hove albion",
    "norwich":               "norwich city",
    "cardiff":               "cardiff city",
    "swansea":               "swansea city",
    "stoke":                 "stoke city",
    "hull":                  "hull city",
    "ipswich":               "ipswich town",
    "luton":                 "luton town",
    "burnley":               "burnley",
    "brentford":             "brentford",
    "celta":                 "celta vigo",
    "atletico madrid":       "atletico de madrid",
    "atletico":              "atletico de madrid",
    "real betis":            "real betis",
    "betis":                 "real betis",
    "sociedad":              "real sociedad",
    "real sociedad":         "real sociedad",
    "hertha":                "hertha bsc",
    "hertha bsc berlin":     "hertha bsc",
    "rb leipzig":            "rasenballsport leipzig",
    "eintracht frankfurt":   "frankfurt",
    "bayer leverkusen":      "bayer 04 leverkusen",
    "leverkusen":            "bayer 04 leverkusen",
    "schalke":               "fc schalke 04",
    "schalke 04":            "fc schalke 04",
    "hannover":              "hannover 96",
    "mainz":                 "1 fsv mainz 05",
    "mainz 05":              "1 fsv mainz 05",
    "freiburg":              "sport-club freiburg",
    "sc freiburg":           "sport-club freiburg",
    "augsburg":              "fc augsburg",
    "wolfsburg":             "vfl wolfsburg",
    "inter":                 "internazionale",
    "inter milan":           "internazionale",
    "ac milan":              "milan",
    "verona":                "hellas verona",
    "hellas verona fc":      "hellas verona",
    "spal":                  "spal 2013",
    "chievo":                "chievo verona",
    "cagliari":              "cagliari",
    "psg":                   "paris saint-germain",
    "paris sg":              "paris saint-germain",
    "st etienne":            "saint-etienne",
    "saint etienne":         "saint-etienne",
    "lyon":                  "olympique lyonnais",
    "marseille":             "olympique de marseille",
    "nantes":                "fc nantes",
    "rennes":                "stade rennais fc",
    "stade rennais":         "stade rennais fc",
    "bordeaux":              "girondins de bordeaux",
    "lille":                 "losc lille",
    "losc":                  "losc lille",
    "monaco":                "as monaco",
    "nice":                  "ogc nice",
    "strasbourg":            "rc strasbourg alsace",
    "metz":                  "fc metz",
    "reims":                 "stade de reims",
    # ── bridges: old hyphenated canonicals → Understat raw-normalised form ──
    # (the gbm values above contain "-" which their own regex strips, so they
    #  never matched the Understat side; these entries chain-resolve the gap)
    "paris saintgermain":    "paris saint germain",
    "paris saint germain":   "paris saint germain",
    # ── OTS/AH gap: Beat-the-Bookie / odds-portal / Understat variants ──
    # England
    "newcastle utd":         "newcastle united",
    "nottingham":            "nottingham forest",
    "sheffield wed":         "sheffield wednesday",
    "sheffield weds":        "sheffield wednesday",
    "qpr":                   "queens park rangers",
    "peterboro":             "peterborough",
    "oxford utd":            "oxford",
    "oxford united":         "oxford",
    # Spain
    "ath madrid":            "atletico de madrid",
    "atl madrid":            "atletico de madrid",
    "ath bilbao":            "athletic club",
    "athletic bilbao":       "athletic club",
    "espanol":               "espanyol",
    "sp gijon":              "sporting gijon",
    "gijon":                 "sporting gijon",
    "vallecano":             "rayo vallecano",
    "granada cf":            "granada",
    "dep la coruna":         "la coruna",
    "deportivo la coruna":   "la coruna",
    "real valladolid":       "valladolid",
    # Germany
    "ein frankfurt":         "frankfurt",
    "m'gladbach":            "borussia monchengladbach",
    "mgladbach":             "borussia monchengladbach",
    "gladbach":              "borussia monchengladbach",
    "b monchengladbach":     "borussia monchengladbach",
    "borussia mgladbach":    "borussia monchengladbach",
    "borussia dortmund":     "dortmund",
    "bvb":                   "dortmund",
    "koln":                  "fc koln",
    "1 fc koln":             "fc koln",
    "fc cologne":            "fc koln",
    "cologne":               "fc koln",
    "hamburger sv":          "hamburg",
    "vfb stuttgart":         "stuttgart",
    "hertha berlin":         "hertha bsc",
    "sv werder bremen":      "werder bremen",
    "arminia bielefeld":     "bielefeld",
    "fortuna duesseldorf":   "fortuna dusseldorf",
    "dusseldorf":            "fortuna dusseldorf",
    "nuernberg":             "nurnberg",
    "leipzig":               "rasenballsport leipzig",
    "hannover 96":           "hannover 96",
    # Italy
    "as roma":               "roma",
    # France
    "gfc ajaccio":           "ajaccio gfco",
    "ac ajaccio":            "ajaccio",
    "sc bastia":             "bastia",
    # Netherlands
    "psv":                   "psv eindhoven",
    "ga eagles":             "go ahead eagles",
    "breda":                 "nac breda",
    "az alkmaar":            "az alkmaar",
    # Portugal
    "fc porto":              "porto",
    "braga":                 "sp braga",
    "sporting":              "sp lisbon",
    "sporting cp":           "sp lisbon",
    "sporting lisbon":       "sp lisbon",
    "ferreira":              "pacos ferreira",
    "pacos de ferreira":     "pacos ferreira",
    "u madeira":             "uniao madeira",
    "vitoria guimaraes":     "guimaraes",
    # Belgium
    "club brugge kv":        "club brugge",
    "cercle brugge ksv":     "cercle brugge",
    "kv mechelen":           "mechelen",
    "st liege":              "standard",
    "standard liege":        "standard",
    "zulte waregem":         "waregem",
    # Scotland
    "inverness":             "inverness c",
    "dundee utd":            "dundee united",
    "dundee fc":             "dundee",
    # ── scrape_fixtures.py _COUNTRY_ALIASES (cross-source fixture dedup) ──
    "czech republic":        "czechia",
    "türkiye":               "turkey",
    "turkiye":               "turkey",
    "côte d'ivoire":         "ivory coast",
    "cote divoire":          "ivory coast",
    "ivory coast":           "ivory coast",
    "bosnia and herzegovina": "bosnia herzegovina",
    "bosnia & herzegovina":  "bosnia herzegovina",
    "republic of ireland":   "ireland",
    "northern mariana islands": "nmi",
    "democratic republic of congo": "dr congo",
    "cape verde":            "cabo verde",
    "south korea":           "korea",
    "korea republic":        "korea",
    "football union of russia": "russia",
    "chinese taipei":        "taiwan",
}


def _build_aliases(raw: dict[str, str]) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for k, v in raw.items():
        nv = _norm_raw(v)
        for key in {k.strip().lower(), _norm_raw(k)}:
            if key:
                aliases[key] = nv
    # Resolve alias chains so every value is a fixed point (idempotence).
    for key in list(aliases):
        seen = {key}
        val = aliases[key]
        while val in aliases and aliases[val] != val and val not in seen:
            seen.add(val)
            val = aliases[val]
        aliases[key] = val
    return aliases


TEAM_ALIASES: dict[str, str] = _build_aliases(_RAW_ALIASES)


def normalise_team(name: str) -> str:
    """
    Canonicalise a team (or national-side) name for cross-source joins.

    Lowercase, strip punctuation, collapse whitespace, then alias lookup.
    Idempotent: normalise_team(normalise_team(x)) == normalise_team(x).
    """
    s = _norm_raw(str(name))
    return TEAM_ALIASES.get(s, s)
