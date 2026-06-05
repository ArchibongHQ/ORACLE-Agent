"""Test suite for scrape_live_odds.py — consensus odds scraping and validation."""
import pytest
import json
from pathlib import Path
from scrape_live_odds import (
    OddsOutcome, ScrapeResult, ConsensusOdds,
    compute_consensus, scrape_consensus_odds
)


class TestOddsOutcome:
    def test_odds_outcome_creation(self):
        odds = OddsOutcome(home=2.1, draw=3.5, away=3.2)
        assert odds.home == 2.1
        assert odds.draw == 3.5
        assert odds.away == 3.2


class TestScrapeResult:
    def test_successful_scrape(self):
        result = ScrapeResult(
            source="flashscore",
            status="success",
            h2h=OddsOutcome(home=2.1, draw=3.5, away=3.2)
        )
        assert result.source == "flashscore"
        assert result.status == "success"
        assert result.h2h.home == 2.1

    def test_failed_scrape(self):
        result = ScrapeResult(
            source="betexplorer",
            status="network_error"
        )
        assert result.status == "network_error"
        assert result.h2h is None


class TestConsensusComputation:
    def test_consensus_success_three_sources(self):
        """Test consensus with 3 matching sources."""
        results = [
            ScrapeResult(
                source="flashscore",
                status="success",
                h2h=OddsOutcome(home=2.10, draw=3.50, away=3.20)
            ),
            ScrapeResult(
                source="betexplorer",
                status="success",
                h2h=OddsOutcome(home=2.09, draw=3.49, away=3.21)
            ),
            ScrapeResult(
                source="sofascore",
                status="success",
                h2h=OddsOutcome(home=2.11, draw=3.51, away=3.19)
            ),
        ]

        consensus = compute_consensus(
            results,
            min_consensus=3,
            variance_threshold=0.025
        )

        assert consensus is not None
        assert consensus.confidence == 1.0  # 3/3 sources
        assert consensus.consensus_odds["h2h"]["home"] == 2.10
        assert consensus.validation["passed"] is True
        assert consensus.validation["consensus_sources"] == 3

    def test_consensus_fails_insufficient_sources(self):
        """Test consensus rejects when fewer than min_consensus sources."""
        results = [
            ScrapeResult(
                source="flashscore",
                status="success",
                h2h=OddsOutcome(home=2.1, draw=3.5, away=3.2)
            ),
            ScrapeResult(
                source="betexplorer",
                status="network_error"
            ),
        ]

        consensus = compute_consensus(results, min_consensus=3)
        assert consensus is None

    def test_consensus_fails_high_variance(self):
        """Test consensus rejects when variance exceeds threshold."""
        results = [
            ScrapeResult(
                source="flashscore",
                status="success",
                h2h=OddsOutcome(home=2.0, draw=3.5, away=3.2)
            ),
            ScrapeResult(
                source="betexplorer",
                status="success",
                h2h=OddsOutcome(home=2.3, draw=3.5, away=3.2)  # 15% variance
            ),
            ScrapeResult(
                source="sofascore",
                status="success",
                h2h=OddsOutcome(home=2.1, draw=3.5, away=3.2)
            ),
        ]

        consensus = compute_consensus(
            results,
            min_consensus=3,
            variance_threshold=0.025  # ±2.5%
        )
        # Should fail due to high variance in home odds
        assert consensus is None

    def test_consensus_confidence_partial_sources(self):
        """Test confidence score when fewer than min but threshold met."""
        results = [
            ScrapeResult(
                source="flashscore",
                status="success",
                h2h=OddsOutcome(home=2.1, draw=3.5, away=3.2)
            ),
            ScrapeResult(
                source="betexplorer",
                status="success",
                h2h=OddsOutcome(home=2.09, draw=3.49, away=3.21)
            ),
        ]

        consensus = compute_consensus(
            results,
            min_consensus=3,  # require 3, but only have 2
            variance_threshold=0.025
        )
        # Should fail: 2 < 3 required sources
        assert consensus is None

    def test_consensus_with_failed_sources(self):
        """Test consensus ignores failed scrapes."""
        results = [
            ScrapeResult(
                source="flashscore",
                status="success",
                h2h=OddsOutcome(home=2.1, draw=3.5, away=3.2)
            ),
            ScrapeResult(
                source="betexplorer",
                status="timeout"
            ),
            ScrapeResult(
                source="sofascore",
                status="success",
                h2h=OddsOutcome(home=2.09, draw=3.49, away=3.21)
            ),
            ScrapeResult(
                source="betfair_api",
                status="success",
                h2h=OddsOutcome(home=2.11, draw=3.51, away=3.19)
            ),
        ]

        consensus = compute_consensus(
            results,
            min_consensus=3,
            variance_threshold=0.025
        )

        assert consensus is not None
        assert consensus.validation["consensus_sources"] == 3


