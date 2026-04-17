defmodule TeamJay.Claude.Topics do
  @moduledoc """
  클로드팀 PubSub 토픽 상수
  """

  # 에러 감지 + 출동
  def error_detected,        do: "claude.error.detected"
  def error_escalated,       do: "claude.error.escalated"

  # 덱스터 테스트
  def test_started(name),    do: "claude.test.started.#{name}"
  def test_passed(name),     do: "claude.test.passed.#{name}"
  def test_failed(name),     do: "claude.test.failed.#{name}"

  # 닥터 패치
  def patch_proposed,        do: "claude.patch.proposed"
  def patch_applied,         do: "claude.patch.applied"
  def patch_rolled_back,     do: "claude.patch.rolled_back"

  # 배포 모니터링
  def deploy_monitoring,     do: "claude.deploy.monitoring"
  def deploy_passed,         do: "claude.deploy.passed"
  def deploy_escalated,      do: "claude.deploy.escalated"

  # 가디언 리뷰
  def review_started,        do: "claude.review.started"
  def review_approved,       do: "claude.review.approved"
  def review_rejected,       do: "claude.review.rejected"

  # SDLC 파이프라인
  def sdlc_plan,             do: "claude.sdlc.plan"
  def sdlc_implement,        do: "claude.sdlc.implement"
  def sdlc_deploy,           do: "claude.sdlc.deploy"
end
