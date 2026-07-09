"""Tests for fetch_referee_assignments.py — EPL referee-assignment scraper
(PR-25 item 2).

All parsing fixtures below are REAL text captured live on 2026-07-09 against
https://www.premierleague.com/en/news/4658324/match-officials-for-matchweek-38
— the referee-paragraph text is what Playwright's `.innerText` returns for
the article's `<p>` tags (verified against the raw fetched HTML), and the
match-card text is what Playwright's `.innerText` returns for the rendered
`.embeddable-match-card` widgets after client-side JS resolves them (verified
by actually launching a headless browser against the live page — see the
module docstring for why a plain HTTP fetch can't get this). Not invented
shapes.
"""

from __future__ import annotations

import fetch_referee_assignments as fra

# ── Real referee-paragraph innerText, Matchweek 38, in document order ───────
REAL_REFEREE_TEXTS = [
    "Referee: Sam Barrott. Assistants: Simon Bennett, Blake Antrobus. "
    "Fourth official: Ruebyn Ricardo. VAR: Stuart Attwell. Assistant VAR: Steve Meredith.",
    "Referee: Andrew Kitchen. Assistants: Wade Smith, Andrew Dallison. "
    "Fourth official: Adam Herczeg. VAR: Constantine Hatzidakis. Assistant VAR: Neil Davies.",
    "Referee: Farai Hallam. Assistants: Marc Perry, Mat Wilkes. "
    "Fourth official: Tom Nield. VAR: Nick Hopton. Assistant VAR: Craig Taylor.",
    "Referee: Rob Jones. Assistants: Nick Greenhalgh, Sian Massey-Ellis. "
    "Fourth official: Sam Allison. VAR: James Bell. Assistant VAR: Peter Wright.",
    "Referee: Darren England. Assistants: Scott Ledger, Akil Howson. "
    "Fourth official: Tom Kirk. VAR: Tony Harrington. Assistant VAR: Adrian Holmes.",
    "Referee: Andy Madley. Assistants: Richard West, Simon Long. "
    "Fourth official: David Webb. VAR: Tim Wood. Assistant VAR: Jarred Gillett.",
    "Referee: Craig Pawson. Assistants: Lee Betts, Alistair Nelson. "
    "Fourth official: Gavin Ward. VAR: Paul Howard. Assistant VAR: Natalie Aspinall.",
    "Referee: Chis Kavanagh. Assistants: Dan Cook, Ian Hussin. "
    "Fourth official: Lewis Smith. VAR: Matthew Donohue. Assistant VAR: Eddie Smart.",
    "Referee: Michael Oliver (pictured). Assistants: Stuart Burt, James Mainwaring. "
    "Fourth official: Bobby Madley. VAR: Paul Tierney. Assistant VAR: Mark Scholes.",
    "Referee: Anthony Taylor. Assistants: Gary Beswick, Adam Nunn. "
    "Fourth official: Steve Martin. VAR: John Brooks. Assistant VAR: Dan Robathan.",
]

# ── Real .embeddable-match-card innerText, same page, same document order ──
REAL_CARD_TEXTS = [
    "See all\nBrighton\n0 - 3\nMan Utd\nFT\nPremier League•Sun 24 May",
    "See all\nBurnley\n1 - 1\nWolves\nFT\nPremier League•Sun 24 May",
    "See all\nCrystal Palace\n1 - 2\nArsenal\nFT\nPremier League•Sun 24 May",
    "See all\nFulham\n2 - 0\nNewcastle\nFT\nPremier League•Sun 24 May",
    "See all\nLiverpool\n1 - 1\nBrentford\nFT\nPremier League•Sun 24 May",
    "See all\nMan City\n1 - 2\nAston Villa\nFT\nPremier League•Sun 24 May",
    "See all\nNott'm Forest\n1 - 1\nBournemouth\nFT\nPremier League•Sun 24 May",
    "See all\nSunderland\n2 - 1\nChelsea\nFT\nPremier League•Sun 24 May",
    "See all\nSpurs\n1 - 0\nEverton\nFT\nPremier League•Sun 24 May",
    "See all\nWest Ham\n3 - 0\nLeeds\nFT\nPremier League•Sun 24 May",
]


# ── parse_referee_text ───────────────────────────────────────────────────────

def test_parse_referee_text_basic() -> None:
    block = fra.parse_referee_text(REAL_REFEREE_TEXTS[0])
    assert block is not None
    assert block.referee == "Sam Barrott"
    assert block.assistants == ["Simon Bennett", "Blake Antrobus"]
    assert block.fourth_official == "Ruebyn Ricardo"
    assert block.var == "Stuart Attwell"
    assert block.assistant_var == "Steve Meredith"


def test_parse_referee_text_strips_pictured_annotation() -> None:
    block = fra.parse_referee_text(REAL_REFEREE_TEXTS[8])
    assert block is not None
    assert block.referee == "Michael Oliver"


def test_parse_referee_text_all_ten_real_blocks_parse() -> None:
    blocks = [fra.parse_referee_text(t) for t in REAL_REFEREE_TEXTS]
    assert all(b is not None for b in blocks)
    names = [b.referee for b in blocks if b]
    assert names == [
        "Sam Barrott", "Andrew Kitchen", "Farai Hallam", "Rob Jones", "Darren England",
        "Andy Madley", "Craig Pawson", "Chis Kavanagh", "Michael Oliver", "Anthony Taylor",
    ]


def test_parse_referee_text_malformed_returns_none() -> None:
    assert fra.parse_referee_text("Some unrelated paragraph text.") is None
    assert fra.parse_referee_text("") is None


# ── parse_match_card_text ────────────────────────────────────────────────────

