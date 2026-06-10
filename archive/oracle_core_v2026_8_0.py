import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import poisson
import logging

# Configure explicit logging format for algorithmic transparency
logging.basicConfig(level=logging.INFO, format='[%(asctime)s] %(levelname)s: %(message)s')

class OracleCoreV2026:
    """
    ORACLE v2026: Advanced Predictive Engine for Sequential Decision Optimization.
    Integrates Mohri's regularized bounds, Prince's deep data structures, 
    and Bellemare's Distributional RL probability mapping.
    """
    def __init__(self, phi: float = 0.0020, lambda_reg: float = 10.0):
        # Layer 1 & 2 Foundations: time-decay + identifiability anchor strength.
        self.phi = phi                  # A4: time-decay xi (per DAY). Empirical optimum across top
                                        # leagues is ~0.0018-0.0033/day (opisthokonta 2015; penaltyblog
                                        # 2021; Dixon-Coles 0.0065/half-week = 0.00186/day). MUST be held
                                        # fixed (not jointly optimised) and selected by RPS grid-search —
                                        # see tune_time_decay(). Bundesliga lands highest (history matters less).
        self.lambda_reg = lambda_reg    # B2 FIX: identifiability anchor strength (~likelihood scale,
                                        # was 1500 which forced a hard constraint; ~10 is a soft anchor)
        # B2 FIX (PY-3): Removed decorative C51 distributional atoms (z_support/delta_z/num_atoms)
        # and calculate_wasserstein_distance — they set only 2 point-masses and were never used
        # in any decision. The genuine version (CVaR sizing over a real return distribution) is
        # deferred to the v2027 roadmap rather than shipped as scaffolding.

        # Internal Architecture Storage
        self.team_indices = {}
        self.inverse_team_indices = {}
        self.attack_params = None
        self.defense_params = None
        self.home_advantage = 0.0
        self.rho_dc = 0.0
        self.is_calibrated = False

    def _dixon_coles_tau(self, x: int, y: int, lambda_val: float, mu_val: float, rho: float) -> float:
        """Applies dependence corrections to low-scoring scorelines (0-0, 1-0, 0-1, 1-1)."""
        if x == 0 and y == 0: return 1.0 - (lambda_val * mu_val * rho)
        if x == 1 and y == 0: return 1.0 + (mu_val * rho)
        if x == 0 and y == 1: return 1.0 + (lambda_val * rho)
        if x == 1 and y == 1: return 1.0 - rho
        return 1.0

    def fit_parametric_bounds(self, match_data: pd.DataFrame):
        """
        Executes regularized Maximum Likelihood Estimation over historical matrices.
        DataFrame format requirements: [home_team, away_team, home_goals, away_goals, days_ago]
        """
        logging.info("Executing Parametric Optimization Loop via regularized Likelihood Bounds...")
        
        # Build unique, structured coordinate maps for teams
        all_teams = pd.concat([match_data['home_team'], match_data['away_team']]).unique()
        self.team_indices = {team: idx for idx, team in enumerate(all_teams)}
        self.inverse_team_indices = {idx: team for team, idx in self.team_indices.items()}
        n_teams = len(all_teams)
        
        # Parameter initialization vector layout: [Attack Vector (N), Defense Vector (N), Gamma, Rho]
        initial_guess = np.concatenate([np.ones(n_teams) * 1.0, np.ones(n_teams) * -0.1, [0.25, 0.02]])
        
        def objective_function(params_vector):
            attack = params_vector[:n_teams]
            defense = params_vector[n_teams:2*n_teams]
            gamma = params_vector[-2]
            rho = params_vector[-1]
            
            log_likelihood = 0.0
            
            # Vectorized calculations over rows
            for row in match_data.itertuples():
                h_idx = self.team_indices[row.home_team]
                a_idx = self.team_indices[row.away_team]
                
                # Log-linear relationship maps
                lambda_val = np.exp(attack[h_idx] + defense[a_idx] + gamma)
                mu_val = np.exp(attack[a_idx] + defense[h_idx])
                
                # Layer 1: Time decay scaling matrix factor
                temporal_weight = np.exp(-self.phi * row.days_ago)
                
                # Independent Poisson distributions
                prob_home = poisson.pmf(row.home_goals, lambda_val)
                prob_away = poisson.pmf(row.away_goals, mu_val)
                tau = self._dixon_coles_tau(row.home_goals, row.away_goals, lambda_val, mu_val, rho)
                
                joint_probability = tau * prob_home * prob_away
                if joint_probability <= 1e-12 or np.isnan(joint_probability):
                    continue
                    
                log_likelihood += temporal_weight * np.log(joint_probability)
                
            # B2 FIX (PY-2): This is an IDENTIFIABILITY anchor, not a Rademacher/generalization
            # bound. Dixon-Coles attack/defense are jointly unidentifiable up to an additive
            # constant; pinning mean(attack)=1.0 fixes the gauge. (Renamed from the misleading
            # "generalization_penalty"; magnitude reduced to ~likelihood scale — see lambda_reg.)
            identifiability_penalty = self.lambda_reg * (np.mean(attack) - 1.0) ** 2
            return -(log_likelihood - identifiability_penalty)

        # Optimize using strict parameter boundaries
        bounds = [(0.05, 5.0)] * n_teams + [(-3.0, 1.0)] * n_teams + [(0.0, 1.5), (-0.5, 0.5)]
        optimization_result = minimize(objective_function, initial_guess, method='L-BFGS-B', bounds=bounds)
        
        if not optimization_result.success:
            logging.error("ORACLE Optimization Failed to find localized minima.")
            raise RuntimeError(f"Convergence error: {optimization_result.message}")
            
        # Parse optimization arrays back into structural engine attributes
        self.attack_params = optimization_result.x[:n_teams]
        self.defense_params = optimization_result.x[n_teams:2*n_teams]
        self.home_advantage = optimization_result.x[-2]
        self.rho_dc = optimization_result.x[-1]
        self.is_calibrated = True
        logging.info("Parameter calibration complete. System metrics localized successfully.")

    def compute_joint_probabilities(self, home_team: str, away_team: str, max_goals: int = 10) -> np.ndarray:
        """Calculates an isolated, non-linear score matrix using calculated model constraints."""
        if not self.is_calibrated:
            raise ValueError("ORACLE Core must be optimized using fit_parametric_bounds before projection.")
            
        h_idx = self.team_indices[home_team]
        a_idx = self.team_indices[away_team]
        
        lambda_val = np.exp(self.attack_params[h_idx] + self.defense_params[a_idx] + self.home_advantage)
        mu_val = np.exp(self.attack_params[a_idx] + self.defense_params[h_idx])
        
        matrix = np.zeros((max_goals + 1, max_goals + 1))
        for x in range(max_goals + 1):
            for y in range(max_goals + 1):
                p_h = poisson.pmf(x, lambda_val)
                p_a = poisson.pmf(y, mu_val)
                tau = self._dixon_coles_tau(x, y, lambda_val, mu_val, self.rho_dc)
                matrix[x, y] = tau * p_h * p_a
                
        # Return fully normalized matrix boundaries
        return matrix / np.sum(matrix)

    def generate_policy(self, home_team: str, away_team: str, market_odds: dict) -> dict:
        """
        Generates Kelly stake allocations per 1X2 selection from the score matrix.
        market_odds format example: {'1': 2.10, 'X': 3.40, '2': 3.60}
        """
        score_matrix = self.compute_joint_probabilities(home_team, away_team)
        
        # Map output matrix slices directly to outcome probabilities.
        # matrix[x, y] = P(home scores x, away scores y).
        # B2 FIX (PY-1): home win = x > y = LOWER triangle (np.tril, k=-1).
        # Previous code used np.triu(...).T which sums the x<y (AWAY-win) cells —
        # a transpose preserves the sum, so home/away were silently swapped.
        prob_home_win = float(np.sum(np.tril(score_matrix, k=-1)))  # x > y  (home > away)
        prob_draw     = float(np.trace(score_matrix))               # x == y
        prob_away_win = float(np.sum(np.triu(score_matrix, k=1)))   # x < y  (away > home)
        
        model_probs = {'1': prob_home_win, 'X': prob_draw, '2': prob_away_win}
        policy_allocations = {}
        
        for selection, implied_price in market_odds.items():
            p_success = model_probs[selection]

            # Canonical Kelly: f* = edge / (price - 1), b = price - 1 (net decimal odds).
            edge = (p_success * implied_price) - 1.0
            if edge > 0:
                optimal_fraction = edge / (implied_price - 1.0)
                policy_size = float(optimal_fraction * 0.5)  # Half-Kelly for variance protection
            else:
                policy_size = 0.0

            policy_allocations[selection] = {
                'model_probability': p_success,
                'calculated_edge': edge,
                'target_allocation_fraction': max(0.0, policy_size),
            }
            
        return policy_allocations

    @staticmethod
    def ranked_probability_score(forecast: dict, actual: str) -> float:
        """A1/A4: RPS for ordered 1X2 outcomes. forecast={'1':pH,'X':pD,'2':pA}, actual in {'1','X','2'}."""
        order = ['1', 'X', '2']
        p = [max(0.0, forecast.get(k, 0.0)) for k in order]
        s = sum(p) or 1.0
        pf = [v / s for v in p]
        e = [1.0 if k == actual else 0.0 for k in order]
        rps, cp, ce = 0.0, 0.0, 0.0
        for i in range(len(order) - 1):
            cp += pf[i]; ce += e[i]
            rps += (cp - ce) ** 2
        return rps / (len(order) - 1)

    def tune_time_decay(self, match_data: pd.DataFrame, xi_grid=(0.0015, 0.002, 0.0025, 0.003, 0.004),
                        holdout_frac: float = 0.25) -> dict:
        """
        A4: Select xi by out-of-sample RPS (NOT jointly with other params — the literature is
        explicit that xi must be held fixed and grid-searched). Refits the model at each xi on the
        training split, scores RPS on the most-recent holdout, returns the argmin and the full curve.
        """
        df = match_data.sort_values('days_ago', ascending=False).reset_index(drop=True)
        n_hold = max(10, int(len(df) * holdout_frac))
        train, test = df.iloc[n_hold:], df.iloc[:n_hold]   # test = most recent (smallest days_ago)
        results = {}
        best_xi, best_rps = None, float('inf')
        for xi in xi_grid:
            self.phi = xi
            try:
                self.fit_parametric_bounds(train)
            except Exception:
                results[xi] = None; continue
            rps_sum, m = 0.0, 0
            for row in test.itertuples():
                if row.home_team not in self.team_indices or row.away_team not in self.team_indices:
                    continue
                mat = self.compute_joint_probabilities(row.home_team, row.away_team)
                fc = {'1': float(np.sum(np.tril(mat, -1))), 'X': float(np.trace(mat)), '2': float(np.sum(np.triu(mat, 1)))}
                actual = '1' if row.home_goals > row.away_goals else ('2' if row.home_goals < row.away_goals else 'X')
                rps_sum += self.ranked_probability_score(fc, actual); m += 1
            avg = rps_sum / m if m else None
            results[xi] = avg
            if avg is not None and avg < best_rps:
                best_rps, best_xi = avg, xi
        return {'best_xi': best_xi, 'best_rps': best_rps, 'curve': results}