class TestConsensusOdds:
    def test_consensus_odds_serialization(self):
        """Test ConsensusOdds can be serialized to JSON."""
        consensus = ConsensusOdds(
            match_id="arsenal_vs_chelsea_202606051500",
            confidence=0.85,
            consensus_odds={
                "h2h": {"home": 2.10, "draw": 3.50, "away": 3.20}
            },
            validation={
                "consensus_sources": 3,
                "passed": True
            }
        )

        data = consensus.to_dict()
        json_str = json.dumps(data)
        reloaded = json.loads(json_str)

        assert reloaded["match_id"] == "arsenal_vs_chelsea_202606051500"
        assert reloaded["confidence"] == 0.85
        assert reloaded["consensus_odds"]["h2h"]["home"] == 2.10

    def test_consensus_odds_confidence_bounds(self):
        """Test confidence is clamped to [0, 1]."""
        results = [
            ScrapeResult(
                source=f"source{i}",
                status="success",
                h2h=OddsOutcome(home=2.1, draw=3.5, away=3.2)
            )
            for i in range(5)
        ]

        consensus = compute_consensus(
            results,
            min_consensus=3,
            variance_threshold=0.025
        )

        assert consensus is not None
        assert 0.0 <= consensus.confidence <= 1.0
        assert consensus.confidence == 1.0  # 5 sources / 3 min = 1.66, clamped to 1.0


class TestVarianceComputation:
    def test_variance_exactly_at_threshold(self):
        """Test variance exactly at threshold passes."""
        results = [
            ScrapeResult(
                source="a",
                status="success",
                h2h=OddsOutcome(home=2.0, draw=3.5, away=3.2)
            ),
            ScrapeResult(
                source="b",
                status="success",
                h2h=OddsOutcome(home=2.05, draw=3.5, away=3.2)  # 2.5% variance
            ),
            ScrapeResult(
                source="c",
                status="success",
                h2h=OddsOutcome(home=2.0, draw=3.5, away=3.2)
            ),
        ]

        consensus = compute_consensus(
            results,
            min_consensus=3,
            variance_threshold=0.025
        )
        # Should pass at exactly the threshold
        assert consensus is not None

    def test_variance_just_above_threshold(self):
        """Test variance just above threshold fails."""
        results = [
            ScrapeResult(
                source="a",
                status="success",
                h2h=OddsOutcome(home=2.0, draw=3.5, away=3.2)
            ),
            ScrapeResult(
                source="b",
                status="success",
                h2h=OddsOutcome(home=2.051, draw=3.5, away=3.2)  # 2.55% variance
            ),
            ScrapeResult(
                source="c",
                status="success",
                h2h=OddsOutcome(home=2.0, draw=3.5, away=3.2)
            ),
        ]

        consensus = compute_consensus(
            results,
            min_consensus=3,
            variance_threshold=0.025
        )
        # Should fail just above the threshold
        assert consensus is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
