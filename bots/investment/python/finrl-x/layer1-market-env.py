#!/usr/bin/env python3
"""
FinRL-X Layer 1: Market Environments
마스터 철학: "상승/하락/횡보 모든 시장 대응!"
2026 트렌드: Market Regime Adaptation

환경 유형:
  - BullMarket: 상승장 최적화
  - BearMarket: 하락장 최적화
  - SidewaysMarket: 횡보장 최적화
  - VolatileMarket: 고변동성 최적화
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional
import numpy as np


MarketRegime = Literal["bull", "bear", "sideways", "volatile"]

FEATURE_NAMES = [
    "momentum5", "momentum20", "volatility20", "drawdown20",
    "factor_composite", "stat_arb_confidence",
    "entry_confidence", "regime_confidence",
    "cash_pct", "position_pct", "unrealized_pnl_pct", "risk_budget_pct",
]


@dataclass
class MarketEnvConfig:
    initial_cash: float = 1_000_000.0   # 100만원
    transaction_cost: float = 0.0005    # 0.05%
    max_position_pct: float = 0.25      # 최대 포지션 25%

    # 레짐별 리워드 조정
    bull_momentum_bonus: float = 0.15
    bear_safety_bonus: float = 0.20
    sideways_mean_rev_bonus: float = 0.10
    volatile_risk_penalty: float = 0.30


@dataclass
class MarketStep:
    obs: np.ndarray
    reward: float
    done: bool
    info: dict = field(default_factory=dict)


class BaseMarketEnv:
    """FinRL-X Layer 1 기본 환경 (Gym-compatible)"""

    regime: MarketRegime = "bull"

    def __init__(self, config: MarketEnvConfig | None = None):
        self.config = config or MarketEnvConfig()
        self.cash = self.config.initial_cash
        self.position_value = 0.0
        self.step_count = 0
        self._bars: list[dict] = []
        self._cursor = 0

    def load_bars(self, bars: list[dict]) -> None:
        """OHLCV 데이터 로드"""
        self._bars = bars
        self._cursor = 0
        self.cash = self.config.initial_cash
        self.position_value = 0.0
        self.step_count = 0

    def reset(self) -> np.ndarray:
        self._cursor = 0
        self.cash = self.config.initial_cash
        self.position_value = 0.0
        self.step_count = 0
        return self._get_obs()

    def step(self, action: int) -> MarketStep:
        """action: 0=hold, 1=buy, 2=sell"""
        reward = 0.0
        done = False

        if self._cursor >= len(self._bars) - 1:
            return MarketStep(self._get_obs(), 0.0, True, {"reason": "end_of_data"})

        bar = self._bars[self._cursor]
        next_bar = self._bars[self._cursor + 1]
        price_return = (next_bar["close"] - bar["close"]) / (bar["close"] or 1)

        if action == 1 and self.cash > 0:  # buy
            buy_size = self.cash * self.config.max_position_pct
            cost = buy_size * self.config.transaction_cost
            self.position_value += buy_size - cost
            self.cash -= buy_size
            reward = self._calc_entry_reward(price_return)

        elif action == 2 and self.position_value > 0:  # sell
            sell_value = self.position_value * (1 + price_return)
            cost = sell_value * self.config.transaction_cost
            pnl = sell_value - self.position_value - cost
            self.cash += sell_value - cost
            self.position_value = 0.0
            reward = pnl / self.config.initial_cash

        else:  # hold
            if self.position_value > 0:
                self.position_value *= (1 + price_return)
            reward = self._calc_hold_reward(price_return)

        reward += self._regime_reward_adjustment(action, price_return)
        self._cursor += 1
        self.step_count += 1
        done = self._cursor >= len(self._bars) - 1

        total_value = self.cash + self.position_value
        info = {
            "total_value": total_value,
            "cash": self.cash,
            "position_value": self.position_value,
            "regime": self.regime,
            "step": self.step_count,
        }
        return MarketStep(self._get_obs(), float(reward), done, info)

    def _get_obs(self) -> np.ndarray:
        obs = np.zeros(len(FEATURE_NAMES), dtype=np.float32)
        if not self._bars or self._cursor >= len(self._bars):
            return obs

        bars = self._bars[:self._cursor + 1]
        closes = [b["close"] for b in bars]

        total = self.cash + self.position_value
        obs[8] = self.cash / (total or 1)           # cash_pct
        obs[9] = self.position_value / (total or 1)  # position_pct
        obs[11] = 1.0 - (self.position_value / self.config.initial_cash)  # risk_budget_pct

        if len(closes) >= 5:
            obs[0] = (closes[-1] - closes[-5]) / (closes[-5] or 1)  # momentum5
        if len(closes) >= 20:
            obs[1] = (closes[-1] - closes[-20]) / (closes[-20] or 1)  # momentum20
            vol = np.std(closes[-20:]) / (np.mean(closes[-20:]) or 1)
            obs[2] = float(np.clip(vol, 0, 1))  # volatility20
            dd = (max(closes[-20:]) - closes[-1]) / (max(closes[-20:]) or 1)
            obs[3] = float(np.clip(dd, 0, 1))   # drawdown20

        return obs

    def _calc_entry_reward(self, price_return: float) -> float:
        return 0.0  # 서브클래스에서 오버라이드

    def _calc_hold_reward(self, price_return: float) -> float:
        return 0.0

    def _regime_reward_adjustment(self, action: int, price_return: float) -> float:
        return 0.0


class BullMarketEnv(BaseMarketEnv):
    """상승장 — 모멘텀 추종 보상"""
    regime: MarketRegime = "bull"

    def _calc_entry_reward(self, price_return: float) -> float:
        bonus = self.config.bull_momentum_bonus if price_return > 0 else 0
        return price_return + bonus

    def _calc_hold_reward(self, price_return: float) -> float:
        # 상승장에서 보유 기회비용 약하게 패널티
        return -abs(price_return) * 0.05 if price_return > 0.01 else 0


class BearMarketEnv(BaseMarketEnv):
    """하락장 — 리스크 회피 보상"""
    regime: MarketRegime = "bear"

    def _calc_hold_reward(self, price_return: float) -> float:
        # 하락장에서 현금 유지 보상
        return self.config.bear_safety_bonus * 0.01 if self.position_value == 0 else 0

    def _regime_reward_adjustment(self, action: int, price_return: float) -> float:
        # 하락장에서 매수 시 패널티
        if action == 1 and price_return < -0.01:
            return -self.config.bear_safety_bonus * abs(price_return)
        return 0


class SidewaysMarketEnv(BaseMarketEnv):
    """횡보장 — 평균회귀 보상"""
    regime: MarketRegime = "sideways"

    def _calc_entry_reward(self, price_return: float) -> float:
        # 평균회귀: 하락 후 매수가 좋음
        return self.config.sideways_mean_rev_bonus if price_return > 0 else price_return

    def _calc_hold_reward(self, price_return: float) -> float:
        # 횡보장에서 과도한 보유 불필요
        return -0.001 if self.step_count % 10 == 0 else 0


class VolatileMarketEnv(BaseMarketEnv):
    """고변동성 — 리스크 관리 보상"""
    regime: MarketRegime = "volatile"

    def _regime_reward_adjustment(self, action: int, price_return: float) -> float:
        # 고변동성에서 큰 포지션 패널티
        position_ratio = self.position_value / (self.cash + self.position_value + 1e-9)
        if position_ratio > 0.15:
            return -self.config.volatile_risk_penalty * position_ratio
        return 0


def create_env(regime: MarketRegime, config: MarketEnvConfig | None = None) -> BaseMarketEnv:
    """레짐 기반 환경 생성 팩토리"""
    envs = {
        "bull": BullMarketEnv,
        "bear": BearMarketEnv,
        "sideways": SidewaysMarketEnv,
        "volatile": VolatileMarketEnv,
    }
    cls = envs.get(regime, BaseMarketEnv)
    return cls(config)


if __name__ == "__main__":
    # 연결 테스트
    env = create_env("bull")
    test_bars = [{"close": 100 + i + (i % 3)} for i in range(50)]
    env.load_bars(test_bars)
    obs = env.reset()
    print(f"[Layer1] 환경 생성 OK — obs shape: {obs.shape}, regime: {env.regime}")

    for _ in range(5):
        step = env.step(1)  # buy
        print(f"  reward={step.reward:.4f}, done={step.done}, total={step.info.get('total_value', 0):.0f}")