def test_parse_match_card_text_basic() -> None:
    card = fra.parse_match_card_text(REAL_CARD_TEXTS[0])
    assert card is not None
    assert card.home == "Brighton"
    assert card.away == "Man Utd"
    assert card.status_raw == "FT"
    assert card.date_raw == "Sun 24 May"


def test_parse_match_card_text_all_ten_real_cards_parse() -> None:
    cards = [fra.parse_match_card_text(t) for t in REAL_CARD_TEXTS]
    assert all(c is not None for c in cards)
    homes = [c.home for c in cards if c]
    assert homes == [
        "Brighton", "Burnley", "Crystal Palace", "Fulham", "Liverpool",
        "Man City", "Nott'm Forest", "Sunderland", "Spurs", "West Ham",
    ]


def test_parse_match_card_text_malformed_returns_none() -> None:
    assert fra.parse_match_card_text("See all\nOnly one line") is None
    assert fra.parse_match_card_text("") is None


def test_parse_match_card_text_without_see_all_prefix() -> None:
    # Defensive: some cards may not carry the "See all" button label at all
    # (e.g. a different widget variant) — the 5-line body should still parse.
    card = fra.parse_match_card_text("Brighton\n0 - 3\nMan Utd\nFT\nPremier League•Sun 24 May")
    assert card is not None
    assert card.home == "Brighton" and card.away == "Man Utd"


# ── pair_assignments ─────────────────────────────────────────────────────────

def test_pair_assignments_full_real_matchweek() -> None:
    referee_blocks = [fra.parse_referee_text(t) for t in REAL_REFEREE_TEXTS]
    cards = [fra.parse_match_card_text(t) for t in REAL_CARD_TEXTS]
    assignments = fra.pair_assignments(
        [b for b in referee_blocks if b], [c for c in cards if c]
    )
    assert len(assignments) == 10
    assert assignments[0].home == "Brighton"
    assert assignments[0].away == "Man Utd"
    assert assignments[0].referee == "Sam Barrott"
    assert assignments[-1].home == "West Ham"
    assert assignments[-1].referee == "Anthony Taylor"


def test_pair_assignments_length_mismatch_pairs_prefix_only(capsys) -> None:
    referee_blocks = [fra.parse_referee_text(t) for t in REAL_REFEREE_TEXTS[:3]]
    cards = [fra.parse_match_card_text(t) for t in REAL_CARD_TEXTS[:2]]
    assignments = fra.pair_assignments(
        [b for b in referee_blocks if b], [c for c in cards if c]
    )
    assert len(assignments) == 2
    captured = capsys.readouterr()
    assert "mismatch" in captured.err.lower()


def test_pair_assignments_empty_inputs_returns_empty() -> None:
    assert fra.pair_assignments([], []) == []


# ── fetch_referee_assignments (async orchestrator) — mocked I/O ────────────

def test_fetch_referee_assignments_end_to_end(monkeypatch) -> None:
    import asyncio

    async def _fake_fetch_rendered(url: str):
        return REAL_REFEREE_TEXTS, REAL_CARD_TEXTS

    monkeypatch.setattr(fra, "_fetch_rendered", _fake_fetch_rendered)
    assignments = asyncio.run(fra.fetch_referee_assignments("https://example.com/fake"))
    assert len(assignments) == 10
    assert assignments[3].home == "Fulham" and assignments[3].referee == "Rob Jones"


def test_fetch_referee_assignments_fails_open_on_empty_render(monkeypatch) -> None:
    import asyncio

    async def _fake_fetch_rendered(url: str):
        return [], []

    monkeypatch.setattr(fra, "_fetch_rendered", _fake_fetch_rendered)
    assignments = asyncio.run(fra.fetch_referee_assignments("https://example.com/fake"))
    assert assignments == []


# ── main() CLI — mocked network, real JSON-writing path ────────────────────

def test_main_no_url_writes_empty_assignments(tmp_path, monkeypatch, capsys) -> None:
    out_path = tmp_path / "referee_assignments.json"
    monkeypatch.setattr(fra, "OUT_PATH", out_path)
    monkeypatch.setattr("sys.argv", ["fetch_referee_assignments.py"])
    fra.main()
    captured = capsys.readouterr()
    assert "no --url" in captured.err.lower() or "no --url" in captured.out.lower()
    import json

    payload = json.loads(out_path.read_text(encoding="utf-8"))
    assert payload["assignments"] == []
    assert payload["league"] == "Premier League"


def test_main_dry_run_does_not_write(tmp_path, monkeypatch) -> None:
    out_path = tmp_path / "referee_assignments.json"
    monkeypatch.setattr(fra, "OUT_PATH", out_path)
    monkeypatch.setattr("sys.argv", ["fetch_referee_assignments.py", "--dry-run"])
    fra.main()
    assert not out_path.exists()


def test_main_with_mocked_url_writes_full_assignments(tmp_path, monkeypatch) -> None:
    import asyncio
    import json

    out_path = tmp_path / "referee_assignments.json"
    monkeypatch.setattr(fra, "OUT_PATH", out_path)
    monkeypatch.setattr(
        "sys.argv", ["fetch_referee_assignments.py", "--url", "https://example.com/fake"]
    )

    async def _fake_fetch_rendered(url: str):
        return REAL_REFEREE_TEXTS, REAL_CARD_TEXTS

    monkeypatch.setattr(fra, "_fetch_rendered", _fake_fetch_rendered)
    fra.main()
    payload = json.loads(out_path.read_text(encoding="utf-8"))
    assert len(payload["assignments"]) == 10
    assert payload["source"] == "https://example.com/fake"
    assert payload["assignments"][0]["home"] == "Brighton"
    assert payload["assignments"][0]["referee"] == "Sam Barrott"
