#!/usr/bin/env python3
"""Luna Phase 7 RL trading environment scaffold.

This file intentionally keeps Gymnasium optional. The production training path is
not activated by Phase 7 shadow implementation; tests only verify the contract
shape and deterministic reward/action semantics.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple


FEATURE_NAMES = [
    "momentum5",
    "momentum20",
    "volatility20",
    "drawdown20",
    "factorComposite",
    "statArbConfidence",
    "entryConfidence",
    "regimeConfidence",
    "cashPct",
    "positionPct",
    "unrealizedPnlPct",
    "riskBudgetPct",
]


@dataclass
class LunaTradingEnvConfig:
    initial_cash: float = 1000.0
    transaction_cost: float = 0.001
    drawdown_penalty: float = 0.6
    trade_penalty: float = 0.02


class LunaTradingEnv:
    """Minimal Gym-compatible environment contract for FinRL/PPO integration."""

    metadata = {"render_modes": ["human"]}

    def __init__(self, samples: List[Dict[str, Any]] | None = None, config: LunaTradingEnvConfig | None = None):
        self.samples = samples or [fixture_sample()]
        self.config = config or LunaTradingEnvConfig()
        self.index = 0
        self.cash = self.config.initial_cash
        self.position = 0.0
        self.equity_peak = self.config.initial_cash

    def reset(self, *, seed: int | None = None, options: Dict[str, Any] | None = None) -> Tuple[List[float], Dict[str, Any]]:
        del seed, options
        self.index = 0
        self.cash = self.config.initial_cash
        self.position = 0.0
        self.equity_peak = self.config.initial_cash
        return self._observation(), {"shadow_only": True}

    def step(self, action: float) -> Tuple[List[float], float, bool, bool, Dict[str, Any]]:
        action = max(-1.0, min(1.0, float(action or 0.0)))
        sample = self.samples[min(self.index, len(self.samples) - 1)]
        price_return = float(sample.get("next_return", 0.0))
        exposure = action
        trade_cost = abs(action) * self.config.transaction_cost
        pnl = exposure * price_return
        equity = self.cash * (1.0 + pnl - trade_cost)
        self.equity_peak = max(self.equity_peak, equity)
        drawdown = 0.0 if self.equity_peak <= 0 else max(0.0, (self.equity_peak - equity) / self.equity_peak)
        reward = pnl - trade_cost - drawdown * self.config.drawdown_penalty - abs(action) * self.config.trade_penalty
        self.cash = equity
        self.position = exposure
        self.index += 1
        terminated = self.index >= len(self.samples)
        return self._observation(), reward, terminated, False, {
            "shadow_only": True,
            "pnl": pnl,
            "drawdown": drawdown,
            "transaction_cost": trade_cost,
        }

    def _observation(self) -> List[float]:
        sample = self.samples[min(self.index, len(self.samples) - 1)]
        features = sample.get("features", sample)
        return [float(features.get(name, 0.0)) for name in FEATURE_NAMES]


def fixture_sample() -> Dict[str, Any]:
    return {
        "features": {
            "momentum5": 0.62,
            "momentum20": 0.58,
            "volatility20": 0.22,
            "drawdown20": 0.12,
            "factorComposite": 0.72,
            "statArbConfidence": 0.35,
            "entryConfidence": 0.66,
            "regimeConfidence": 0.61,
            "cashPct": 1.0,
            "positionPct": 0.0,
            "unrealizedPnlPct": 0.0,
            "riskBudgetPct": 0.02,
        },
        "next_return": 0.012,
    }


def contract_summary() -> Dict[str, Any]:
    env = LunaTradingEnv([fixture_sample()])
    obs, info = env.reset()
    next_obs, reward, terminated, truncated, step_info = env.step(0.35)
    return {
        "ok": True,
        "feature_names": FEATURE_NAMES,
        "observation_size": len(obs),
        "action_space": "Box(-1.0, 1.0)",
        "reward": round(reward, 6),
        "terminated": terminated,
        "truncated": truncated,
        "shadow_only": info.get("shadow_only") and step_info.get("shadow_only"),
        "next_observation_size": len(next_obs),
    }


__all__ = [
    "FEATURE_NAMES",
    "LunaTradingEnv",
    "LunaTradingEnvConfig",
    "contract_summary",
    "fixture_sample",
]
