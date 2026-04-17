defmodule TeamJay.Darwin.Topics do
  @moduledoc """
  다윈팀 PubSub 토픽 상수
  """

  # 논문 발견 + 평가
  def paper_discovered,      do: "darwin.paper.discovered"
  def paper_evaluated,       do: "darwin.paper.evaluated"
  def paper_rejected,        do: "darwin.paper.rejected"

  # 구현 + 검증
  def implementation_ready,  do: "darwin.implementation.ready"
  def verification_passed,   do: "darwin.verification.passed"
  def verification_failed,   do: "darwin.verification.failed"

  # 적용
  def applied(team_name),    do: "darwin.applied.#{team_name}"
  def apply_failed(team),    do: "darwin.apply_failed.#{team}"

  # 피드백
  def feedback_received,     do: "darwin.feedback.received"
  def keyword_evolved,       do: "darwin.keyword.evolved"

  # 자율 레벨
  def autonomy_upgraded,     do: "darwin.autonomy.upgraded"
  def autonomy_degraded,     do: "darwin.autonomy.degraded"
end
