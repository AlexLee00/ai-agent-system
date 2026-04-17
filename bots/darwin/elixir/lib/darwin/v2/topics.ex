defmodule Darwin.V2.Topics do
  @moduledoc "다윈 V2 JayBus + PubSub 토픽 상수."

  def paper_discovered,      do: "darwin.paper.discovered"
  def paper_evaluated,       do: "darwin.paper.evaluated"
  def paper_rejected,        do: "darwin.paper.rejected"
  def plan_ready,            do: "darwin.plan.ready"
  def implementation_ready,  do: "darwin.implementation.ready"
  def verification_passed,   do: "darwin.verification.passed"
  def verification_failed,   do: "darwin.verification.failed"
  def applied(team),         do: "darwin.applied.#{team}"
  def keyword_evolved,       do: "darwin.keyword.evolved"
  def autonomy_upgraded,     do: "darwin.autonomy.upgraded"
  def autonomy_degraded,     do: "darwin.autonomy.degraded"
  def shadow_result,         do: "darwin.shadow.result"
end
