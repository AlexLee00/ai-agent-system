defmodule Sigma.V2.Telemetry do
  @moduledoc """
  Sigma V2 텔레메트리 — Jido.Observe 핸들러 + OpenTelemetry 설정.

  상위 문서: docs/SIGMA_REMODELING_PLAN_2026-04-17.md §5.3.8
  Phase 0: skeleton only. Phase 0에서는 파일 exporter만 사용.

  역할:
    - Directive 실행 스팬 (opentelemetry tracer)
    - 예산 소비 메트릭 (카운터/히스토그램)
    - Kill Switch 이벤트 로깅
  """

  def setup do
    # TODO(Phase 1): :telemetry.attach_many/4 로 Jido 이벤트 핸들러 등록
    # TODO(Phase 1): OpenTelemetry span 시작/종료 래퍼
    :ok
  end

  def span(_name, _metadata, fun) do
    # TODO(Phase 1): Tracer.with_span(_name, _metadata, fun)
    fun.()
  end
end
