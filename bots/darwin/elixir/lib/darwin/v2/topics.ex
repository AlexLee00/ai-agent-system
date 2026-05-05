defmodule Darwin.V2.Topics do
  @moduledoc "다윈 V2 JayBus + PubSub 토픽 상수."

  # 8단계 사이클 토픽 (DISCOVER → HYPOTHESIZE → EVALUATE → PLAN → IMPLEMENT → VERIFY → APPLY → LEARN)
  def paper_discovered,       do: "darwin.paper.discovered"
  def paper_hypothesized,     do: "darwin.paper.hypothesized"
  def paper_evaluated,        do: "darwin.paper.evaluated"
  def paper_rejected,         do: "darwin.paper.rejected"
  def plan_ready,             do: "darwin.plan.ready"
  def implementation_ready,   do: "darwin.implementation.ready"
  def verification_passed,    do: "darwin.verification.passed"
  def verification_failed,    do: "darwin.verification.failed"
  def applied(team),          do: "darwin.applied.#{team}"
  def keyword_evolved,        do: "darwin.keyword.evolved"
  def autonomy_upgraded,      do: "darwin.autonomy.upgraded"
  def autonomy_degraded,      do: "darwin.autonomy.degraded"
  def shadow_result,          do: "darwin.shadow.result"

  # Phase R: MAPE-K 루프 토픽
  def cycle_complete,              do: "darwin.mapek.cycle.complete"
  def cycle_knowledge_complete,    do: "darwin.mapek.cycle.knowledge_complete"
  def mapek_monitor_tick,          do: "darwin.mapek.monitor.tick"
  def mapek_weekly_knowledge,      do: "darwin.mapek.weekly.knowledge"
  def promotion_eligibility,       do: "darwin.mapek.promotion.eligibility"

  # Phase S: Self-Rewarding 토픽
  def self_rewarding_cycle_evaluated, do: "darwin.selfrewarding.cycle.evaluated"
  def self_rewarding_week_complete,   do: "darwin.selfrewarding.week.complete"

  # Phase K: Research Registry 토픽
  def research_registered,  do: "darwin.registry.research.registered"
  def research_promoted,    do: "darwin.registry.research.promoted"
  def research_archived,    do: "darwin.registry.research.archived"
end