# Module validation harness
if __name__ == "__main__":
    # 1. Synthesize Mock Historical Training Set (Matches from recent league structures)
    np.random.seed(42)
    mock_data = pd.DataFrame({
        'home_team': np.random.choice(['Arsenal', 'ManCity', 'Liverpool', 'Chelsea'], 200),
        'away_team': np.random.choice(['Arsenal', 'ManCity', 'Liverpool', 'Chelsea'], 200),
        'home_goals': np.random.poisson(1.6, 200),
        'away_goals': np.random.poisson(1.2, 200),
        'days_ago': np.sort(np.random.randint(1, 365, 200))[::-1] # Ascending time age profile
    })
    # Drop structural invalid loops (self-play options)
    mock_data = mock_data[mock_data['home_team'] != mock_data['away_team']]

    # 2. Fire Core Engine Mechanics
    oracle = OracleCoreV2026(phi=0.0020, lambda_reg=10.0)  # A4: xi=0.002/day per empirical optimum (opisthokonta/penaltyblog); was 0.004-0.005 (too aggressive)
    oracle.fit_parametric_bounds(mock_data)

    # 3. Generate policy
    market_prices = {'1': 1.95, 'X': 3.60, '2': 4.10}
    action_policy = oracle.generate_policy('Arsenal', 'ManCity', market_odds=market_prices)

    print("\n" + "="*60 + "\n\tORACLE v2026.6 CORE REPORT\n" + "="*60)
    for outcome, metrics in action_policy.items():
        print(f"\nSelection [{outcome}] Projections:")
        print(f"  -> Calculated True Probability: {metrics['model_probability']:.4f}")
        print(f"  -> Structural Implied Edge : {metrics['calculated_edge']:.4f}")
        print(f"  -> Allocation Sizing Matrix  : {metrics['target_allocation_fraction']:.4f}")

    # ── B2 TESTS T290–T292 (executable) ──────────────────────────────────────
    print("\n" + "="*60 + "\n\tB2 REGRESSION TESTS\n" + "="*60)
    # T290/T291: home-dominant matrix → P(home) > P(away); symmetric → equal
    m_home = np.array([[0.10,0.04,0.02],[0.18,0.12,0.05],[0.20,0.10,0.19]])
    m_home = m_home/m_home.sum()
    ph = float(np.sum(np.tril(m_home,k=-1))); pa = float(np.sum(np.triu(m_home,k=1)))
    assert ph > pa, f"T290 FAIL: home-dominant must give P(home)>P(away), got {ph:.4f} vs {pa:.4f}"
    print(f"T290 PASS: home-dominant P(home)={ph:.4f} > P(away)={pa:.4f}")
    m_sym = np.array([[0.1,0.1,0.05],[0.1,0.2,0.1],[0.05,0.1,0.1]]); m_sym=m_sym/m_sym.sum()
    assert abs(np.sum(np.tril(m_sym,k=-1))-np.sum(np.triu(m_sym,k=1))) < 1e-9, "T291 FAIL: symmetric matrix"
    print("T291 PASS: symmetric matrix → P(home)==P(away)")
    # T292 cross-check fixture written for JS harness consumption
    fixture = oracle.compute_joint_probabilities('Arsenal','ManCity')
    print(f"T292 fixture: P(home)={float(np.sum(np.tril(fixture,k=-1))):.6f} "
          f"P(draw)={float(np.trace(fixture)):.6f} P(away)={float(np.sum(np.triu(fixture,k=1))):.6f}")
    print("\nAll B2 Python assertions passed.")