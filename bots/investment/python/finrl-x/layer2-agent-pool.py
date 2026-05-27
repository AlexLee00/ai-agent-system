#!/usr/bin/env python3
"""
FinRL-X Layer 2: Agent Pool
15 에이전트 → DRL Agent 역할 매핑

5 Agent System (Moura 2024):
  Analyst Team:     oracle, sentinel
  Data Science:     luna, kairos
  Strategy:         hephaestos, hermes
  Trading Advisor:  chronos, argos
  Risk Manager:     sweeper, scout
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Optional
import numpy as np
import random


AgentRole = Literal["analyst", "data_scientist", "strategist", "advisor", "risk_manager"]

AGENT_REGISTRY: dict[str, AgentRole] = {
    "oracle": "analyst",
    "sentinel": "analyst",
    "luna": "data_scientist",
    "kairos": "data_scientist",
    "hephaestos": "strategist",
    "hermes": "strategist",
    "chronos": "advisor",
    "argos": "advisor",
    "sweeper": "risk_manager",
    "scout": "risk_manager",
    # 보조 에이전트
    "aria": "analyst",
    "sophia": "analyst",
    "nemesis": "risk_manager",
    "reporter": "data_scientist",
}


@dataclass
class AgentAction:
    agent_name: str
    role: AgentRole
    action: int           # 0=hold, 1=buy, 2=sell
    confidence: float     # 0~1
    reasoning: str


@dataclass
class AgentState:
    agent_name: str
    role: AgentRole
    success_rate: float = 0.50
    invocation_count: int = 0
    level: str = "novice"       # novice | intermediate | expert


class DRLAgent:
    """기본 DRL 에이전트 (PPO/SAC 래퍼)"""

    def __init__(self, name: str, role: AgentRole):
        self.name = name
        self.role = role
        self.state = AgentState(name, role)
        self._q_table: dict[str, float] = {}   # 간단한 Q-table (초기 학습용)

    def act(self, obs: np.ndarray, exploration_rate: float = 0.1) -> AgentAction:
        """epsilon-greedy 행동 선택"""
        if random.random() < exploration_rate:
            action = random.randint(0, 2)
            confidence = 0.3
            reasoning = "탐색 (exploration)"
        else:
            action, confidence = self._policy(obs)
            reasoning = f"정책 기반 (level={self.state.level})"

        # 역할별 행동 편향
        action = self._apply_role_bias(action, obs)

        return AgentAction(
            agent_name=self.name,
            role=self.role,
            action=action,
            confidence=confidence,
            reasoning=reasoning,
        )

    def update(self, obs: np.ndarray, action: int, reward: float, next_obs: np.ndarray) -> None:
        """Q-value 업데이트 (간단한 TD 학습)"""
        key = self._obs_key(obs)
        lr = 0.01
        gamma = 0.95
        old_q = self._q_table.get(f"{key}_{action}", 0.0)
        next_q = max(self._q_table.get(f"{self._obs_key(next_obs)}_{a}", 0.0) for a in range(3))
        new_q = old_q + lr * (reward + gamma * next_q - old_q)
        self._q_table[f"{key}_{action}"] = new_q

        self.state.invocation_count += 1
        if reward > 0:
            n = self.state.invocation_count
            prev = self.state.success_rate
            self.state.success_rate = (prev * (n - 1) + 1) / n

        # 레벨 업데이트
        if self.state.success_rate >= 0.65 and self.state.invocation_count >= 20:
            self.state.level = "expert"
        elif self.state.success_rate >= 0.50:
            self.state.level = "intermediate"

    def _policy(self, obs: np.ndarray) -> tuple[int, float]:
        key = self._obs_key(obs)
        qs = [self._q_table.get(f"{key}_{a}", 0.0) for a in range(3)]
        best_action = int(np.argmax(qs))
        best_q = max(qs)
        confidence = min(0.95, max(0.3, 0.5 + best_q))
        return best_action, confidence

    def _apply_role_bias(self, action: int, obs: np.ndarray) -> int:
        """역할에 따른 행동 편향"""
        if self.role == "risk_manager":
            # 리스크 관리자는 공격적 매수 제한
            cash_pct = float(obs[8]) if len(obs) > 8 else 0.5
            if action == 1 and cash_pct < 0.3:
                return 0  # 현금 부족 시 hold로
        elif self.role == "analyst":
            # 분석가는 신호에 더 민감
            momentum = float(obs[0]) if len(obs) > 0 else 0
            if momentum > 0.02 and action == 0:
                return 1  # 강한 모멘텀 시 buy
        return action

    def _obs_key(self, obs: np.ndarray) -> str:
        return str(np.round(obs[:4], 1).tolist())


class MultiAgentPool:
    """15 에이전트 풀 — 앙상블 의사결정"""

    def __init__(self, agent_names: list[str] | None = None):
        names = agent_names or list(AGENT_REGISTRY.keys())
        self.agents: dict[str, DRLAgent] = {
            name: DRLAgent(name, AGENT_REGISTRY.get(name, "data_scientist"))
            for name in names
        }

    def ensemble_action(self, obs: np.ndarray, exploration_rate: float = 0.1) -> tuple[int, float, list[AgentAction]]:
        """앙상블 투표 — 역할 가중치 적용"""
        role_weights: dict[AgentRole, float] = {
            "analyst": 0.25,
            "data_scientist": 0.20,
            "strategist": 0.25,
            "advisor": 0.20,
            "risk_manager": 0.10,
        }

        actions = [agent.act(obs, exploration_rate) for agent in self.agents.values()]

        # 역할 가중치 + 에이전트 레벨 가중치 적용
        level_mult = {"expert": 1.5, "intermediate": 1.0, "novice": 0.7}
        vote_scores = {0: 0.0, 1: 0.0, 2: 0.0}

        for ag_action in actions:
            w = role_weights.get(ag_action.role, 0.2)
            lm = level_mult.get(self.agents[ag_action.agent_name].state.level, 1.0)
            vote_scores[ag_action.action] += w * lm * ag_action.confidence

        best_action = max(vote_scores, key=vote_scores.__getitem__)
        total = sum(vote_scores.values()) or 1
        confidence = vote_scores[best_action] / total

        return best_action, confidence, actions

    def bulk_update(self, obs: np.ndarray, action: int, reward: float, next_obs: np.ndarray) -> None:
        """모든 에이전트 동시 학습"""
        for agent in self.agents.values():
            agent.update(obs, action, reward, next_obs)

    def get_pool_status(self) -> list[dict]:
        return [
            {
                "name": name,
                "role": agent.role,
                "level": agent.state.level,
                "success_rate": round(agent.state.success_rate, 3),
                "invocations": agent.state.invocation_count,
            }
            for name, agent in self.agents.items()
        ]


if __name__ == "__main__":
    pool = MultiAgentPool()
    obs = np.random.randn(12).astype(np.float32)
    action, conf, agent_actions = pool.ensemble_action(obs)
    print(f"[Layer2] 앙상블 결정: action={action}, confidence={conf:.3f}")
    print(f"[Layer2] 에이전트 풀: {len(pool.agents)}개")

    status = pool.get_pool_status()
    for s in status[:3]:
        print(f"  {s['name']}: role={s['role']}, level={s['level']}")
