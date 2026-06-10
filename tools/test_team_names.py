"""Tests for tools/lib/team_names.py — shared team-name normalisation (audit M2-3)."""
import pytest

try:
    from lib.team_names import TEAM_ALIASES, normalise_team
except ImportError:  # repo root on sys.path instead of tools/
    from tools.lib.team_names import TEAM_ALIASES, normalise_team


# Real cross-source pairs: (football-data.co.uk / odds-portal form, full name).
# Both members of each pair MUST collapse to the same canonical key —
# this is the exact class of mismatch that zeroed the OTS/AH join.
ABBREV_FULL_PAIRS = [
    # EPL — the four named in the OTS gap report
    ("Man United", "Manchester United"),
    ("Nott'm Forest", "Nottingham Forest"),
    ("Sheffield Utd", "Sheffield United"),
    ("Wolves", "Wolverhampton Wanderers"),
    # EPL / Championship
    ("Man City", "Manchester City"),
    ("Spurs", "Tottenham Hotspur"),
    ("Newcastle", "Newcastle United"),
    ("Newcastle Utd", "Newcastle United"),
    ("West Brom", "West Bromwich Albion"),
    ("Brighton", "Brighton and Hove Albion"),
    ("Leicester", "Leicester City"),
    ("QPR", "Queens Park Rangers"),
    ("Sheff Wed", "Sheffield Wednesday"),
    ("Sheffield Weds", "Sheffield Wednesday"),
    ("Cardiff", "Cardiff City"),
    ("Hull", "Hull City"),
    ("Stoke", "Stoke City"),
    # La Liga
    ("Ath Madrid", "Atletico Madrid"),
    ("Ath Bilbao", "Athletic Club"),
    ("Sociedad", "Real Sociedad"),
    ("Betis", "Real Betis"),
    ("Celta", "Celta Vigo"),
    ("Espanol", "Espanyol"),
    ("Sp Gijon", "Sporting Gijon"),
    ("Vallecano", "Rayo Vallecano"),
    # Serie A
    ("AC Milan", "Milan"),
    ("Inter", "Internazionale"),
    ("AS Roma", "Roma"),
    ("Verona", "Hellas Verona"),
    # Bundesliga
    ("Ein Frankfurt", "Eintracht Frankfurt"),
    ("M'gladbach", "Borussia M.Gladbach"),
    ("Leverkusen", "Bayer Leverkusen"),
    ("FC Koln", "FC Cologne"),
    ("RB Leipzig", "RasenBallsport Leipzig"),
    ("Hamburg", "Hamburger SV"),
    ("Stuttgart", "VfB Stuttgart"),
    ("Hertha", "Hertha Berlin"),
    ("Dortmund", "Borussia Dortmund"),
    ("Werder Bremen", "SV Werder Bremen"),
    # Ligue 1
    ("Paris SG", "Paris Saint Germain"),
    ("St Etienne", "Saint-Etienne"),
    ("Lyon", "Olympique Lyonnais"),
    ("Marseille", "Olympique de Marseille"),
]


class TestNormaliseTeam:
    def test_idempotent_on_alias_keys_and_values(self):
        for key, value in TEAM_ALIASES.items():
            once = normalise_team(key)
            assert normalise_team(once) == once, f"not idempotent for key {key!r}"
            v_once = normalise_team(value)
            assert normalise_team(v_once) == v_once, f"not idempotent for value {value!r}"

    @pytest.mark.parametrize("name", [
        "Manchester United", "Nott'm Forest", "PARIS SG", "borussia m.gladbach",
        "  Real   Sociedad  ", "1. FC Koln", "Côte d'Ivoire", "Sheffield Weds",
    ])
    def test_idempotent_on_real_names(self, name):
        once = normalise_team(name)
        assert normalise_team(once) == once

    def test_case_insensitive(self):
        assert normalise_team("MAN UNITED") == normalise_team("man united")
        assert normalise_team("Nott'M FOREST") == normalise_team("nott'm forest")

    def test_punctuation_insensitive(self):
        assert normalise_team("Nott'm Forest") == normalise_team("Nottm Forest")
        assert normalise_team("Borussia M.Gladbach") == normalise_team("Borussia MGladbach")
        assert normalise_team("Saint-Etienne") == normalise_team("Saint Etienne")

    def test_whitespace_collapsed(self):
        assert normalise_team("  Man   United ") == normalise_team("Man United")

    def test_unknown_name_passthrough_normalised(self):
        assert normalise_team("Some Unknown FC!") == "some unknown fc"

    @pytest.mark.parametrize("abbrev,full", ABBREV_FULL_PAIRS,
                             ids=[a for a, _ in ABBREV_FULL_PAIRS])
    def test_abbreviation_and_full_name_share_key(self, abbrev, full):
        assert normalise_team(abbrev) == normalise_team(full), (
            f"{abbrev!r} -> {normalise_team(abbrev)!r} but "
            f"{full!r} -> {normalise_team(full)!r}"
        )


class TestAliasMapConsistency:
    def test_values_are_fixed_points(self):
        """No alias value may itself normalise to a different key (no chains)."""
        for key, value in TEAM_ALIASES.items():
            assert normalise_team(value) == value, (
                f"alias value {value!r} (from key {key!r}) normalises to "
                f"{normalise_team(value)!r}"
            )

    def test_keys_normalise_to_their_own_value(self):
        """No key may normalise to a DIFFERENT existing canonical key."""
        for key, value in TEAM_ALIASES.items():
            assert normalise_team(key) == value, (
                f"key {key!r} normalises to {normalise_team(key)!r}, "
                f"expected its mapped value {value!r}"
            )

    def test_country_aliases_preserved(self):
        """scrape_fixtures country dedup entries survive the merge (raw keys)."""
        assert TEAM_ALIASES.get("korea republic") == "korea"
        assert TEAM_ALIASES.get("côte d'ivoire") == "ivory coast"
        assert TEAM_ALIASES.get("türkiye") == "turkey"
        assert TEAM_ALIASES.get("republic of ireland") == "ireland"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
